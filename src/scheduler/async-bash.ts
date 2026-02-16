import { appendFile, open } from "node:fs/promises"
import type { Logger } from "pino"
import { AssistantCore } from "../core/assistant"
import { ensureDir, listFiles, readJson, writeJson } from "../utils/fs"
import { queueOutbox } from "../utils/outbox"
import { dirname, joinPath, resolvePath } from "../utils/path"

type AsyncBashStatus = "queued" | "running" | "completed" | "failed" | "timeout" | "cancelled"

type AsyncBashJob = {
  id: string
  command: string
  workdir?: string
  timeoutMs: number
  createdAt: string
  updatedAt: string
  status: AsyncBashStatus
  channel: "telegram"
  userID: string
  sessionID?: string
  outputFile?: string
  startedAt?: string
  finishedAt?: string
  exitCode?: number | null
  error?: string
  completionNotifiedAt?: string
  progress?: {
    lastReportAt?: string
    lastOutputAt?: string
    totalBytes: number
    totalLines: number
    deltaBytesSinceReport: number
    deltaLinesSinceReport: number
    reportsSent: number
  }
}

type SchedulerOptions = {
  queueDir: string
  concurrency: number
  reportSeconds: number
  defaultTimeoutMs: number
  assistant: AssistantCore
  logger: Logger
}

type RunningState = {
  jobPath: string
  job: AsyncBashJob
  process: ReturnType<typeof Bun.spawn>
  timedOut: boolean
  forceKillTimer?: ReturnType<typeof setTimeout>
  timeoutTimer?: ReturnType<typeof setTimeout>
}

function nowISO(): string {
  return new Date().toISOString()
}

function parseTime(value: string | undefined): number {
  if (!value) return 0
  const ts = Date.parse(value)
  return Number.isFinite(ts) ? ts : 0
}

function countNewlines(input: string): number {
  if (!input) return 0
  let count = 0
  for (let i = 0; i < input.length; i += 1) {
    if (input.charCodeAt(i) === 10) count += 1
  }
  return count
}

function formatDuration(ms: number): string {
  const totalSeconds = Math.max(0, Math.floor(ms / 1000))
  const hours = Math.floor(totalSeconds / 3600)
  const minutes = Math.floor((totalSeconds % 3600) / 60)
  const seconds = totalSeconds % 60
  if (hours > 0) return `${hours}h ${minutes}m ${seconds}s`
  if (minutes > 0) return `${minutes}m ${seconds}s`
  return `${seconds}s`
}

async function readJobs(queueDir: string): Promise<Array<{ path: string; job: AsyncBashJob }>> {
  await ensureDir(queueDir)
  const names = await listFiles(queueDir)
  const jobs: Array<{ path: string; job: AsyncBashJob }> = []
  for (const name of names) {
    if (!name.endsWith(".json")) continue
    const path = joinPath(queueDir, name)
    try {
      const job = await readJson<AsyncBashJob>(path)
      if (!job || typeof job.id !== "string" || typeof job.command !== "string") continue
      jobs.push({ path, job })
    } catch {
      // Ignore malformed files.
    }
  }
  jobs.sort((a, b) => parseTime(a.job.createdAt) - parseTime(b.job.createdAt))
  return jobs
}

async function saveJob(path: string, job: AsyncBashJob): Promise<void> {
  job.updatedAt = nowISO()
  await writeJson(path, job)
}

async function readLogPreview(filePath: string, maxBytes = 8000): Promise<{ text: string; truncated: boolean }> {
  const fh = await open(filePath, "r")
  try {
    const stat = await fh.stat()
    const size = Number(stat.size)
    if (!Number.isFinite(size) || size <= 0) return { text: "", truncated: false }

    if (size <= maxBytes) {
      const buf = Buffer.alloc(size)
      await fh.read(buf, 0, size, 0)
      return { text: buf.toString("utf8"), truncated: false }
    }

    const half = Math.floor(maxBytes / 2)
    const head = Buffer.alloc(half)
    const tail = Buffer.alloc(half)
    await fh.read(head, 0, half, 0)
    await fh.read(tail, 0, half, Math.max(0, size - half))
    return {
      text: `${head.toString("utf8")}\n... [truncated] ...\n${tail.toString("utf8")}`,
      truncated: true,
    }
  } finally {
    await fh.close()
  }
}

async function readLogTail(filePath: string, maxBytes = 1200): Promise<string> {
  const fh = await open(filePath, "r")
  try {
    const stat = await fh.stat()
    const size = Number(stat.size)
    if (!Number.isFinite(size) || size <= 0) return ""
    const bytes = Math.min(size, maxBytes)
    const start = Math.max(0, size - bytes)
    const buf = Buffer.alloc(bytes)
    await fh.read(buf, 0, bytes, start)
    return buf.toString("utf8").trim()
  } finally {
    await fh.close()
  }
}

async function notify(job: AsyncBashJob, text: string, logger: Logger): Promise<void> {
  if (!job.userID) return
  try {
    await queueOutbox({ channel: "telegram", userID: job.userID, text })
  } catch (error) {
    logger.warn({ err: error, jobID: job.id }, "failed to queue async_bash outbox message")
  }
}

function ensureProgress(job: AsyncBashJob): NonNullable<AsyncBashJob["progress"]> {
  if (!job.progress) {
    job.progress = {
      totalBytes: 0,
      totalLines: 0,
      deltaBytesSinceReport: 0,
      deltaLinesSinceReport: 0,
      reportsSent: 0,
    }
  }
  return job.progress
}

function quoteText(text: string): string {
  const normalized = text.trim()
  if (!normalized) return "> <empty>"
  return normalized
    .split(/\r?\n/)
    .map((line) => `> ${line}`)
    .join("\n")
}

export function startAsyncBashScheduler(opts: SchedulerOptions): void {
  const queueDir = resolvePath(opts.queueDir)
  const outputDir = joinPath(queueDir, "output")
  const maxConcurrency = Math.max(1, opts.concurrency)
  const reportMs = Math.max(1, opts.reportSeconds) * 1000
  const running = new Map<string, RunningState>()
  let ticking = false

  const buildAIFeedback = async (job: AsyncBashJob, stage: "progress" | "completion", raw: string): Promise<string> => {
    const prompt = [
      `You are monitoring an async_bash ${stage} update for user ${job.userID}.`,
      "Raw update is provided below.",
      "Decide whether any concise assistant feedback is needed.",
      "Rules:",
      "- Reply in Chinese.",
      "- Keep it short (max 3 bullet points).",
      "- Do not call tools.",
      "- If no additional insight is needed, reply exactly: 无需额外说明。",
      "",
      "Raw update:",
      raw,
    ].join("\n")

    const reply = await opts.assistant.ask({
      channel: "telegram",
      userID: job.userID,
      text: prompt,
    })
    return reply.trim() || "无需额外说明。"
  }

  const notifyWithAIFeedback = async (job: AsyncBashJob, stage: "progress" | "completion", raw: string) => {
    let feedback = "无需额外说明。"
    try {
      feedback = await buildAIFeedback(job, stage, raw)
    } catch (error) {
      opts.logger.warn({ err: error, jobID: job.id, stage }, "async_bash ai feedback failed")
    }
    const text = [
      `[async_bash ${job.id}] ${stage === "progress" ? "进度更新" : "执行完成"}`,
      "引用输出:",
      quoteText(raw),
      "",
      "AI反馈:",
      feedback,
    ].join("\n")
    await notify(job, text, opts.logger)
  }

  const markInterruptedJobs = async () => {
    const jobs = await readJobs(queueDir)
    for (const entry of jobs) {
      if (entry.job.status !== "running") continue
      const job = entry.job
      if (job.completionNotifiedAt) continue
      job.status = "failed"
      job.error = "Worker restarted while command was running."
      job.finishedAt = nowISO()
      job.completionNotifiedAt = nowISO()
      await saveJob(entry.path, job)
      await notifyWithAIFeedback(job, "completion", `[async_bash ${job.id}] Marked failed: worker restarted while job was running.`)
    }
  }

  const startOneJob = async (jobPath: string, job: AsyncBashJob) => {
    await ensureDir(outputDir)

    const outputFile = job.outputFile && job.outputFile.trim().length > 0 ? job.outputFile : joinPath(outputDir, `${job.id}.log`)
    await ensureDir(dirname(outputFile))
    await appendFile(outputFile, `# async_bash ${job.id}\n# started=${nowISO()}\n# command=${job.command}\n\n`)

    job.status = "running"
    job.outputFile = outputFile
    job.startedAt = nowISO()
    const progress = ensureProgress(job)
    progress.lastReportAt = nowISO()
    await saveJob(jobPath, job)

    await notifyWithAIFeedback(
      job,
      "progress",
      `[async_bash ${job.id}] Started. timeout=${job.timeoutMs}ms${job.workdir ? ` workdir=${job.workdir}` : ""}`,
    )

    const proc = Bun.spawn(["bash", "-lc", job.command], {
      cwd: job.workdir && job.workdir.trim().length > 0 ? job.workdir : Bun.cwd,
      stdout: "pipe",
      stderr: "pipe",
    })

    const state: RunningState = {
      jobPath,
      job,
      process: proc,
      timedOut: false,
    }
    running.set(job.id, state)

    const onChunk = async (chunk: Uint8Array) => {
      const text = Buffer.from(chunk).toString("utf8")
      await appendFile(outputFile, text)
      const p = ensureProgress(job)
      const bytes = chunk.byteLength
      const lines = countNewlines(text)
      p.totalBytes += bytes
      p.totalLines += lines
      p.deltaBytesSinceReport += bytes
      p.deltaLinesSinceReport += lines
      p.lastOutputAt = nowISO()
    }

    const pump = async (stream: ReadableStream<Uint8Array> | null | undefined) => {
      if (!stream) return
      const reader = stream.getReader()
      while (true) {
        const next = await reader.read()
        if (next.done) break
        if (!next.value) continue
        await onChunk(next.value)
      }
    }

    const stdoutPump = pump(proc.stdout)
    const stderrPump = pump(proc.stderr)

    state.timeoutTimer = setTimeout(() => {
      state.timedOut = true
      try {
        proc.kill("SIGTERM")
      } catch {
        // Ignore kill errors.
      }
      state.forceKillTimer = setTimeout(() => {
        try {
          proc.kill("SIGKILL")
        } catch {
          // Ignore kill errors.
        }
      }, 5000)
    }, Math.max(1000, job.timeoutMs || opts.defaultTimeoutMs))

    ;(async () => {
      let exitCode: number | null = null
      try {
        await proc.exited
        exitCode = proc.exitCode ?? null
        await Promise.all([stdoutPump, stderrPump])
      } catch (error) {
        job.error = error instanceof Error ? error.message : String(error)
      } finally {
        if (state.timeoutTimer) clearTimeout(state.timeoutTimer)
        if (state.forceKillTimer) clearTimeout(state.forceKillTimer)
      }

      job.exitCode = exitCode
      job.finishedAt = nowISO()

      if (state.timedOut) {
        job.status = "timeout"
        job.error = `Timed out after ${job.timeoutMs}ms`
      } else if (exitCode === 0) {
        job.status = "completed"
      } else {
        job.status = "failed"
      }

      const startedMs = parseTime(job.startedAt)
      const finishedMs = parseTime(job.finishedAt)
      const elapsedMs = startedMs > 0 && finishedMs >= startedMs ? finishedMs - startedMs : 0
      const preview = await readLogPreview(outputFile)
      const previewText = preview.text.trim().slice(0, 4000)

      const completion = [
        `[async_bash ${job.id}] ${job.status}.`,
        `exit=${job.exitCode ?? "null"}, elapsed=${formatDuration(elapsedMs)}.`,
        `log=${outputFile}`,
        preview.truncated ? "output preview is truncated." : "output preview:",
        previewText || "<no output>",
      ].join("\n")

      await notifyWithAIFeedback(job, "completion", completion)

      try {
        await opts.assistant.injectMainContext(
          [
            `[async_bash result] id=${job.id}`,
            `status=${job.status}`,
            `exitCode=${job.exitCode ?? "null"}`,
            `command=${job.command}`,
            `workdir=${job.workdir || Bun.cwd}`,
            `outputFile=${outputFile}`,
            preview.truncated ? "preview=(truncated)" : "preview=(full)",
            previewText || "<no output>",
          ].join("\n"),
        )
      } catch (error) {
        opts.logger.warn({ err: error, jobID: job.id }, "failed to inject async_bash result into session")
      }

      job.completionNotifiedAt = nowISO()
      await saveJob(jobPath, job)
      running.delete(job.id)
      opts.logger.info({ jobID: job.id, status: job.status, exitCode: job.exitCode }, "async_bash job finished")
    })().catch((error) => {
      opts.logger.error({ err: error, jobID: job.id }, "async_bash worker crashed")
      running.delete(job.id)
    })
  }

  const reportRunningJobs = async () => {
    const now = Date.now()
    for (const state of running.values()) {
      const job = state.job
      const progress = ensureProgress(job)
      const lastReportMs = parseTime(progress.lastReportAt)
      if (lastReportMs > 0 && now - lastReportMs < reportMs) continue

      const startedMs = parseTime(job.startedAt)
      const elapsedMs = startedMs > 0 ? now - startedMs : 0
      const lastOutputMs = parseTime(progress.lastOutputAt)
      const outputAge = lastOutputMs > 0 ? formatDuration(now - lastOutputMs) : "n/a"

      const tailText = job.outputFile ? await readLogTail(job.outputFile, 1200) : ""
      const raw = [
        `[async_bash ${job.id}] running ${formatDuration(elapsedMs)}.`,
        `delta_output=${progress.deltaLinesSinceReport} lines, ${progress.deltaBytesSinceReport} bytes in last interval.`,
        `total_output=${progress.totalLines} lines, ${progress.totalBytes} bytes.`,
        `last_output_age=${outputAge}`,
        tailText ? "recent output tail:" : "",
        tailText,
      ].join("\n")

      await notifyWithAIFeedback(job, "progress", raw)

      progress.reportsSent += 1
      progress.lastReportAt = nowISO()
      progress.deltaBytesSinceReport = 0
      progress.deltaLinesSinceReport = 0
      await saveJob(state.jobPath, job)
    }
  }

  const startQueuedJobs = async () => {
    if (running.size >= maxConcurrency) return
    const jobs = await readJobs(queueDir)
    for (const entry of jobs) {
      if (running.size >= maxConcurrency) return
      if (entry.job.status !== "queued") continue
      if (running.has(entry.job.id)) continue
      await startOneJob(entry.path, entry.job)
    }
  }

  const tick = async () => {
    if (ticking) return
    ticking = true
    try {
      await reportRunningJobs()
      await startQueuedJobs()
    } catch (error) {
      opts.logger.warn({ err: error }, "async_bash scheduler tick failed")
    } finally {
      ticking = false
    }
  }

  void (async () => {
    await ensureDir(queueDir)
    await ensureDir(outputDir)
    await markInterruptedJobs()
    await tick()
  })()

  setInterval(() => {
    void tick()
  }, 5000)

  opts.logger.info(
    { queueDir, maxConcurrency, reportSeconds: Math.max(1, opts.reportSeconds) },
    "async_bash scheduler started",
  )
}
