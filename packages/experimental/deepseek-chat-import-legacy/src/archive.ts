/** 解析旧版导出 ZIP：仅提取 conversations.json 并解析为顶层数组。 */

import { unzipSync } from 'fflate'
import type { DeepseekChatImportLegacyFailureReason } from './types.ts'

/** 归档层失败：携带一个 wire reason，upload route 据此生成 outcome 行。 */
export class ExportSourceError extends Error {
  /** 面向浏览器的失败原因。 */
  readonly reason: DeepseekChatImportLegacyFailureReason

  constructor(reason: DeepseekChatImportLegacyFailureReason, message: string, options?: { cause?: unknown }) {
    super(message, options)
    this.reason = reason
  }
}

/** 解析后的旧版导出归档。 */
export interface LegacyArchive {
  /** conversations.json 解析后的顶层数组，每条为一棵 mapping 树。 */
  readonly conversations: readonly unknown[]
}

/**
 * 解压上传的 ZIP 并提取 conversations.json。
 * @param bytes - 完整的上传字节。
 * @returns conversations.json 解析后的数组。
 * @throws {ExportSourceError} 归档不可读、缺少 conversations.json 或 JSON 非法。
 */
export function parseLegacyArchive(bytes: Uint8Array): LegacyArchive {
  let files: Record<string, Uint8Array>
  try {
    files = unzipSync(bytes)
  } catch (error) {
    throw new ExportSourceError('unreadable-archive', 'the upload is not a readable ZIP archive', { cause: error })
  }
  const entry = files['conversations.json']
  if (entry === undefined) {
    throw new ExportSourceError('missing-conversations', 'the archive has no conversations.json', {})
  }
  let parsed: unknown
  try {
    parsed = JSON.parse(new TextDecoder().decode(entry))
  } catch (error) {
    throw new ExportSourceError('unreadable-archive', 'conversations.json is not valid JSON', { cause: error })
  }
  if (!Array.isArray(parsed)) {
    throw new ExportSourceError('unreadable-archive', 'conversations.json is not an array', {})
  }
  return { conversations: parsed }
}
