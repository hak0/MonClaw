import { ensureDir, listFiles, removeFile, writeText } from "./fs"
import { joinPath } from "./path"

export type InboxChannel = "telegram"
export type InboxKind = "voice" | "photo"

type SaveInboxBinaryInput = {
  dir: string
  channel: InboxChannel
  userID: string
  kind: InboxKind
  extension: string
  data: Uint8Array
  metadata: Record<string, unknown>
}

type SaveInboxBinaryResult = {
  id: string
  filePath: string
  metaPath: string
}

function sanitizeToken(value: string): string {
  return value.replace(/[^A-Za-z0-9_-]/g, "_")
}

function normalizeExtension(extension: string): string {
  const ext = extension.trim().toLowerCase()
  if (!ext) return ""
  return ext.startsWith(".") ? ext : `.${ext}`
}

function makeID(channel: InboxChannel, kind: InboxKind, userID: string): string {
  const ts = Date.now()
  const rand = Math.random().toString(36).slice(2, 8)
  return `${ts}-${channel}-${kind}-${sanitizeToken(userID)}-${rand}`
}

export async function saveInboxBinary(input: SaveInboxBinaryInput): Promise<SaveInboxBinaryResult> {
  await ensureDir(input.dir)
  const id = makeID(input.channel, input.kind, input.userID)
  const extension = normalizeExtension(input.extension)
  const filePath = joinPath(input.dir, `${id}${extension}`)
  const metaPath = joinPath(input.dir, `${id}.json`)

  await Bun.write(filePath, input.data)
  await writeText(
    metaPath,
    JSON.stringify(
      {
        id,
        createdAt: new Date().toISOString(),
        channel: input.channel,
        userID: input.userID,
        kind: input.kind,
        filePath,
        ...input.metadata,
      },
      null,
      2,
    ),
  )

  return { id, filePath, metaPath }
}

export async function pruneInbox(dir: string, maxAgeMs: number): Promise<{ deleted: number; kept: number }> {
  await ensureDir(dir)
  const files = await listFiles(dir)
  const now = Date.now()
  let deleted = 0
  let kept = 0

  for (const name of files) {
    const match = name.match(/^(\d{13})-/)
    if (!match) {
      kept += 1
      continue
    }
    const createdAtMs = Number.parseInt(match[1], 10)
    if (!Number.isFinite(createdAtMs) || now - createdAtMs <= maxAgeMs) {
      kept += 1
      continue
    }
    await removeFile(joinPath(dir, name))
    deleted += 1
  }

  return { deleted, kept }
}
