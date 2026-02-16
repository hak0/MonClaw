import { readText, writeText } from "../utils/fs"
import { resolvePath } from "../utils/path"
import { saveLastChannel } from "../utils/last-channel"
import { fileURLToPath } from "node:url"
import { dirname } from "node:path"

type EnvMap = Record<string, string>

const THIS_DIR = dirname(fileURLToPath(import.meta.url))
const REPO_ROOT = resolvePath(THIS_DIR, "..", "..")
const ENV_FILE = resolvePath(REPO_ROOT, ".env")

function ask(promptText: string): string {
  const value = prompt(promptText)
  return (value ?? "").trim()
}

function parseEnv(lines: string[]): EnvMap {
  const out: EnvMap = {}
  for (const line of lines) {
    const trimmed = line.trim()
    if (!trimmed || trimmed.startsWith("#")) continue
    const idx = trimmed.indexOf("=")
    if (idx <= 0) continue
    const key = trimmed.slice(0, idx).trim()
    const value = trimmed.slice(idx + 1)
    out[key] = value
  }
  return out
}

function updateEnvLines(lines: string[], updates: EnvMap): string[] {
  const out = [...lines]
  const seen = new Set<string>()
  for (let i = 0; i < out.length; i += 1) {
    const line = out[i]
    const idx = line.indexOf("=")
    if (idx <= 0) continue
    const key = line.slice(0, idx).trim()
    if (Object.prototype.hasOwnProperty.call(updates, key)) {
      out[i] = `${key}=${updates[key]}`
      seen.add(key)
    }
  }
  for (const [key, value] of Object.entries(updates)) {
    if (!seen.has(key)) out.push(`${key}=${value}`)
  }
  return out
}

async function loadEnvFile(): Promise<string[]> {
  try {
    const raw = await readText(ENV_FILE)
    return raw.split(/\r?\n/)
  } catch {
    return []
  }
}

async function saveEnvFile(lines: string[]): Promise<void> {
  await writeText(ENV_FILE, lines.join("\n").trimEnd() + "\n")
}

async function main(): Promise<void> {
  const lines = await loadEnvFile()
  const current = parseEnv(lines)
  const updates: EnvMap = {}

  updates.ENABLE_TELEGRAM = "true"

  const token = ask("Telegram bot token: ") || current.TELEGRAM_BOT_TOKEN || ""
  if (!token) {
    console.log("TELEGRAM_BOT_TOKEN is required.")
    process.exit(1)
  }
  updates.TELEGRAM_BOT_TOKEN = token

  const telegramUserID = ask("Telegram user ID (optional): ")
  if (telegramUserID) {
    await saveLastChannel("telegram", telegramUserID)
  }

  const serverUrl = ask("OpenCode server URL (required): ") || current.OPENCODE_SERVER_URL || ""
  if (!serverUrl) {
    console.log("OPENCODE_SERVER_URL is required.")
    process.exit(1)
  }
  updates.OPENCODE_SERVER_URL = serverUrl

  const serverPassword = ask("OpenCode server password (optional): ")
  if (serverPassword) updates.OPENCODE_SERVER_PASSWORD = serverPassword

  const serverUsername = ask("OpenCode server username (optional): ")
  if (serverUsername) updates.OPENCODE_SERVER_USERNAME = serverUsername

  const directory = ask("OpenCode directory (optional): ") || current.OPENCODE_DIRECTORY || ""
  if (directory) updates.OPENCODE_DIRECTORY = directory

  console.log("WHITELIST_PAIR_TOKEN allows users to self-pair via '/pair <token>' in chat.")
  const pairTokenPrompt = current.WHITELIST_PAIR_TOKEN
    ? "Whitelist pair token (leave blank to keep current): "
    : "Whitelist pair token (leave blank to disable): "
  const pairToken = ask(pairTokenPrompt)
  if (pairToken) updates.WHITELIST_PAIR_TOKEN = pairToken

  const merged = updateEnvLines(lines, updates)
  await saveEnvFile(merged)

  console.log("Setup complete. Run: bun run dev")
  process.exit(0)
}

void main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error))
  process.exit(1)
})
