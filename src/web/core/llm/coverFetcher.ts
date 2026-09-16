import {defTmRequest} from "@/core/http/TmRequest.ts";

/** 追加在封面地址后的压缩参数，控制送入模型的图片体积 */
const coverSizeParam = '@480w_300h_1c.webp'

/** 无法从响应头或地址判断图片类型时的兜底类型 */
const fallbackMediaType = 'image/jpeg'

/** 封面下载超时时间（毫秒） */
const coverTimeoutMs = 10000

/** 封面体积上限，超过则认为压缩参数未生效，放弃附带封面 */
const maxCoverBytes = 2 * 1024 * 1024

/** B站图床的防盗链校验依赖来源页，下载封面时需显式携带 */
const coverDownloadHeaders = {
    'Referer': 'https://www.bilibili.com/'
}

interface CoverResult {
    /** 封面图片的base64数据，不含data url前缀 */
    base64: string;
    /** 封面图片媒体类型 */
    mediaType: string;
}

/** 补全封面地址协议并追加压缩参数，已带处理参数时保持原样 */
export const normalizeCoverUrl = (coverUrl: string): string => {
    const trimmed = coverUrl.trim()
    if (!trimmed) return ''
    const withProtocol = trimmed.replace(/^http:\/\//, 'https://')
    return withProtocol.includes('@') ? withProtocol : `${withProtocol}${coverSizeParam}`
}

/** 从响应头与地址推断图片媒体类型 */
const pickMediaType = (coverUrl: string, contentType: string): string => {
    const type = (contentType || '').split(';')[0].trim().toLowerCase()
    if (type.startsWith('image/')) return type
    const suffix = coverUrl.split('@').pop()?.split('.').pop()?.toLowerCase()
    if (suffix === 'webp') return 'image/webp'
    if (suffix === 'png') return 'image/png'
    if (suffix === 'jpg' || suffix === 'jpeg') return 'image/jpeg'
    return fallbackMediaType
}

/** 分块转换arraybuffer为base64，避免一次性展开大数组导致调用栈溢出 */
const arrayBufferToBase64 = (buffer: ArrayBuffer): string => {
    const bytes = new Uint8Array(buffer)
    const chunkSize = 0x8000
    let binary = ''
    for (let i = 0; i < bytes.length; i += chunkSize) {
        binary += String.fromCharCode.apply(null, Array.from(bytes.subarray(i, i + chunkSize)) as any)
    }
    return btoa(binary)
}

/**
 * 下载视频封面并转为base64。
 * 失败、超时或体积超限时返回null，由调用方退化为纯文本分类。
 */
export const fetchCover = async (coverUrl: string): Promise<CoverResult | null> => {
    const url = normalizeCoverUrl(coverUrl)
    if (!url) return null
    try {
        const response = await defTmRequest.request<ArrayBuffer>({
            url,
            method: 'GET',
            headers: coverDownloadHeaders,
            responseType: 'arraybuffer',
            timeout: coverTimeoutMs
        })
        const buffer = response.data
        if (!buffer || typeof (buffer as any).byteLength !== 'number') {
            console.warn('[station-b-shield] 封面下载失败，响应为空', coverUrl)
            return null
        }
        if ((buffer as any).byteLength > maxCoverBytes) {
            console.warn('[station-b-shield] 封面体积超过上限，已放弃附带封面', coverUrl, (buffer as any).byteLength)
            return null
        }
        return {
            base64: arrayBufferToBase64(buffer),
            mediaType: pickMediaType(url, response.headers['content-type'])
        }
    } catch (error) {
        console.warn('[station-b-shield] 封面下载失败，已退化为纯文本分类', coverUrl, error)
        return null
    }
}

export default {fetchCover, normalizeCoverUrl}
