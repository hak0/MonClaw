import { ensureDir, listFiles, readJson, removeFile, writeJson } from "./fs"
import { joinPath, resolvePath } from "./path"

export type OutboxMessage = {
  channel: "telegram"
  userID: string
  text: string
}

type Pending = {
  filePath: string
  message: OutboxMessage
}

const outboxDir = resolvePath(Bun.cwd, ".data/outbox")

export async function queueOutbox(message: OutboxMessage): Promise<string> {
  await ensureDir(outboxDir)
  const filePath = joinPath(outboxDir, `${Date.now()}-${Math.random().toString(36).slice(2, 8)}.json`)
  await writeJson(filePath, {
    channel: message.channel,
    userID: message.userID,
    text: message.text,
    createdAt: new Date().toISOString(),
  })
  return filePath
}

export async function listOutbox(channel: OutboxMessage["channel"]): Promise<Pending[]> {
  await ensureDir(outboxDir)
  const files = await listFiles(outboxDir)
  const pending: Pending[] = []

  for (const name of files.sort()) {
    if (!name.endsWith(".json")) continue
    const filePath = joinPath(outboxDir, name)
    try {
      const msg = await readJson<Partial<OutboxMessage>>(filePath)
      if (msg.channel !== channel) continue
      if (typeof msg.userID !== "string" || typeof msg.text !== "string") continue
      pending.push({ filePath, message: { channel, userID: msg.userID, text: msg.text } })
    } catch {
      // Ignore malformed files.
    }
  }

  return pending
}

export async function ackOutbox(filePath: string): Promise<void> {
  await removeFile(filePath)
}
