/** 支持的 LLM 接口协议类型 */
export type LlmProtocol = 'openai-compatible' | 'anthropic-messages' | 'openai-responses';

/** 推理强度，关闭时不向接口发送任何推理相关参数 */
export type LlmReasoningEffort = '关闭' | 'low' | 'medium' | 'high';

/** 结构化输出模式，自动表示按能力从强到弱逐级降级重试 */
export type LlmJsonMode = '自动' | 'json_schema' | 'json_object' | '仅提示词';

/** 单次请求实际采用的结构化输出策略 */
export type LlmJsonStrategy = 'json_schema' | 'json_object' | 'prompt';

/** 送入 LLM 待分类的视频信息 */
export interface LlmClassifyInput {
    /** 视频BV号，用于缓存判定结果 */
    bv: string;
    /** 视频标题 */
    title: string;
    /** UP主名称 */
    name: string;
    /** 封面图base64数据，未附带封面时为空 */
    coverBase64?: string;
    /** 封面图媒体类型，如 image/webp */
    coverMediaType?: string;
}

/** LLM 给出的屏蔽判定结果 */
export interface LlmDecision {
    /** 是否需要屏蔽 */
    blocked: boolean;
    /** 屏蔽原因，直接作为屏蔽记录中的匹配内容展示 */
    reason: string;
    /** 模型自评置信度，取值0~1，模型未返回时为undefined */
    confidence?: number;
}

/** LLM 调用结果包装 */
export interface LlmClassifyResult {
    /** 调用与解析是否成功 */
    state: boolean;
    /** 结果说明，失败时为错误原因 */
    msg: string;
    /** 成功时的判定结果 */
    decision?: LlmDecision;
}

/** 一次 LLM 请求的完整配置 */
export interface LlmRequestConfig {
    protocol: LlmProtocol;
    /** 接口基址，不含具体路径，如 https://api.openai.com 或 https://api.openai.com/v1 */
    baseUrl: string;
    apiKey: string;
    model: string;
    systemPrompt: string;
    /** 用户提示词模板，支持 {title} {name} {bv} 占位符 */
    userPrompt: string;
    reasoningEffort: LlmReasoningEffort;
    jsonMode: LlmJsonMode;
    /** 输出token上限 */
    maxOutputTokens: number;
    /** 单次请求超时时间（秒） */
    timeout: number;
    /** 每分钟最多发出的请求数，0表示不限制 */
    rpmLimit: number;
}

/** 持久化到 IndexedDB 的屏蔽判定记录 */
export interface LlmDecisionRecord {
    /** 视频BV号 */
    bv: string;
    /** 是否屏蔽 */
    blocked: boolean;
    /** 屏蔽原因 */
    reason: string;
    /** 置信度 */
    confidence?: number;
    /** 判定时间戳 */
    createdAt: number;
    /** 过期时间戳 */
    expiresMaxAge: number;
}
