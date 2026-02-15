import { ensureDir, readJson, writeJson } from "../utils/fs"
import { dirname, resolvePath } from "../utils/path"

type Channel = "telegram" | "whatsapp"

type PairAttemptRecord = {
  failedCount: number
  lastFailedAt?: string
  lockedUntil?: string
}

type PairAttemptData = Record<string, PairAttemptRecord>

export type PairAttemptState = {
  failedCount: number
  lastFailedAt?: string
  lockedUntil?: string
  isLocked: boolean
}

export class PairAttemptStore {
  private data: PairAttemptData = {}

  constructor(private readonly filePath = resolvePath(Bun.cwd, ".data/pair-attempts.json")) {}

  async init(): Promise<void> {
    await ensureDir(dirname(this.filePath))
    try {
      const parsed = await readJson<PairAttemptData>(this.filePath)
      const next: PairAttemptData = {}
      for (const [key, value] of Object.entries(parsed ?? {})) {
        if (!value || typeof value !== "object") continue
        next[key] = {
          failedCount: Number.isFinite(value.failedCount) ? Math.max(0, Math.trunc(value.failedCount)) : 0,
          lastFailedAt: typeof value.lastFailedAt === "string" ? value.lastFailedAt : undefined,
          lockedUntil: typeof value.lockedUntil === "string" ? value.lockedUntil : undefined,
        }
      }
      this.data = next
      await this.persist()
    } catch {
      this.data = {}
      await this.persist()
    }
  }

  async getState(channel: Channel, userID: string): Promise<PairAttemptState> {
    return this.resolveState(this.key(channel, userID), Date.now())
  }

  async recordFailure(channel: Channel, userID: string, maxAttempts: number, lockMinutes: number): Promise<PairAttemptState> {
    const key = this.key(channel, userID)
    const now = Date.now()
    const current = this.normalizeRecord(this.data[key], now)

    const failedCount = current.failedCount + 1
    const next: PairAttemptRecord = {
      failedCount,
      lastFailedAt: new Date(now).toISOString(),
      lockedUntil: current.lockedUntil,
    }

    if (failedCount >= Math.max(1, maxAttempts)) {
      const lockMs = Math.max(1, lockMinutes) * 60 * 1000
      next.lockedUntil = new Date(now + lockMs).toISOString()
      next.failedCount = 0
    }

    this.data[key] = next
    await this.persist()
    return this.toState(next, now)
  }

  async clear(channel: Channel, userID: string): Promise<void> {
    const key = this.key(channel, userID)
    if (!this.data[key]) return
    delete this.data[key]
    await this.persist()
  }

  private async resolveState(key: string, now: number): Promise<PairAttemptState> {
    const existing = this.data[key]
    if (!existing) return this.toState({ failedCount: 0 }, now)

    const current = this.normalizeRecord(existing, now)
    const changed =
      existing.failedCount !== current.failedCount ||
      existing.lastFailedAt !== current.lastFailedAt ||
      existing.lockedUntil !== current.lockedUntil
    if (changed) {
      this.data[key] = current
      await this.persist()
    }
    return this.toState(current, now)
  }

  private normalizeRecord(record: PairAttemptRecord | undefined, now: number): PairAttemptRecord {
    if (!record) return { failedCount: 0 }
    const expiresAt = record.lockedUntil ? Date.parse(record.lockedUntil) : Number.NaN
    if (Number.isFinite(expiresAt) && expiresAt <= now) {
      return {
        failedCount: 0,
        lastFailedAt: record.lastFailedAt,
      }
    }
    return {
      failedCount: Math.max(0, Math.trunc(record.failedCount ?? 0)),
      lastFailedAt: record.lastFailedAt,
      lockedUntil: record.lockedUntil,
    }
  }

  private toState(record: PairAttemptRecord, now: number): PairAttemptState {
    const expiresAt = record.lockedUntil ? Date.parse(record.lockedUntil) : Number.NaN
    const isLocked = Number.isFinite(expiresAt) && expiresAt > now
    return {
      failedCount: record.failedCount,
      lastFailedAt: record.lastFailedAt,
      lockedUntil: record.lockedUntil,
      isLocked,
    }
  }

  private key(channel: Channel, userID: string): string {
    return `${channel}:${String(userID)}`
  }

  private async persist(): Promise<void> {
    await writeJson(this.filePath, this.data)
  }
}
