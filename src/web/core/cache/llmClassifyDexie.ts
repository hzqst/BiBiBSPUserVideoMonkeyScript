import Dexie, {Table} from "dexie"
import {getFutureTimestamp} from "../util/defUtil.ts"
import {getLlmCacheTtlGm} from "../../state/localMKData.ts"
import type {LlmDecision, LlmDecisionRecord} from "@/types/llm"

/**
 * LLM判定结果独立建库，避免改动mk-db的版本契约导致已有视频缓存表升级。
 */
class LlmDexie extends Dexie {
    llmDecisions!: Table<LlmDecisionRecord, string>

    constructor() {
        super('mk-llm-db')
        this.version(1).stores({
            llmDecisions: 'bv,blocked,createdAt,expiresMaxAge',
        })
    }
}

const llm_db = new LlmDexie()

/** 写入判定结果并设置过期时间 */
const putDecision = async (bv: string, decision: LlmDecision): Promise<boolean> => {
    try {
        await llm_db.llmDecisions.put({
            bv,
            blocked: decision.blocked,
            reason: decision.reason,
            confidence: decision.confidence,
            createdAt: Date.now(),
            expiresMaxAge: getFutureTimestamp(getLlmCacheTtlGm())
        })
        return true
    } catch (e) {
        console.warn('添加LLM判定结果失败', bv, e)
        return false
    }
}

const findDecisionByBv = async (bv: string): Promise<LlmDecisionRecord | null> => {
    const data = await llm_db.llmDecisions.get(bv)
    return data ? data : null
}

const getDecisions = async (): Promise<LlmDecisionRecord[]> => {
    return await llm_db.llmDecisions.toArray()
}

const getDecisionCount = async (): Promise<number> => {
    return await llm_db.llmDecisions.count()
}

const delDecisionItem = async (bv: string): Promise<boolean> => {
    try {
        await llm_db.llmDecisions.delete(bv)
        return true
    } catch (e) {
        return false
    }
}

const clearDecisionsTable = async (): Promise<boolean> => {
    try {
        await llm_db.llmDecisions.clear()
        return true
    } catch (e) {
        console.log('清除LLM判定结果表失败', e)
        return false
    }
}

/** 清理已过期的判定结果 */
const checkDecisionExpire = async (): Promise<void> => {
    const list = await getDecisions()
    const currentTimestamp = Date.now()
    for (const item of list) {
        const {bv, expiresMaxAge = -1} = item
        if (expiresMaxAge === -1) {
            await llm_db.llmDecisions.update(bv, {expiresMaxAge: getFutureTimestamp(getLlmCacheTtlGm())})
            continue
        }
        if (currentTimestamp > expiresMaxAge) {
            await llm_db.llmDecisions.delete(bv)
            console.log(`删除bv号为${bv}的LLM判定结果过期数据`, item)
        }
    }
}

setTimeout(async () => {
    await checkDecisionExpire()
}, 1000 * 20)

export default {
    putDecision,
    findDecisionByBv,
    getDecisions,
    getDecisionCount,
    delDecisionItem,
    clearDecisionsTable,
    checkDecisionExpire
}
