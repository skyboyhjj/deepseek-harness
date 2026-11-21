/** 归档格式转换抽象层：一个 converter 对应一种可识别的导出归档格式。 */

import type { ImageAttachmentRef, SaveImageAttachment } from '@deepseek-ai/dsh-attachment'
import type { SessionEvent } from '@deepseek-ai/dsh-session'

/** 转换后单个会话的种子日志（不含写入）。 */
export interface ConvertedConversation {
  /** 归一化后的标题，缺失或归一化为空时为 null。 */
  readonly title: string | null
  /** 首个事件的 epoch 毫秒时间，作为 Session 创建时间。 */
  readonly createdAt: number
  /** 从 seq 0 连续的种子事件，不含 `session/end-seed` 标记。 */
  readonly events: readonly SessionEvent[]
}

/** converter 的注入依赖。 */
export interface ConvertOptions {
  /** 为每个消息、工具调用铸造唯一 id。 */
  readonly createId: () => string
  /** 导入标题的最大 UTF-8 字节数。 */
  readonly maxTitleBytes: number
  /** 图片存储；仅 v3 converter 使用，legacy 忽略（图片降级为合成文件卡片）。 */
  readonly attachments?: { saveImage(input: SaveImageAttachment): Promise<ImageAttachmentRef> } | undefined
  /** 单个归档条目声明未压缩字节的最大值；仅 v3 converter 使用。 */
  readonly maxEntryBytes?: number
  /** 每个未导入会话与每张未存储图片的诊断。 */
  readonly warn: (message: string) => void
}

/** 一条未能转换的会话。 */
export interface ConvertSkip {
  /** 会话 id（来自 index / 入口名），或转换失败时的可定位标识。 */
  readonly conversationId: string
  /** 转换后（若可用）的标题；转换失败时为 null。 */
  readonly title: string | null
  /** 描述缺陷的诊断信息。 */
  readonly reason: string
}

/** 一次格式转换的汇总（不含写入）。 */
export interface ConvertResult {
  /** 转换成功的会话，按归档内的顺序（v3 按 index 最近优先，legacy 按数组顺序）。 */
  readonly conversations: readonly ConvertedConversation[]
  /** 归档内的会话总数。 */
  readonly conversationCount: number
  /** 未能转换的会话。 */
  readonly skipped: readonly ConvertSkip[]
}

/** 一种可识别的导出归档格式。 */
export interface ArchiveConverter {
  /** 格式标识，用于日志与 result 溯源。 */
  readonly kind: 'v3' | 'legacy'
  /** 该 converter 是否匹配这份归档（读 ZIP 目录，不全量解压）。 */
  detect(bytes: Uint8Array): boolean
  /** 把归档转换为若干会话的种子日志（不含写入）。 */
  convert(bytes: Uint8Array, options: ConvertOptions, signal: AbortSignal): Promise<ConvertResult>
}
