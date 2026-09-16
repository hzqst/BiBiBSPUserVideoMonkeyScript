import {eventEmitter} from "@/core/EventEmitter.ts";
import {classify} from "@/core/llm/llmClient.ts";
import {fetchCover} from "@/core/llm/coverFetcher.ts";
import llmClassifyDexie from "@/core/cache/llmClassifyDexie.ts";
import defUtil from "@/core/util/defUtil.ts";
import ruleUtil from "@/core/util/ruleUtil.ts";
import localMKData, {
    getLlmDailyLimitGm,
    getLlmRequestIntervalGm,
    isLlmBlacklistUidGm,
    isLlmClassifyEnabledGm,
    isLlmDebugInfoGm,
    isLlmSendCoverGm
} from "@/state/localMKData.ts";
import {returnTempVal} from "@/config/globalValue.ts";
import type {BlockResult} from "@/types/shielding";
import type {VideoData} from "@/types/video";
import type {LlmClassifyInput, LlmDecision} from "@/types/llm";

/** 屏蔽记录中展示的规则类型名 */
const ruleType = 'LLM分类屏蔽'

/** 每日调用计数在GM存储中的键名 */
const dailyUsageKey = 'llm_daily_usage_gm'

interface DailyUsage {
    /** 统计日期，格式YYYY-MM-DD */
    date: string;
    /** 当日已调用次数 */
    count: number;
}

interface QueueTask {
    videoData: VideoData;
    /** 视频封面地址，为空表示不附带封面 */
    coverUrl: string;
    /** 命中后的屏蔽方式，remove或hide */
    method: string;
    /** UP主uid，取自详情接口，0表示无效 */
    uid: number;
}

/** 取本地日期字符串 */
const getToday = (): string => {
    const date = new Date()
    const month = String(date.getMonth() + 1).padStart(2, '0')
    const day = String(date.getDate()).padStart(2, '0')
    return `${date.getFullYear()}-${month}-${day}`
}

/** 读取当日调用计数，跨天则重置 */
const readDailyUsage = (): DailyUsage => {
    const val = GM_getValue(dailyUsageKey, null) as DailyUsage | null
    if (!val || val.date !== getToday() || typeof val.count !== 'number') {
        return {date: getToday(), count: 0}
    }
    return val
}

/**
 * LLM分类队列。
 * 判定结果按BV号缓存，命中缓存即刻屏蔽（无延迟），未命中则入队异步判定并在判定为屏蔽后事后移除元素。
 */
class LlmClassifyQueue {
    /** bv到判定结果的映射，供同步命中 */
    #cache = new Map<string, LlmDecision>()
    /** 已入队或正在判定的bv，避免重复调用 */
    #pending = new Set<string>()
    #queue: QueueTask[] = []
    #processing = false
    #initialized = false
    #cacheLoaded = false
    #dailyLimitWarned = false

    /** 加载持久化的判定结果到内存缓存 */
    async init(): Promise<void> {
        if (this.#initialized) return
        this.#initialized = true
        try {
            const list = await llmClassifyDexie.getDecisions()
            const now = Date.now()
            for (const item of list) {
                if (item.expiresMaxAge !== -1 && now > item.expiresMaxAge) continue
                this.#cache.set(item.bv, {
                    blocked: item.blocked,
                    reason: item.reason,
                    confidence: item.confidence
                })
            }
            console.log(`[station-b-shield] LLM判定缓存已加载，共${this.#cache.size}条`)
        } catch (e) {
            console.warn('[station-b-shield] LLM判定缓存加载失败', e)
        }
        this.#cacheLoaded = true
    }

    /** 同步查询已缓存的判定结果 */
    getCachedDecision(bv: string): LlmDecision | null {
        return this.#cache.get(bv) ?? null
    }

    /** 获取当日调用计数，用于面板展示 */
    getDailyUsage(): DailyUsage {
        return readDailyUsage()
    }

    /** 清空内存与持久化的判定结果 */
    async clearCache(): Promise<boolean> {
        this.#cache.clear()
        return await llmClassifyDexie.clearDecisionsTable()
    }

    /**
     * 判定视频并决定是否入队。
     * 缓存命中直接返回判定结果，未命中则入队异步判定并放行本次渲染。
     * @param uid UP主uid，取自详情接口result.userInfo.uid，不要用页面提取的videoData.uid
     */
    checkAndEnqueue(videoData: VideoData, coverUrl: string, method: string, uid: number): BlockResult {
        const bv = videoData.bv
        // 开关关闭时整体不生效，已缓存的判定结果同样不再参与屏蔽
        if (!bv || !isLlmClassifyEnabledGm()) return returnTempVal
        const cached = this.#cache.get(bv)
        if (cached) {
            if (!cached.blocked) return returnTempVal
            // 缓存命中的屏蔽同样拉黑UP主，否则是否拉黑取决于该视频判定时开关是否已开
            this.#blacklistUid(uid)
            return {state: true, type: ruleType, matching: cached.reason}
        }
        // 缓存尚未加载完成时跳过，避免对已有判定结果的视频重复调用
        if (!this.#cacheLoaded || !this.#canRequest()) return returnTempVal
        if (this.#pending.has(bv)) return returnTempVal
        this.#pending.add(bv)
        this.#queue.push({videoData, coverUrl, method, uid})
        if (!this.#processing) {
            this.#processing = true
            void this.#processNext()
        }
        return returnTempVal
    }

    /** 判断是否具备发起新调用的条件 */
    #canRequest(): boolean {
        if (!localMKData.getLlmBaseUrlGm().trim() || !localMKData.getLlmModelGm().trim()) return false
        const limit = getLlmDailyLimitGm()
        if (limit > 0 && readDailyUsage().count >= limit) {
            if (!this.#dailyLimitWarned) {
                this.#dailyLimitWarned = true
                const msg = `[LLM分类] 今日调用次数已达上限${limit}次，暂停调用`
                console.warn('[station-b-shield] ' + msg)
                eventEmitter.send('打印信息', msg)
            }
            return false
        }
        return true
    }

    /** 串行处理队列，每条之间按配置间隔限速 */
    async #processNext(): Promise<void> {
        const task = this.#queue.shift()
        if (!task) {
            this.#processing = false
            return
        }
        const bv = task.videoData.bv ?? ''
        try {
            await this.#judge(task)
        } catch (e) {
            console.warn('[station-b-shield] LLM分类异常', bv, e)
        } finally {
            if (bv) this.#pending.delete(bv)
            if (this.#queue.length > 0) {
                await defUtil.wait(getLlmRequestIntervalGm() * 1000)
                void this.#processNext()
            } else {
                this.#processing = false
            }
        }
    }

    /** 对单个视频执行一次判定，并在判定为屏蔽时事后移除元素 */
    async #judge(task: QueueTask): Promise<void> {
        const {videoData, coverUrl, method, uid} = task
        const bv = videoData.bv
        if (!bv) return
        const input: LlmClassifyInput = {
            bv,
            title: videoData.title ?? '',
            name: videoData.name ?? ''
        }
        if (isLlmSendCoverGm() && coverUrl) {
            const cover = await fetchCover(coverUrl)
            if (cover) {
                input.coverBase64 = cover.base64
                input.coverMediaType = cover.mediaType
            }
        }
        const usage = readDailyUsage()
        usage.count += 1
        GM_setValue(dailyUsageKey, usage)
        if (isLlmDebugInfoGm()) {
            const msg = `[LLM分类] 调试：基址${localMKData.getLlmBaseUrlGm()}，模型${localMKData.getLlmModelGm()}，附带封面${input.coverBase64 ? '是' : '否'}，标题${input.title}`
            console.log(msg)
            eventEmitter.send('打印信息', msg)
        }
        const res = await classify(input)
        if (!res.state || !res.decision) {
            const msg = `[LLM分类] 判定失败：${res.msg}，标题：${videoData.title}`
            console.warn('[station-b-shield] ' + msg)
            eventEmitter.send('打印信息', msg)
            return
        }
        const decision = res.decision
        this.#cache.set(bv, decision)
        await llmClassifyDexie.putDecision(bv, decision)
        const msg = `[LLM分类] 标题：${videoData.title}，判定：${decision.blocked ? '屏蔽' : '放行'}，原因：${decision.reason}`
        console.log(msg)
        eventEmitter.send('打印信息', msg)
        if (decision.blocked) {
            this.#blacklistUid(uid)
            eventEmitter.send('event-屏蔽视频元素', {
                res: {state: true, type: ruleType, matching: decision.reason},
                method,
                videoData
            })
        }
    }

    /**
     * 判定为屏蔽时把UP主uid写入插件内置黑名单（uid精确屏蔽）。
     * 白名单内的uid与无效uid跳过，避免出现同时命中黑白名单的矛盾状态。
     */
    #blacklistUid(uid: number): void {
        if (!isLlmBlacklistUidGm() || !uid || uid <= 0) return
        if (ruleUtil.findRuleItemValue('precise_uid_white', uid)) return
        const {status} = ruleUtil.addRulePreciseUid(uid, false)
        if (!status) return
        eventEmitter.send('刷新规则信息', false)
        const msg = `[LLM分类] 已将UP主uid=${uid}加入内置黑名单(uid精确屏蔽)`
        console.log(msg)
        eventEmitter.send('打印信息', msg)
    }
}

export const llmClassifyQueue = new LlmClassifyQueue()

void llmClassifyQueue.init()

export default llmClassifyQueue
