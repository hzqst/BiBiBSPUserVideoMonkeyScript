import {defTmRequest} from "@/core/http/TmRequest.ts";
import {
    getLlmApiKeyGm,
    getLlmBaseUrlGm,
    getLlmJsonModeGm,
    getLlmMaxOutputTokensGm,
    getLlmModelGm,
    getLlmProtocolGm,
    getLlmReasoningEffortGm,
    getLlmSystemPromptGm,
    getLlmTimeoutGm,
    getLlmUserPromptGm
} from "@/state/localMKData.ts";
import type {
    LlmClassifyInput,
    LlmClassifyResult,
    LlmDecision,
    LlmJsonMode,
    LlmJsonStrategy,
    LlmProtocol,
    LlmReasoningEffort,
    LlmRequestConfig
} from "@/types/llm";

/** 要求模型返回的判定结构，用于各协议的结构化输出约束 */
const decisionSchema = {
    type: 'object',
    properties: {
        blocked: {type: 'boolean', description: '是否需要屏蔽该视频'},
        reason: {type: 'string', description: '一句简短的中文判定依据'},
        confidence: {type: 'number', description: '判定置信度，取值0到1'}
    },
    required: ['blocked', 'reason'],
    additionalProperties: false
}

/** 关闭结构化输出能力时追加在用户提示词末尾的JSON格式说明 */
const promptJsonHint = `

只返回一个JSON对象，不要包含markdown代码块标记和任何其他说明文字，结构如下：
{"blocked": true或false, "reason": "简短中文原因", "confidence": 0到1之间的数字}`

/** 仅使用json_object模式时追加的简短说明，部分接口要求提示词中出现json字样 */
const objectJsonHint = '\n\n请以JSON对象返回判定结果。'

interface LlmBuiltRequest {
    url: string;
    headers: Record<string, string>;
    body: string;
}

/** 推理工作量对应的思考token预算，用于anthropic的thinking参数 */
const thinkingBudgetMap: Record<Exclude<LlmReasoningEffort, '关闭'>, number> = {
    low: 1024,
    medium: 4096,
    high: 8192
}

/** 去掉基址末尾斜杠 */
const normalizeBaseUrl = (baseUrl: string): string => {
    return baseUrl.trim().replace(/\/+$/, '')
}

/** 按协议拼接具体端点，基址已带/v1之类的版本段时不重复拼接 */
const buildEndpoint = (baseUrl: string, path: string): string => {
    const base = normalizeBaseUrl(baseUrl)
    return /\/v\d+$/.test(base) ? `${base}${path}` : `${base}/v1${path}`
}

/** 渲染用户提示词模板，替换标题、UP主名称与BV号占位符 */
const renderUserPrompt = (template: string, input: LlmClassifyInput): string => {
    return template
        .replace(/\{title\}/g, input.title)
        .replace(/\{name\}/g, input.name)
        .replace(/\{bv\}/g, input.bv)
}

/** 是否附带封面数据 */
const hasCover = (input: LlmClassifyInput): boolean => {
    return Boolean(input.coverBase64)
}

/** 拼接封面的data url */
const buildCoverDataUrl = (input: LlmClassifyInput): string => {
    return `data:${input.coverMediaType || 'image/jpeg'};base64,${input.coverBase64}`
}

/** 是否需要给模型附加JSON格式说明 */
const appendJsonHint = (userText: string, strategy: LlmJsonStrategy): string => {
    if (strategy === 'prompt') return userText + promptJsonHint
    if (strategy === 'json_object') return userText + objectJsonHint
    return userText
}

/**
 * 解析本次请求要依次尝试的结构化输出策略。
 * 自动模式下按能力从强到弱降级；anthropic的两种结构化模式最终都落到强制工具调用，因此无需重复尝试。
 */
const resolveStrategies = (jsonMode: LlmJsonMode, protocol: LlmProtocol, thinkingEnabled: boolean): LlmJsonStrategy[] => {
    if (thinkingEnabled) return ['prompt']
    if (jsonMode === 'json_schema') return ['json_schema']
    if (jsonMode === 'json_object') return ['json_object']
    if (jsonMode === '仅提示词') return ['prompt']
    return protocol === 'anthropic-messages' ? ['json_schema', 'prompt'] : ['json_schema', 'json_object', 'prompt']
}

/** 构造openai兼容的chat/completions请求 */
const buildChatCompletionsRequest = (config: LlmRequestConfig, userText: string, input: LlmClassifyInput, strategy: LlmJsonStrategy): LlmBuiltRequest => {
    const userContent = hasCover(input)
        ? [
            {type: 'text', text: userText},
            {type: 'image_url', image_url: {url: buildCoverDataUrl(input)}}
        ]
        : userText
    const body: any = {
        model: config.model,
        messages: [
            {role: 'system', content: config.systemPrompt},
            {role: 'user', content: userContent}
        ]
    }
    if (config.reasoningEffort === '关闭') {
        body.max_tokens = config.maxOutputTokens
    } else {
        // 推理模型的输出上限需改用max_completion_tokens，且推理token计入该预算
        body.reasoning_effort = config.reasoningEffort
        body.max_completion_tokens = config.maxOutputTokens
    }
    if (strategy === 'json_schema') {
        body.response_format = {
            type: 'json_schema',
            json_schema: {name: 'shielding_decision', strict: true, schema: decisionSchema}
        }
    } else if (strategy === 'json_object') {
        body.response_format = {type: 'json_object'}
    }
    return {
        url: buildEndpoint(config.baseUrl, '/chat/completions'),
        headers: {
            'Content-Type': 'application/json',
            'Authorization': `Bearer ${config.apiKey}`
        },
        body: JSON.stringify(body)
    }
}

/** 构造anthropic messages请求 */
const buildAnthropicRequest = (config: LlmRequestConfig, userText: string, input: LlmClassifyInput, strategy: LlmJsonStrategy): LlmBuiltRequest => {
    const content: any[] = [{type: 'text', text: userText}]
    if (hasCover(input)) {
        content.push({
            type: 'image',
            source: {
                type: 'base64',
                media_type: input.coverMediaType || 'image/jpeg',
                data: input.coverBase64
            }
        })
    }
    const body: any = {
        model: config.model,
        system: config.systemPrompt,
        messages: [{role: 'user', content}],
        max_tokens: config.maxOutputTokens
    }
    const thinkingEnabled = config.reasoningEffort !== '关闭'
    if (thinkingEnabled) {
        const budget = thinkingBudgetMap[config.reasoningEffort as Exclude<LlmReasoningEffort, '关闭'>]
        body.thinking = {type: 'enabled', budget_tokens: budget}
        // budget_tokens必须小于max_tokens，且思考token不占用输出上限，故两者相加
        body.max_tokens = budget + config.maxOutputTokens
    } else if (strategy !== 'prompt') {
        // 开启thinking时无法强制工具调用，此分支仅在未开启thinking时可用
        body.tools = [{
            name: 'report_shielding_decision',
            description: '上报该视频是否需要屏蔽的判定结果',
            input_schema: decisionSchema
        }]
        body.tool_choice = {type: 'tool', name: 'report_shielding_decision'}
    }
    return {
        url: buildEndpoint(config.baseUrl, '/messages'),
        headers: {
            'Content-Type': 'application/json',
            'x-api-key': config.apiKey,
            'anthropic-version': '2023-06-01',
            // 供浏览器环境直连anthropic接口时使用的额外声明
            'anthropic-dangerous-direct-browser-access': 'true'
        },
        body: JSON.stringify(body)
    }
}

/** 构造openai responses请求 */
const buildResponsesRequest = (config: LlmRequestConfig, userText: string, input: LlmClassifyInput, strategy: LlmJsonStrategy): LlmBuiltRequest => {
    const content: any[] = [{type: 'input_text', text: userText}]
    if (hasCover(input)) {
        content.push({type: 'input_image', image_url: buildCoverDataUrl(input)})
    }
    const body: any = {
        model: config.model,
        instructions: config.systemPrompt,
        input: [{role: 'user', content}],
        max_output_tokens: config.maxOutputTokens
    }
    if (config.reasoningEffort !== '关闭') {
        body.reasoning = {effort: config.reasoningEffort}
    }
    if (strategy === 'json_schema') {
        body.text = {
            format: {type: 'json_schema', name: 'shielding_decision', schema: decisionSchema, strict: true}
        }
    } else if (strategy === 'json_object') {
        body.text = {format: {type: 'json_object'}}
    }
    return {
        url: buildEndpoint(config.baseUrl, '/responses'),
        headers: {
            'Content-Type': 'application/json',
            'Authorization': `Bearer ${config.apiKey}`
        },
        body: JSON.stringify(body)
    }
}

/** 按协议构造一次请求，导出供测试连接与调试使用 */
export const buildRequest = (config: LlmRequestConfig, input: LlmClassifyInput, strategy: LlmJsonStrategy): LlmBuiltRequest => {
    // anthropic开启thinking后无法强制工具调用，此处兜底退化为提示词约束，保证单独调用时也不会丢失输出格式要求
    const effectiveStrategy: LlmJsonStrategy = config.protocol === 'anthropic-messages' &&
    config.reasoningEffort !== '关闭' && strategy !== 'prompt'
        ? 'prompt'
        : strategy
    const userText = appendJsonHint(renderUserPrompt(config.userPrompt, input), effectiveStrategy)
    if (config.protocol === 'anthropic-messages') {
        return buildAnthropicRequest(config, userText, input, effectiveStrategy)
    }
    if (config.protocol === 'openai-responses') {
        return buildResponsesRequest(config, userText, input, effectiveStrategy)
    }
    return buildChatCompletionsRequest(config, userText, input, effectiveStrategy)
}

/** 从模型输出文本中提取JSON对象，依次尝试直接解析、代码块解析与首尾括号截取 */
export const extractJson = (text: string): any | null => {
    if (!text) return null
    const trimmed = text.trim()
    try {
        return JSON.parse(trimmed)
    } catch (e) {
        // 继续尝试后续更宽松的解析方式
    }
    const fenced = trimmed.match(/```(?:json)?\s*([\s\S]*?)```/)
    if (fenced && fenced[1]) {
        try {
            return JSON.parse(fenced[1].trim())
        } catch (e) {
            // 继续尝试首尾括号截取
        }
    }
    const start = trimmed.indexOf('{')
    const end = trimmed.lastIndexOf('}')
    if (start >= 0 && end > start) {
        try {
            return JSON.parse(trimmed.slice(start, end + 1))
        } catch (e) {
            return null
        }
    }
    return null
}

/** 把模型返回的布尔语义字段转换为布尔值，无法识别时返回null */
const toBoolean = (value: unknown): boolean | null => {
    if (typeof value === 'boolean') return value
    if (typeof value === 'string') {
        const val = value.trim().toLowerCase()
        if (['true', '1', 'yes', '是', '屏蔽'].includes(val)) return true
        if (['false', '0', 'no', '否', '不屏蔽'].includes(val)) return false
    }
    return null
}

/** 把模型返回内容归一化为判定结果，缺少blocked字段时视为解析失败 */
export const normalizeDecision = (value: unknown): LlmDecision | null => {
    const target = typeof value === 'string' ? extractJson(value) : value
    if (!target || typeof target !== 'object') return null
    const {blocked, reason, confidence} = target as any
    const blockedVal = toBoolean(blocked)
    if (blockedVal === null) return null
    const decision: LlmDecision = {
        blocked: blockedVal,
        reason: typeof reason === 'string' && reason.trim() ? reason.trim() : '模型未给出原因'
    }
    const confidenceVal = typeof confidence === 'number' ? confidence : Number(confidence)
    if (Number.isFinite(confidenceVal)) {
        decision.confidence = Math.min(Math.max(confidenceVal, 0), 1)
    }
    return decision
}

/** 解析openai兼容chat/completions响应 */
const parseChatCompletions = (data: any): LlmDecision | null => {
    const content = data?.choices?.[0]?.message?.content
    if (typeof content === 'string') return normalizeDecision(content)
    if (Array.isArray(content)) {
        const text = content
            .filter(item => item?.type === 'text' && typeof item.text === 'string')
            .map(item => item.text)
            .join('')
        return normalizeDecision(text)
    }
    return null
}

/** 解析anthropic messages响应，优先取强制工具调用的入参 */
const parseAnthropic = (data: any): LlmDecision | null => {
    const content = data?.content
    if (!Array.isArray(content)) return null
    const toolUse = content.find(item => item?.type === 'tool_use' && item.input)
    if (toolUse) return normalizeDecision(toolUse.input)
    const text = content
        .filter(item => item?.type === 'text' && typeof item.text === 'string')
        .map(item => item.text)
        .join('')
    return normalizeDecision(text)
}

/** 解析openai responses响应 */
const parseResponses = (data: any): LlmDecision | null => {
    if (typeof data?.output_text === 'string') return normalizeDecision(data.output_text)
    const output = data?.output
    if (!Array.isArray(output)) return null
    const texts: string[] = []
    for (const item of output) {
        if (item?.type !== 'message' || !Array.isArray(item.content)) continue
        for (const part of item.content) {
            if (part?.type === 'output_text' && typeof part.text === 'string') texts.push(part.text)
        }
    }
    if (texts.length === 0) return null
    return normalizeDecision(texts.join(''))
}

/** 按协议解析响应，导出供测试连接与调试使用 */
export const parseDecision = (protocol: LlmProtocol, data: any): LlmDecision | null => {
    if (protocol === 'anthropic-messages') return parseAnthropic(data)
    if (protocol === 'openai-responses') return parseResponses(data)
    return parseChatCompletions(data)
}

/** 从接口错误响应中提取可读的错误信息 */
const extractErrorMessage = (error: any): string => {
    const {message, status, data} = error ?? {}
    const parsed = typeof data === 'string' ? extractJson(data) : null
    const detail = parsed?.error?.message ?? parsed?.message ?? parsed?.error
    const parts = [message]
    if (status !== undefined) parts.push(`状态码${status}`)
    if (detail) parts.push(typeof detail === 'string' ? detail : JSON.stringify(detail))
    return parts.filter(Boolean).join('，') || '请求失败'
}

/** 是否属于参数不被接口接受的错误，这类错误才值得降级重试 */
const isParameterRejected = (error: any): boolean => {
    const status = error?.status
    return typeof status === 'number' && [400, 404, 415, 422].includes(status)
}

/** 从本地存储读取LLM请求配置 */
export const readConfigFromStorage = (): LlmRequestConfig => {
    return {
        protocol: getLlmProtocolGm(),
        baseUrl: getLlmBaseUrlGm(),
        apiKey: getLlmApiKeyGm(),
        model: getLlmModelGm(),
        systemPrompt: getLlmSystemPromptGm(),
        userPrompt: getLlmUserPromptGm(),
        reasoningEffort: getLlmReasoningEffortGm(),
        jsonMode: getLlmJsonModeGm(),
        maxOutputTokens: getLlmMaxOutputTokensGm(),
        timeout: getLlmTimeoutGm()
    }
}

/**
 * 调用LLM对视频进行分类。
 * 结构化输出逐级降级：仅在接口以参数类错误拒绝，或返回内容无法解析为判定结果时才尝试下一级策略。
 */
export const classify = async (input: LlmClassifyInput, config: LlmRequestConfig = readConfigFromStorage()): Promise<LlmClassifyResult> => {
    if (!config.baseUrl.trim()) return {state: false, msg: '接口基址为空'}
    if (!config.model.trim()) return {state: false, msg: '模型名为空'}
    const thinkingEnabled = config.protocol === 'anthropic-messages' && config.reasoningEffort !== '关闭'
    const strategies = resolveStrategies(config.jsonMode, config.protocol, thinkingEnabled)
    let lastMsg = '请求失败'
    for (let i = 0; i < strategies.length; i++) {
        const strategy = strategies[i]
        const request = buildRequest(config, input, strategy)
        let responseData: any
        try {
            const response = await defTmRequest.request({
                url: request.url,
                method: 'POST',
                headers: request.headers,
                data: request.body,
                responseType: 'json',
                timeout: config.timeout * 1000
            })
            responseData = response.data
        } catch (error: any) {
            lastMsg = extractErrorMessage(error)
            if (isParameterRejected(error) && i < strategies.length - 1) {
                console.warn(`[station-b-shield] LLM结构化输出模式${strategy}被接口拒绝，降级重试`, error)
                continue
            }
            if (config.jsonMode === '自动' && isParameterRejected(error)) {
                lastMsg = `${lastMsg}（结构化输出参数不被接口支持，可尝试将结构化输出模式改为仅提示词）`
            }
            return {state: false, msg: lastMsg}
        }
        const decision = parseDecision(config.protocol, responseData)
        if (decision) return {state: true, msg: '判定成功', decision}
        lastMsg = '响应内容无法解析为判定结果'
        if (i < strategies.length - 1) {
            console.warn(`[station-b-shield] LLM结构化输出模式${strategy}未返回可解析结果，降级重试`)
            continue
        }
    }
    return {state: false, msg: lastMsg}
}

export default {classify, buildRequest, parseDecision, normalizeDecision, extractJson, readConfigFromStorage}
