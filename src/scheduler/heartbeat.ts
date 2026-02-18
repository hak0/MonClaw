import type { Logger } from "pino"
import { AssistantCore } from "../core/assistant"

type HeartbeatSchedulerOptions = {
  intervalMinutes: number
  timeoutSeconds: number
  startupDelaySeconds: number
  assistant: AssistantCore
  logger: Logger
}

function errorMessage(error: unknown): string {
  if (error instanceof Error) return error.message
  return String(error)
}

function withTimeout<T>(promise: Promise<T>, timeoutMs: number): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => {
      reject(new Error(`Heartbeat timed out after ${timeoutMs}ms`))
    }, timeoutMs)

    promise.then(
      (value) => {
        clearTimeout(timer)
        resolve(value)
      },
      (error) => {
        clearTimeout(timer)
        reject(error)
      },
    )
  })
}

export function startHeartbeat(opts: HeartbeatSchedulerOptions): void {
  const { intervalMinutes, timeoutSeconds, startupDelaySeconds, assistant, logger } = opts
  const ms = Math.max(1, intervalMinutes) * 60_000
  if (!Number.isFinite(ms) || ms <= 0) {
    logger.warn({ intervalMinutes }, "invalid heartbeat interval, skipping")
    return
  }

  const timeoutMs = Math.max(1, timeoutSeconds) * 1000
  if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) {
    logger.warn({ timeoutSeconds }, "invalid heartbeat timeout, skipping")
    return
  }

  const startupDelayMs = Math.max(0, startupDelaySeconds) * 1000
  if (!Number.isFinite(startupDelayMs) || startupDelayMs < 0) {
    logger.warn({ startupDelaySeconds }, "invalid heartbeat startup delay, skipping")
    return
  }

  let running = false
  const run = async () => {
    if (running) {
      logger.warn("heartbeat run skipped: previous run still active")
      return
    }
    running = true
    const startedAt = Date.now()
    try {
      logger.info("heartbeat run started")
      const result = await withTimeout(assistant.runHeartbeatTasks(), timeoutMs)
      logger.info({ result, durationMs: Date.now() - startedAt }, "heartbeat run completed")
    } catch (error) {
      const reason = errorMessage(error)
      logger.error({ err: error, reason, durationMs: Date.now() - startedAt }, "heartbeat run failed")
      try {
        await assistant.reportHeartbeatFailure(reason)
      } catch (reportError) {
        logger.error({ err: reportError, reason }, "heartbeat failure report to main session failed")
      }
    } finally {
      running = false
    }
  }

  const startLoop = () => {
    void run()
    setInterval(() => {
      void run()
    }, ms)
  }

  if (startupDelayMs > 0) {
    setTimeout(() => {
      startLoop()
    }, startupDelayMs)
    logger.info({ intervalMinutes, timeoutSeconds, startupDelaySeconds }, "heartbeat scheduler started with delayed first run")
    return
  }

  startLoop()
  logger.info({ intervalMinutes, timeoutSeconds, startupDelaySeconds }, "heartbeat scheduler started")
}
