<script lang="ts">
import {defineComponent} from 'vue';
import localMKData from "@/state/localMKData.ts";
import llmClassifyQueue from "@/domain/llmClassifyQueue.ts";
import {classify} from "@/core/llm/llmClient.ts";
import defUtil from "@/core/util/defUtil.ts";
import type {LlmRequestConfig} from "@/types/llm";

/**
 * 表单配置写入存储的防抖包装。
 * 表单的深层监听会在输入框每次按键时触发，而单次写入涉及十余个配置项，
 * 需要合并连续输入，避免长文本输入时高频访问脚本存储导致卡顿。
 */
const persistDebounced = defUtil.debounce((persist: () => void): void => persist(), 300)

/**
 * LLM多模态分类屏蔽设置页面
 */
export default defineComponent({
  data() {
    return {
      form: {
        enabled: localMKData.isLlmClassifyEnabledGm(),
        protocol: localMKData.getLlmProtocolGm(),
        baseUrl: localMKData.getLlmBaseUrlGm(),
        apiKey: localMKData.getLlmApiKeyGm(),
        model: localMKData.getLlmModelGm(),
        reasoningEffort: localMKData.getLlmReasoningEffortGm(),
        jsonMode: localMKData.getLlmJsonModeGm(),
        systemPrompt: localMKData.getLlmSystemPromptGm(),
        userPrompt: localMKData.getLlmUserPromptGm(),
        timeout: localMKData.getLlmTimeoutGm(),
        titleKeywords: localMKData.getLlmTitleKeywordsGm().join('\n'),
        requestInterval: localMKData.getLlmRequestIntervalGm(),
        dailyLimit: localMKData.getLlmDailyLimitGm(),
        rpmLimit: localMKData.getLlmRpmLimitGm(),
        maxOutputTokens: localMKData.getLlmMaxOutputTokensGm(),
        cacheTtl: localMKData.getLlmCacheTtlGm(),
        sendCover: localMKData.isLlmSendCoverGm(),
        debugInfo: localMKData.isLlmDebugInfoGm(),
        blacklistUid: localMKData.isLlmBlacklistUidGm()
      },
      testing: false,
      testResult: '',
      dailyUsage: llmClassifyQueue.getDailyUsage()
    }
  },
  methods: {
    /** 把表单配置写入GM存储，各项改动停止输入300毫秒后生效 */
    persistAll() {
      const form = this.form
      GM_setValue('llm_classify_enabled_gm', form.enabled)
      GM_setValue('llm_protocol_gm', form.protocol)
      GM_setValue('llm_base_url_gm', form.baseUrl)
      GM_setValue('llm_api_key_gm', form.apiKey)
      GM_setValue('llm_model_gm', form.model)
      GM_setValue('llm_reasoning_effort_gm', form.reasoningEffort)
      GM_setValue('llm_json_mode_gm', form.jsonMode)
      GM_setValue('llm_system_prompt_gm', form.systemPrompt)
      GM_setValue('llm_user_prompt_gm', form.userPrompt)
      GM_setValue('llm_timeout_gm', form.timeout)
      GM_setValue('llm_title_keywords_gm', form.titleKeywords)
      GM_setValue('llm_request_interval_gm', form.requestInterval)
      GM_setValue('llm_daily_limit_gm', form.dailyLimit)
      GM_setValue('llm_rpm_limit_gm', form.rpmLimit)
      GM_setValue('llm_max_output_tokens_gm', form.maxOutputTokens)
      GM_setValue('llm_cache_ttl_gm', form.cacheTtl)
      GM_setValue('llm_send_cover_gm', form.sendCover)
      GM_setValue('llm_debug_info_gm', form.debugInfo)
      GM_setValue('llm_blacklist_uid_gm', form.blacklistUid)
    },
    /** 按当前表单值组装请求配置，测试连接使用未保存的输入 */
    buildConfig(): LlmRequestConfig {
      const form = this.form
      return {
        protocol: form.protocol as any,
        baseUrl: form.baseUrl,
        apiKey: form.apiKey,
        model: form.model,
        systemPrompt: form.systemPrompt,
        userPrompt: form.userPrompt,
        reasoningEffort: form.reasoningEffort as any,
        jsonMode: form.jsonMode as any,
        maxOutputTokens: form.maxOutputTokens,
        timeout: form.timeout,
        rpmLimit: form.rpmLimit
      }
    },
    /** 使用当前表单配置发送一条测试数据，验证接口连通性与返回解析 */
    async testConnectionBut() {
      this.testing = true
      this.testResult = '正在调用...'
      try {
        const res = await classify({
          bv: 'BV1ShieldConnectionTest',
          title: '这是一条用于验证接口连通性的测试视频标题',
          name: '测试UP主'
        }, this.buildConfig())
        this.testResult = res.state && res.decision
          ? `调用成功，判定：${res.decision.blocked ? '屏蔽' : '放行'}，原因：${res.decision.reason}`
          : `调用失败：${res.msg}`
      } catch (e) {
        this.testResult = `调用异常：${e}`
      } finally {
        this.testing = false
      }
    },
    /** 清空已缓存的判定结果，清空后所有视频需要重新判定 */
    async clearCacheBut() {
      await this.$confirm('是否清空已缓存的LLM判定结果？清空后所有视频都需要重新调用接口').then(async () => {
        const state = await llmClassifyQueue.clearCache()
        this.$alert(state ? '已清空LLM判定缓存' : '清空失败，请查看控制台日志')
      }).catch(() => {
        // 用户取消
      })
    },
    refreshDailyUsage() {
      this.dailyUsage = llmClassifyQueue.getDailyUsage()
    }
  },
  watch: {
    form: {
      deep: true,
      handler() {
        persistDebounced(() => this.persistAll())
      }
    }
  }
})
</script>

<template>
  <div>
    <el-card shadow="never">
      <template #header>
        <span>LLM多模态分类屏蔽</span>
      </template>
      <el-alert type="warning" :closable="false" show-icon
                title="隐私与费用提示">
        <div>开启后，视频标题、UP主名称与视频封面会被发送到你填写的第三方接口，请确认你接受该数据外发行为。</div>
        <div>判定结果按BV号缓存，同一个视频只会调用一次；调用仅对已通过全部本地规则的视频发起。</div>
        <div>可通过「标题关键词初筛」把送检范围缩小到标题命中关键词的视频，未命中时不会发送任何数据。</div>
        <div>本页配置不会被规则导出功能带走，但API Key以明文保存在脚本存储中，请勿分享脚本存储备份。</div>
      </el-alert>
      <div class="el-horizontal-center">
        <el-switch v-model="form.enabled" active-text="启用LLM分类屏蔽"></el-switch>
      </div>
    </el-card>

    <el-card shadow="never">
      <template #header>
        <span>接口配置</span>
      </template>
      <el-form label-width="130px" size="small">
        <el-form-item label="协议类型">
          <el-select v-model="form.protocol" style="width: 100%">
            <el-option label="OpenAI兼容（chat/completions）" value="openai-compatible"></el-option>
            <el-option label="Anthropic Messages（messages）" value="anthropic-messages"></el-option>
            <el-option label="OpenAI Responses（responses）" value="openai-responses"></el-option>
          </el-select>
        </el-form-item>
        <el-form-item label="接口基址">
          <el-input v-model.trim="form.baseUrl"
                    placeholder="只填基址，不带具体路径。如 https://api.openai.com 或 https://api.openai.com/v1">
          </el-input>
        </el-form-item>
        <el-form-item label="API Key">
          <el-input v-model.trim="form.apiKey" show-password placeholder="接口密钥"></el-input>
        </el-form-item>
        <el-form-item label="模型名">
          <el-input v-model.trim="form.model" placeholder="如 gpt-4o-mini、claude-sonnet-5"></el-input>
        </el-form-item>
        <el-form-item label="推理强度">
          <el-select v-model="form.reasoningEffort" style="width: 100%">
            <el-option label="关闭" value="关闭"></el-option>
            <el-option label="low" value="low"></el-option>
            <el-option label="medium" value="medium"></el-option>
            <el-option label="high" value="high"></el-option>
          </el-select>
          <div class="mk-form-tip">该名称仅适用于OpenAI系协议；Anthropic会映射为思考token预算，且开启后无法强制JSON输出，解析可靠性下降。
            本功能判定逻辑简单，开启推理通常只增加费用与延迟。
          </div>
        </el-form-item>
        <el-form-item label="结构化输出模式">
          <el-select v-model="form.jsonMode" style="width: 100%">
            <el-option label="自动降级（推荐）" value="自动"></el-option>
            <el-option label="强制json_schema" value="json_schema"></el-option>
            <el-option label="强制json_object" value="json_object"></el-option>
            <el-option label="仅提示词约束" value="仅提示词"></el-option>
          </el-select>
          <div class="mk-form-tip">自动降级会在接口拒绝结构化参数或返回内容无法解析时，逐级降低约束强度重试。
            部分中转接口不支持json_schema，此时可手动选择仅提示词约束。
          </div>
        </el-form-item>
        <el-form-item label="输出token上限">
          <el-input-number v-model="form.maxOutputTokens" :min="64" :max="32768" :step="64"></el-input-number>
          <div class="mk-form-tip">开启推理时，推理token也计入该上限，需要适当调大。</div>
        </el-form-item>
        <el-form-item label="单次超时(秒)">
          <el-input-number v-model="form.timeout" :min="5" :max="120" :step="5"></el-input-number>
        </el-form-item>
        <el-form-item label="测试连接">
          <el-button :loading="testing" @click="testConnectionBut">发送测试请求</el-button>
          <div class="mk-form-tip">测试请求不附带封面图，直接使用上方当前填写的配置。</div>
        </el-form-item>
        <el-form-item v-if="testResult" label="测试结果">
          <el-tag type="info">{{ testResult }}</el-tag>
        </el-form-item>
      </el-form>
    </el-card>

    <el-card shadow="never">
      <template #header>
        <span>提示词</span>
      </template>
      <el-form label-width="130px" size="small">
        <el-form-item label="系统提示词">
          <el-input v-model="form.systemPrompt" type="textarea" :rows="8"
                    placeholder="在此填写你的分类判定要求"></el-input>
        </el-form-item>
        <el-form-item label="用户提示词">
          <el-input v-model="form.userPrompt" type="textarea" :rows="3"
                    placeholder="支持 {title} {name} {bv} 占位符"></el-input>
          <div class="mk-form-tip">可用占位符：{title} 视频标题、{name} UP主名称、{bv} 视频BV号；封面图作为图片一并发送。</div>
        </el-form-item>
      </el-form>
    </el-card>

    <el-card shadow="never">
      <template #header>
        <span>调用控制与缓存</span>
      </template>
      <el-form label-width="130px" size="small">
        <el-form-item label="标题关键词初筛">
          <el-input v-model="form.titleKeywords" type="textarea" :rows="4"
                    placeholder="每行一个关键词，留空表示全部送检"></el-input>
          <div class="mk-form-tip">只有视频标题包含其中任意一个关键词时才送检，用于在不改判定标准的前提下缩小外发范围与费用。
            留空表示不筛选、全部送检；已命中判定缓存的视频不受此限制。
            匹配不区分大小写，关键词按行解析，行内首尾空白会被忽略。
          </div>
        </el-form-item>
        <el-form-item label="调用间隔(秒)">
          <el-input-number v-model="form.requestInterval" :min="0" :max="60" :step="1"></el-input-number>
        </el-form-item>
        <el-form-item label="每日调用上限">
          <el-input-number v-model="form.dailyLimit" :min="0" :max="100000" :step="10"></el-input-number>
          <div class="mk-form-tip">0表示不限制。达到上限后当天不再发起调用。</div>
        </el-form-item>
        <el-form-item label="每分钟上限(RPM)">
          <el-input-number v-model="form.rpmLimit" :min="0" :max="600" :step="1"></el-input-number>
          <div class="mk-form-tip">0表示不限制。按滑动窗口统计一分钟内真实发出的请求数，超出配额时会等待到窗口释放。
            结构化输出降级重试的每一次请求都会单独占用一个配额，因此该值需要按接口的实际限额留出余量。
            本页的「发送测试请求」同样受该限制。
          </div>
        </el-form-item>
        <el-form-item label="判定缓存天数">
          <el-input-number v-model="form.cacheTtl" :min="1" :max="365" :step="1"></el-input-number>
        </el-form-item>
        <el-form-item label="附带视频封面">
          <el-switch v-model="form.sendCover" active-text="送检时附带封面图"></el-switch>
          <div class="mk-form-tip">关闭后退化为纯文本分类。封面会先压缩再下载，下载失败时自动退化为纯文本。</div>
        </el-form-item>
        <el-form-item label="调试信息">
          <el-switch v-model="form.debugInfo" active-text="输出调用调试信息"></el-switch>
        </el-form-item>
        <el-form-item label="自动拉黑UP主">
          <el-switch v-model="form.blacklistUid" active-text="判定为屏蔽时把UP主uid加入内置黑名单"></el-switch>
          <div class="mk-form-tip">开启后，LLM判定某视频需要屏蔽时，该视频UP主的uid会写入规则面板的「用户uid(精确匹配)」，
            此后该UP主的所有视频都会被本地规则直接屏蔽，不再调用接口。
            已缓存的判定结果同样生效，因此刚开启时可能一次性补写较多历史视频的UP主。
            已存在于「用户uid白名单」中的uid会跳过，不会写入。该操作会累积修改你的规则库，并随规则导出带走，可在规则面板手动移除。
          </div>
        </el-form-item>
        <el-form-item label="当日已调用">
          <el-tag>{{ dailyUsage.count }} 次</el-tag>
          <el-button @click="refreshDailyUsage">刷新</el-button>
          <el-button @click="clearCacheBut">清空判定缓存</el-button>
        </el-form-item>
      </el-form>
    </el-card>
  </div>
</template>

<style scoped>
.mk-form-tip {
  color: #909399;
  font-size: 12px;
  line-height: 18px;
}
</style>
