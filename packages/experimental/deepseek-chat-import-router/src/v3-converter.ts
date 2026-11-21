/**
 * 新版导出的 converter：识别含 `manifest.json` 的归档。
 *
 * `convert` 复用新版包的 `openExportArchive` / `convertConversation`，并复制
 * `importer.ts` 的图片两趟逻辑（`storeImages` / `imagePlan` / `referencedImages` /
 * `convertWithStoredImages`）以保存 v3 图片。
 */

import { extname } from 'node:path'
import { unzipSync } from 'fflate'
import type { ImageAttachmentRef, ImageMediaType } from '@deepseek-ai/dsh-attachment'
import { ExportSourceError, openExportArchive } from '@deepseek-ai/dsh-deepseek-chat-import/src/archive.ts'
import type { ExportArchive, ExportEntryError, ExportStreamHandler } from '@deepseek-ai/dsh-deepseek-chat-import/src/archive.ts'
import { convertConversation, selectBranch } from '@deepseek-ai/dsh-deepseek-chat-import/src/conversation.ts'
import type { ConvertConversationOptions, ConvertedConversation as V3ConvertedConversation } from '@deepseek-ai/dsh-deepseek-chat-import/src/conversation.ts'
import {
  exportManifest, exportSessionFile, exportSessionIndex, parseKnownFragment, SUPPORTED_EXPORT_FORMAT_VERSION,
} from '@deepseek-ai/dsh-deepseek-chat-import/src/format.ts'
import type { ExportSessionFile } from '@deepseek-ai/dsh-deepseek-chat-import/src/format.ts'
import type { DeepseekChatImportFailureReason } from '@deepseek-ai/dsh-deepseek-chat-import/src/types.ts'
import type { ArchiveConverter, ConvertOptions, ConvertSkip } from './converter.ts'

/** 归档内声明导出格式版本的入口。 */
const MANIFEST_ENTRY = 'manifest.json'
/** 归档内列出每个会话及其顺序的入口。 */
const INDEX_ENTRY = 'chat_session_index.json'
/** 会话文件入口；id 即入口名。 */
const CONVERSATION_ENTRY = /^chat_sessions\/([^/]+)\.json$/u
/** 图片文件入口；首段路径为所属会话 id。 */
const IMAGE_ENTRY = /^chat_sessions\/([^/]+)_files\/[^/]+$/u

/** 单个条目未提供 `maxEntryBytes` 时的默认上限，与部署默认一致。 */
const DEFAULT_MAX_ENTRY_BYTES = 256 * 1024 * 1024

const IMAGE_MEDIA_TYPES: ReadonlyMap<string, ImageMediaType> = new Map([
  ['.png', 'image/png'],
  ['.jpg', 'image/jpeg'],
  ['.jpeg', 'image/jpeg'],
  ['.webp', 'image/webp'],
  ['.gif', 'image/gif'],
])

/** 一条 `chat_session_index.json` 行，按其 index 排序。 */
interface RankedRow {
  readonly id: string
  readonly insertedAt: number
  readonly updatedAt: number
}

/** 选中分支里的一张图片，按 `export_path` 命名。 */
interface PlannedImage {
  /** `FILE` 条目 id，转换后的 `image` 块引用它。 */
  readonly fileId: string
}

/** 图片趟为每个归档入口记录的结果。 */
type StoredImage =
  | { readonly stored: true; readonly ref: ImageAttachmentRef }
  | { readonly stored: false; readonly reason: string }

/** 元数据入口的失败原因，按缺失或损坏。 */
interface MetadataReasons {
  readonly missing: DeepseekChatImportFailureReason
  readonly damaged: DeepseekChatImportFailureReason
}

/** 新版归档 converter。 */
export const v3Converter: ArchiveConverter = {
  kind: 'v3',
  detect(bytes) {
    const names = listZipEntryNames(bytes)
    return names !== undefined && names.includes(MANIFEST_ENTRY)
  },
  async convert(bytes, options, signal) {
    const archive = await openExportArchive(bytes, options.maxEntryBytes ?? DEFAULT_MAX_ENTRY_BYTES, signal)
    const skipped: ConvertSkip[] = []
    const report = (item: ConvertSkip): void => {
      skipped.push(item)
      options.warn(`deepseek-chat-import-router: conversation ${item.conversationId} was not imported: ${item.reason}`)
    }

    const manifest = await readMetadata(archive, MANIFEST_ENTRY, { missing: 'missing-manifest', damaged: 'unreadable-archive' }, signal)
    // 版本门控后续全部转换，因此在读取 index 之前先校验。
    const version = exportManifest.safeParse(parseJson(manifest))
    if (!version.success || version.data.export_format_version !== SUPPORTED_EXPORT_FORMAT_VERSION) {
      throw new ExportSourceError('unsupported-version', `manifest.json must declare export_format_version ${SUPPORTED_EXPORT_FORMAT_VERSION}`)
    }
    const index = await readMetadata(archive, INDEX_ENTRY, { missing: 'missing-index', damaged: 'missing-index' }, signal)
    const ranked = parseIndex(index)
    const chosen = new Set(ranked.map(row => row.id))

    const convertOptions: ConvertConversationOptions = { createId: options.createId, maxTitleBytes: options.maxTitleBytes }
    const conversions = new Map<string, V3ConvertedConversation>()
    /** 已被处理过（成功或失败）的会话入口。 */
    const handled = new Set<string>()

    // 图片趟在任何会话被解析前运行，因此归档入口顺序无关紧要，会话趟只需查引用。
    const storedImages = await storeImages(options.attachments, archive, chosen, signal)
    signal.throwIfAborted()

    const handler: ExportStreamHandler = {
      select: (entry) => {
        const conversation = conversationIdOf(entry.name)
        return conversation !== undefined && chosen.has(conversation)
      },
      reject: (entry, error) => {
        const conversation = conversationIdOf(entry.name)
        if (conversation === undefined || !chosen.has(conversation)) return
        handled.add(conversation)
        report({ conversationId: conversation, title: null, reason: error.message })
      },
      entry: async (entry, data) => {
        // select 只放行选中的会话入口，其入口名携带 id。
        const conversationId = conversationIdOf(entry.name)!
        handled.add(conversationId)
        let file: ExportSessionFile | undefined
        try {
          file = parseConversation(data)
          conversions.set(conversationId, convertWithStoredImages(options.attachments, options.warn, file, storedImages, convertOptions))
        } catch (error) {
          signal.throwIfAborted()
          report({ conversationId, title: file?.title ?? null, reason: errorText(error) })
        }
      },
    }
    await archive.stream(handler, signal)
    signal.throwIfAborted()

    // 归档里始终没有的会话：上报为跳过。按 index 顺序组装最终结果。
    const conversations: V3ConvertedConversation[] = []
    for (const row of ranked) {
      const conversion = conversions.get(row.id)
      if (conversion === undefined) {
        if (!handled.has(row.id)) report({ conversationId: row.id, title: null, reason: 'the export has no file for this conversation' })
        continue
      }
      conversations.push(conversion)
    }

    return { conversations, conversationCount: ranked.length, skipped }
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

/**
 * 存储选中会话的图片，按入口名索引。仅解压 `chat_sessions/{id}_files/…` 中 id 属于
 * `conversations` 的入口；会话入口被跳过。每个被处理的入口记录已存储引用或未存储原因，
 * 会话趟据此生成 warning。
 */
async function storeImages(
  attachments: ConvertOptions['attachments'],
  archive: ExportArchive,
  conversations: ReadonlySet<string>,
  signal: AbortSignal,
): Promise<Map<string, StoredImage>> {
  const stored = new Map<string, StoredImage>()
  if (attachments === undefined) return stored
  const handler: ExportStreamHandler = {
    select: (entry) => {
      const conversation = imageConversationIdOf(entry.name)
      if (conversation === undefined || !conversations.has(conversation)) return false
      if (imageMediaTypeOf(entry.name) !== undefined) return true
      // 该入口永不解压；会话趟仅在选中分支引用它时报告类型。
      stored.set(entry.name, { stored: false, reason: 'unsupported image type' })
      return false
    },
    reject: (entry, error) => {
      const conversation = imageConversationIdOf(entry.name)
      if (conversation === undefined || !conversations.has(conversation)) return
      stored.set(entry.name, { stored: false, reason: error.message })
    },
    entry: async (entry, data) => {
      // select 只放行已识别扩展名的图片入口。
      const mediaType = imageMediaTypeOf(entry.name)!
      try {
        const ref = await attachments.saveImage({ data, mediaType, name: imageNameOf(entry.name) })
        stored.set(entry.name, { stored: true, ref })
      } catch (error) {
        signal.throwIfAborted()
        stored.set(entry.name, { stored: false, reason: errorText(error) })
      }
    },
  }
  await archive.stream(handler, signal)
  return stored
}

/**
 * 用图片趟存储的引用转换一个会话。该趟先于转换运行，因此一个图片所属会话随后转换失败
 * 时，图片已被存储而无引用事件；`SessionPersistence` 与 attachment 存储都不提供删除。
 */
function convertWithStoredImages(
  attachments: ConvertOptions['attachments'],
  warn: (message: string) => void,
  file: ExportSessionFile,
  stored: ReadonlyMap<string, StoredImage>,
  options: ConvertConversationOptions,
): V3ConvertedConversation {
  if (attachments === undefined) return convertConversation(file, options)
  const images = referencedImages(warn, imagePlan(file), stored)
  return convertConversation(file, images.size === 0 ? options : { ...options, images })
}

/**
 * 读取转换前所需的元数据入口。
 * @throws {ExportSourceError} 超限入口为 `too-large`，否则为给定原因。
 */
async function readMetadata(
  archive: ExportArchive, name: string, reasons: MetadataReasons, signal: AbortSignal,
): Promise<Uint8Array> {
  let bytes: Uint8Array | undefined
  try {
    bytes = await archive.read(name, signal)
  } catch (error) {
    signal.throwIfAborted()
    // 除取消外，`read` 仅以 ExportEntryError 失败。
    const entryError = error as ExportEntryError
    throw new ExportSourceError(entryError.oversized ? 'too-large' : reasons.damaged, entryError.message, { cause: error })
  }
  if (bytes === undefined) throw new ExportSourceError(reasons.missing, `the archive has no ${name}`)
  return bytes
}

/**
 * 按 index 排序会话，最近更新优先。
 * @throws {ExportSourceError} `missing-index` 当入口不是会话索引，`no-conversations` 当列表为空。
 */
function parseIndex(bytes: Uint8Array): RankedRow[] {
  const parsed = exportSessionIndex.safeParse(parseJson(bytes))
  if (!parsed.success) throw new ExportSourceError('missing-index', 'the archive has no readable chat_session_index.json')
  const rows = new Map<string, RankedRow>()
  for (const row of parsed.data) {
    if (rows.has(row.id)) continue
    rows.set(row.id, { id: row.id, insertedAt: row.inserted_at, updatedAt: row.updated_at })
  }
  if (rows.size === 0) throw new ExportSourceError('no-conversations', 'the export contains no importable conversation')
  return [...rows.values()].sort(compareRanks)
}

/** 排序两条 index 行：最近更新优先，其次最近插入，最后按 id。 */
function compareRanks(left: RankedRow, right: RankedRow): number {
  if (left.updatedAt !== right.updatedAt) return right.updatedAt - left.updatedAt
  if (left.insertedAt !== right.insertedAt) return right.insertedAt - left.insertedAt
  return left.id < right.id ? -1 : 1
}

/** 一个会话入口名携带的会话 id，其他入口为 undefined。 */
function conversationIdOf(name: string): string | undefined {
  return CONVERSATION_ENTRY.exec(name)?.[1]
}

/** 一个图片入口名携带的会话 id，其他入口为 undefined。 */
function imageConversationIdOf(name: string): string | undefined {
  return IMAGE_ENTRY.exec(name)?.[1]
}

/** 一个图片入口的媒体类型，扩展名不支持时为 undefined。 */
function imageMediaTypeOf(name: string): ImageMediaType | undefined {
  return IMAGE_MEDIA_TYPES.get(extname(name).toLowerCase())
}

/** 一个 UUID 文件 id 开头每个导出图片入口名，其后为 `_`；更早的归档用 `-`。 */
const IMAGE_FILE_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}[_-]/iu

/** 一个图片入口的显示名：去掉前导文件 id 后的叶子名。 */
function imageNameOf(name: string): string {
  const leaf = name.slice(name.lastIndexOf('/') + 1)
  return leaf.replace(IMAGE_FILE_ID, '')
}

/**
 * 解压并校验一个会话文件。
 * @throws {Error} 命名 JSON 或 schema 缺陷。
 */
function parseConversation(data: Uint8Array): ExportSessionFile {
  const json = parseJson(data)
  if (json === undefined) throw new Error('invalid conversation file: not valid JSON')
  const parsed = exportSessionFile.safeParse(json)
  if (!parsed.success) throw new Error(`invalid conversation file: ${parsed.error.issues.map(issue => issue.message).join('; ')}`)
  return parsed.data
}

/** 按 `export_path` 规划选中分支的图片。 */
function imagePlan(file: ExportSessionFile): Map<string, PlannedImage> {
  const plan = new Map<string, PlannedImage>()
  for (const message of selectBranch(file)) {
    if (message.role !== 'USER') continue
    for (const envelope of message.fragments) {
      // 转换已校验该分支每个已映射片段。
      const fragment = parseKnownFragment(envelope)
      if (fragment?.type !== 'FILE') continue
      for (const entry of fragment.files) {
        if (!entry.is_image || entry.export_path === null) continue
        plan.set(entry.export_path, { fileId: entry.id })
      }
    }
  }
  return plan
}

/**
 * 把一个会话的图片映射到图片趟存储的引用。该趟未处理或未能存储的入口成为合成文件卡片，
 * 并附带一条命名原因的 warning。
 */
function referencedImages(
  warn: (message: string) => void,
  plan: ReadonlyMap<string, PlannedImage>,
  stored: ReadonlyMap<string, StoredImage>,
): Map<string, ImageAttachmentRef> {
  const images = new Map<string, ImageAttachmentRef>()
  for (const [path, planned] of plan) {
    const outcome = stored.get(path)
    if (outcome === undefined) {
      warn(`deepseek-chat-import-router: image ${path} is not stored: not in the export`)
      continue
    }
    if (!outcome.stored) {
      warn(`deepseek-chat-import-router: image ${path} is not stored: ${outcome.reason}`)
      continue
    }
    images.set(planned.fileId, outcome.ref)
  }
  return images
}

/** 解码一个 JSON 文件；undefined 标记非 JSON 文本，因为 JSON 无法编码 undefined。 */
function parseJson(bytes: Uint8Array): unknown {
  try {
    return JSON.parse(new TextDecoder().decode(bytes))
  } catch {
    // 调用方把文件报告为无效。
    return undefined
  }
}

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}
