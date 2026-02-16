import { resolvePath } from "./utils/path"

export type AppConfig = {
  appName: string
  logLevel: string
  heartbeatIntervalMinutes: number
  heartbeatFile: string
  enableTelegram: boolean
  telegramToken?: string
  workspaceDir: string
  opencodeModel?: string
  opencodeAgent?: string
  opencodeDirectory?: string
  opencodeServerUrl: string
  opencodeServerUsername?: string
  opencodeServerPassword?: string
  whitelistFile: string
  whitelistPairToken?: string
  pairMaxAttempts: number
  pairLockMinutes: number
}

function envBool(value: string | undefined, fallback = false): boolean {
  if (!value) return fallback
  const v = value.trim().toLowerCase()
  return v === "1" || v === "true" || v === "yes" || v === "on"
}

function envInt(value: string | undefined, fallback: number): number {
  if (!value) return fallback
  const n = Number.parseInt(value, 10)
  return Number.isFinite(n) ? n : fallback
}

export async function loadConfig(): Promise<AppConfig> {
  const cwd = Bun.cwd
  const workspaceDir = resolvePath(cwd, ".data/workspace")
  const opencodeServerUrl = Bun.env.OPENCODE_SERVER_URL?.trim()
  if (!opencodeServerUrl) {
    throw new Error("Missing OPENCODE_SERVER_URL. MonClaw requires a remote OpenCode server.")
  }

  return {
    appName: Bun.env.APP_NAME ?? "monclaw",
    logLevel: Bun.env.LOG_LEVEL ?? "info",
    heartbeatIntervalMinutes: envInt(Bun.env.HEARTBEAT_INTERVAL_MINUTES, 30),
    heartbeatFile: resolvePath(cwd, Bun.env.HEARTBEAT_FILE ?? ".data/heartbeat.md"),
    enableTelegram: envBool(Bun.env.ENABLE_TELEGRAM, true),
    telegramToken: Bun.env.TELEGRAM_BOT_TOKEN,
    workspaceDir,
    opencodeModel: Bun.env.OPENCODE_MODEL,
    opencodeAgent: Bun.env.OPENCODE_AGENT,
    opencodeDirectory: Bun.env.OPENCODE_DIRECTORY,
    opencodeServerUrl,
    opencodeServerUsername: Bun.env.OPENCODE_SERVER_USERNAME,
    opencodeServerPassword: Bun.env.OPENCODE_SERVER_PASSWORD,
    whitelistFile: resolvePath(cwd, Bun.env.WHITELIST_FILE ?? ".data/whitelist.json"),
    whitelistPairToken: Bun.env.WHITELIST_PAIR_TOKEN,
    pairMaxAttempts: envInt(Bun.env.PAIR_MAX_ATTEMPTS, 5),
    pairLockMinutes: envInt(Bun.env.PAIR_LOCK_MINUTES, 15),
  }
}
