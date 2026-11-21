/**
 * 旧版导出的 converter：识别含 `conversations.json` 且无 `manifest.json` 的归档。
 *
 * `convert` 复用旧版包的 `parseLegacyArchive`（子路径）与 `convertConversation`（bare import）。
 * 旧版图片不处理（降级为合成文件卡片，由旧版 convertConversation 内部完成）。
 */

import { unzipSync } from 'fflate'
import { convertConversation } from '@deepseek-ai/dsh-deepseek-chat-import-legacy/src/conversation.ts'
import { parseLegacyArchive } from '@deepseek-ai/dsh-deepseek-chat-import-legacy/src/archive.ts'
import type { ArchiveConverter, ConvertedConversation, ConvertSkip } from './converter.ts'

/** 旧版导出的会话条目。 */
const CONVERSATIONS_ENTRY = 'conversations.json'
/** 新版导出的格式标识；同时含两者时新版优先。 */
const MANIFEST_ENTRY = 'manifest.json'

/** 旧版归档 converter。 */
export const legacyConverter: ArchiveConverter = {
  kind: 'legacy',
  detect(bytes) {
    const names = listZipEntryNames(bytes)
    return names !== undefined && names.includes(CONVERSATIONS_ENTRY) && !names.includes(MANIFEST_ENTRY)
  },
  async convert(bytes, options, signal) {
    const { conversations } = parseLegacyArchive(bytes)
    const skipped: ConvertSkip[] = []
    const converted: ConvertedConversation[] = []
    const convertOptions = { createId: options.createId, maxTitleBytes: options.maxTitleBytes }
    for (let index = 0; index < conversations.length; index++) {
      signal.throwIfAborted()
      const value = conversations[index]!
      let title: string | null = null
      try {
        const conversion = convertConversation(value, convertOptions)
        title = conversion.title
        converted.push(conversion)
      } catch (error) {
        signal.throwIfAborted()
        const reason = errorText(error)
        skipped.push({ conversationId: String(index), title, reason })
        options.warn(`deepseek-chat-import-router: conversation at index ${index} was not imported: ${reason}`)
      }
    }
    return { conversations: converted, conversationCount: conversations.length, skipped }
  },
}

/** 列出 ZIP 的入口名；不是可读 ZIP 时为 undefined。 */
function listZipEntryNames(bytes: Uint8Array): string[] | undefined {
  try {
    const names: string[] = []
    unzipSync(bytes, { filter: (file) => { names.push(file.name); return false } })
    return names
  } catch {
    return undefined
  }
}

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}
