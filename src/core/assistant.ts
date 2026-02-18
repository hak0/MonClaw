import { createOpencodeClient } from "@opencode-ai/sdk"
import { ensureDir, readText, writeText } from "../utils/fs"
import { basename, dirname, relativePath } from "../utils/path"
import { saveLastChannel } from "../utils/last-channel"
import type { Logger } from "pino"
import { MemoryStore } from "../memory/store"
import { SessionStore } from "./session-store"

type AssistantInput = {
  channel: "telegram" | "system"
  userID: string
  text: string
}

export type PermissionReply = "once" | "always" | "reject"

export type PendingPermission = {
  id: string
  sessionID: string
  permission: string
  patterns: string[]
  always: string[]
  metadata?: Record<string, unknown>
}

type PermissionAskedListener = (item: PendingPermission) => void | Promise<void>

export type PendingQuestionOption = {
  label: string
  description: string
}

export type PendingQuestionInfo = {
  question: string
  header: string
  options: PendingQuestionOption[]
  multiple?: boolean
  custom?: boolean
}

export type PendingQuestion = {
  id: string
  sessionID: string
  questions: PendingQuestionInfo[]
  tool?: { messageID: string; callID: string }
}

type QuestionAskedListener = (item: PendingQuestion) => void | Promise<void>

type AssistantOptions = {
  model?: string
  agent?: string
  directory?: string
  serverUrl?: string
  serverUsername?: string
  serverPassword?: string
  heartbeatFile: string
  heartbeatIntervalMinutes: number
  inboxDir: string
  inboxRetentionDays: number
}

type OpencodeClient = ReturnType<typeof createOpencodeClient>

type OpencodeRuntime = {
  client: OpencodeClient
}

function stringifyUnknown(value: unknown): string {
  if (value instanceof Error) return `${value.name}: ${value.message}`
  try {
    return JSON.stringify(value)
  } catch {
    return String(value)
  }
}

function unwrap<T>(value: unknown, label = "OpenCode SDK request"): T {
  if (value && typeof value === "object") {
    const envelope = value as {
      data?: T
      error?: unknown
      response?: { status?: number; statusText?: string }
    }

    if (envelope.error) {
      const status = envelope.response?.status
      const statusText = envelope.response?.statusText
      const statusPart = status ? ` (HTTP ${status}${statusText ? ` ${statusText}` : ""})` : ""
      throw new Error(`${label} failed${statusPart}: ${stringifyUnknown(envelope.error)}`)
    }

    if ("data" in envelope) return envelope.data as T
  }
  return value as T
}

function buildModelConfig(opencodeModel?: string): { providerID: string; modelID: string } | undefined {
  if (!opencodeModel) return undefined
  const [providerID, ...rest] = opencodeModel.split("/")
  if (!providerID || rest.length === 0) return undefined
  return { providerID, modelID: rest.join("/") }
}

async function extractPromptText(result: unknown): Promise<string> {
  const payload = unwrap<Record<string, unknown>>(result)

  const directParts = payload.parts
  if (directParts && typeof directParts === "object" && Symbol.asyncIterator in directParts) {
    const chunks: string[] = []
    for await (const part of directParts as AsyncIterable<Record<string, unknown>>) {
      const text = part.text
      if (typeof text === "string" && text.length > 0) chunks.push(text)
    }
    const merged = chunks.join("").trim()
    if (merged) return merged
  }

  if (Array.isArray(directParts)) {
    const merged = directParts
      .map((p) => (p && typeof p === "object" && typeof (p as { text?: unknown }).text === "string" ? (p as { text: string }).text : ""))
      .join("\n")
      .trim()
    if (merged) return merged
  }

  const message = payload.message
  if (message && typeof message === "object") {
    const msgParts = (message as { parts?: unknown }).parts
    if (Array.isArray(msgParts)) {
      const merged = msgParts
        .map((p) => (p && typeof p === "object" && typeof (p as { text?: unknown }).text === "string" ? (p as { text: string }).text : ""))
        .join("\n")
        .trim()
      if (merged) return merged
    }
  }

  const maybeText = payload.text
  if (typeof maybeText === "string" && maybeText.trim()) return maybeText.trim()

  return "I could not parse the assistant response."
}

const PENDING_INTERACTION_SIGNAL = "__PENDING_INTERACTION__"

type SessionMessage = {
  info?: { id?: string; role?: string }
  parts?: Array<{ type?: string; text?: string }>
}

function toMessages(value: unknown): SessionMessage[] {
  const payload = unwrap<Record<string, unknown>>(value)
  const data = payload.data
  return Array.isArray(data) ? (data as SessionMessage[]) : []
}

function extractTextFromMessage(message: SessionMessage): string {
  const parts = Array.isArray(message.parts) ? message.parts : []
  const text = parts
    .map((part) => (part?.type === "text" && typeof part.text === "string" ? part.text : ""))
    .filter(Boolean)
    .join("\n")
    .trim()
  return text
}

function buildRecentContext(messages: SessionMessage[], limit = 6, maxChars = 2000): string {
  const out: string[] = []
  let remaining = maxChars
  for (let i = messages.length - 1; i >= 0 && out.length < limit; i -= 1) {
    const msg = messages[i]
    const role = msg?.info?.role
    if (!role || (role !== "user" && role !== "assistant")) continue
    const text = extractTextFromMessage(msg)
    if (!text) continue
    const snippet = `${role.toUpperCase()}: ${text}`.trim()
    if (snippet.length > remaining) continue
    out.push(snippet)
    remaining -= snippet.length + 1
  }
  return out.reverse().join("\n")
}

function latestAssistantMessage(messages: SessionMessage[]): SessionMessage | null {
  for (let i = messages.length - 1; i >= 0; i -= 1) {
    if (messages[i]?.info?.role === "assistant") return messages[i]
  }
  return null
}

function assistantSignature(message: SessionMessage | null): string {
  if (!message) return ""
  const id = message.info?.id ?? ""
  const text = extractTextFromMessage(message)
  return `${id}::${text}`
}

function safeString(value: unknown): string | undefined {
  return typeof value === "string" && value.length > 0 ? value : undefined
}


function buildAgentSystemPrompt(memory: string, heartbeatIntervalMinutes: number, inboxDir: string, inboxRetentionDays: number): string {
  return [
    "Runtime context for MonClaw agent:",
    "Treat this as dynamic state injected by the channel bridge.",
    "",
    `Heartbeat interval: ${heartbeatIntervalMinutes} minutes`,
    `Media inbox dir: ${inboxDir}`,
    `Media inbox retention: ${inboxRetentionDays} days`,
    "",
    "Telegram media handling policy:",
    "- Voice/photo uploads may arrive as text prompts that include a local file path under the media inbox.",
    "- When a file path is present, use tools to inspect or transcribe the file before answering.",
    "- For audio files, prefer sherpa-stt for transcription.",
    "- For images, prefer deepseek-ocr to extract visible text, then reason on the extracted text.",
    "- If media parsing fails, explicitly explain the failure and ask the user for plain text.",
    "- Treat media files as temporary operational data; do not store their raw content in long-term memory.",
    "",
    "Durable memory snapshot:",
    memory,
  ].join("\n")
}

async function createRuntime(opts: AssistantOptions): Promise<OpencodeRuntime> {
  if (!opts.serverUrl) {
    throw new Error("Missing OPENCODE_SERVER_URL. This deployment requires a remote OpenCode server.")
  }

  let baseUrl = opts.serverUrl
  const headers: Record<string, string> = {}

  let username = opts.serverUsername ?? ""
  let password = opts.serverPassword ?? ""

  try {
    const parsed = new URL(opts.serverUrl)
    if (!opts.serverUsername && parsed.username) username = decodeURIComponent(parsed.username)
    if (!opts.serverPassword && parsed.password) password = decodeURIComponent(parsed.password)
    if (parsed.username || parsed.password) {
      parsed.username = ""
      parsed.password = ""
      baseUrl = parsed.toString()
    }
  } catch {
    // Keep original URL when parsing fails.
  }

  if (password) {
    const token = Buffer.from(`${username}:${password}`).toString("base64")
    headers.Authorization = `Basic ${token}`
  }

  return {
    client: createOpencodeClient({
      baseUrl,
      ...(opts.directory ? { directory: opts.directory } : {}),
      ...(Object.keys(headers).length > 0 ? { headers } : {}),
    }),
  }
}

export class AssistantCore {
  private runtime?: OpencodeRuntime
  private client?: OpencodeClient
  private readonly modelConfig?: { providerID: string; modelID: string }
  private readonly opts: AssistantOptions
  private readonly pendingPermissions = new Map<string, PendingPermission>()
  private readonly permissionAskedListeners = new Set<PermissionAskedListener>()
  private readonly pendingQuestions = new Map<string, PendingQuestion>()
  private readonly questionAskedListeners = new Set<QuestionAskedListener>()
  private eventAbort?: AbortController

  constructor(
    private readonly logger: Logger,
    private readonly memory: MemoryStore,
    private readonly sessions: SessionStore,
    opts: AssistantOptions,
  ) {
    this.opts = opts
    this.modelConfig = buildModelConfig(opts.model)
  }

  async init(): Promise<void> {
    await this.setupRuntime()
    await this.memory.init()
    await this.sessions.init()
  }

  async ask(input: AssistantInput): Promise<string> {
    const startedAt = Date.now()
    const client = this.ensureClient()
    const sessionID = await this.getOrCreateMainSession()

    if (input.channel === "telegram") {
      await saveLastChannel(input.channel, input.userID)
    }

    const memoryContext = await this.memory.readAll()
    const systemPrompt = buildAgentSystemPrompt(
      memoryContext,
      this.opts.heartbeatIntervalMinutes,
      this.opts.inboxDir,
      this.opts.inboxRetentionDays,
    )

    this.logger.info(
      {
        channel: input.channel,
        userID: input.userID,
        sessionID,
        textLength: input.text.length,
        memoryContextLength: memoryContext.length,
      },
      "assistant request started",
    )

    let beforeAssistantSig = ""
    try {
      const beforeMessagesResult = await client.session.messages({
        path: { id: sessionID },
      } as never)
      const beforeMessages = toMessages(beforeMessagesResult)
      beforeAssistantSig = assistantSignature(latestAssistantMessage(beforeMessages))
    } catch (error) {
      this.logger.warn({ err: error, sessionID }, "assistant preload messages failed")
    }

    let response: unknown
    try {
      response = await client.session.prompt({
        path: { id: sessionID },
        body: {
          noReply: false,
          ...(this.opts.agent ? { agent: this.opts.agent } : {}),
          system: systemPrompt,
          parts: [{ type: "text", text: input.text }],
          ...(this.modelConfig ? { model: this.modelConfig } : {}),
        },
      } as never)
    } catch (error) {
      this.logger.error({ err: error, sessionID }, "assistant prompt call failed")
      throw error
    }

    const parsedText = await extractPromptText(response)
    let assistantText = parsedText
    let usedMessagePolling = false

    if (assistantText === "I could not parse the assistant response.") {
      this.logger.warn({ sessionID }, "assistant response parse failed; polling messages")
      const waitedReply = await this.waitForAssistantReply(sessionID, beforeAssistantSig, true)
      if (waitedReply) {
        if (waitedReply === PENDING_INTERACTION_SIGNAL) {
          assistantText = "I need your input to continue. Please answer the pending approval/question in Telegram, then I will proceed."
        } else {
          assistantText = waitedReply
          usedMessagePolling = true
        }
      }
    }

    if (assistantText === "I could not parse the assistant response.") {
      const diag = await this.buildNoReplyDiagnostic(sessionID)
      this.logger.error(diag, "assistant no-reply diagnostic")
      assistantText = "I did not receive a model reply in time. Please check OpenCode provider auth/model setup."
    }

    this.logger.info(
      {
        channel: input.channel,
        userID: input.userID,
        sessionID,
        durationMs: Date.now() - startedAt,
        usedMessagePolling,
        answerLength: assistantText.length,
      },
      "assistant request completed",
    )

    return assistantText
  }

  async startNewMainSession(reason = "manual"): Promise<string> {
    const sessionID = await this.createSession(`main:${reason}`)
    await this.sessions.setMainSessionID(sessionID)
    this.logger.info({ sessionID, reason }, "created new main session")
    return sessionID
  }

  async remember(note: string, source: string): Promise<void> {
    await this.memory.append(note, source)
  }

  async injectMainContext(text: string): Promise<void> {
    const content = text.trim()
    if (!content) return

    const sessionID = await this.getOrCreateMainSession()
    await this.ensureClient().session.prompt({
      path: { id: sessionID },
      body: {
        noReply: true,
        ...(this.opts.agent ? { agent: this.opts.agent } : {}),
        parts: [{ type: "text", text: content }],
        ...(this.modelConfig ? { model: this.modelConfig } : {}),
      },
      } as never)
  }

  async reportHeartbeatFailure(reason: string): Promise<void> {
    const detail = reason.trim() || "Unknown heartbeat error"
    const mainSessionID = await this.getOrCreateMainSession()
    const client = this.ensureClient()
    const failureSummary = `Heartbeat failed: ${detail}`

    await client.session.prompt({
      path: { id: mainSessionID },
      body: {
        noReply: true,
        ...(this.opts.agent ? { agent: this.opts.agent } : {}),
        parts: [{ type: "text", text: `[Heartbeat summary]\\n${failureSummary}` }],
        ...(this.modelConfig ? { model: this.modelConfig } : {}),
      },
    } as never)

    await client.session.prompt({
      path: { id: mainSessionID },
      body: {
        noReply: false,
        ...(this.opts.agent ? { agent: this.opts.agent } : {}),
        parts: [
          {
            type: "text",
            text: [
              "Heartbeat failure summary was added to context.",
              "Decide whether the user should be proactively informed now.",
              "If yes, call send_channel_message with a concise plain-text message.",
              "If not needed, do nothing.",
            ].join("\n"),
          },
        ],
        ...(this.modelConfig ? { model: this.modelConfig } : {}),
      },
    } as never)

    this.logger.info({ mainSessionID, failureSummary }, "heartbeat failure reported to main session")
  }

  async getMainSessionID(): Promise<string> {
    return this.getOrCreateMainSession()
  }

  async listPendingPermissions(sessionID?: string): Promise<PendingPermission[]> {
    await this.syncPendingPermissions()
    const out = Array.from(this.pendingPermissions.values())
    if (!sessionID) return out
    return out.filter((item) => item.sessionID === sessionID)
  }

  async listPendingQuestions(sessionID?: string): Promise<PendingQuestion[]> {
    await this.syncPendingQuestions()
    const out = Array.from(this.pendingQuestions.values())
    if (!sessionID) return out
    return out.filter((item) => item.sessionID === sessionID)
  }

  async replyPermission(requestID: string, reply: PermissionReply, message?: string, sessionID?: string): Promise<void> {
    const client = this.ensureClient() as any

    if (client.permission?.reply) {
      await client.permission.reply({
        requestID,
        reply,
        ...(message ? { message } : {}),
      })
      return
    }

    try {
      await client._client.post({
        url: "/permission/{requestID}/reply",
        path: { requestID },
        body: {
          reply,
          ...(message ? { message } : {}),
        },
      })
      return
    } catch {
      // Fall through to deprecated endpoint below.
    }

    if (!sessionID) {
      throw new Error("sessionID is required for permission reply fallback")
    }

    await client.postSessionIdPermissionsPermissionId({
      path: { id: sessionID, permissionID: requestID },
      body: {
        response: reply,
      },
    })
    this.pendingPermissions.delete(requestID)
  }

  async replyQuestion(requestID: string, answers: Array<Array<string>>): Promise<void> {
    const client = this.ensureClient() as any

    if (client.question?.reply) {
      await client.question.reply({ requestID, answers })
      this.pendingQuestions.delete(requestID)
      return
    }

    await client._client.post({
      url: "/question/{requestID}/reply",
      path: { requestID },
      body: { answers },
    })
    this.pendingQuestions.delete(requestID)
  }

  async rejectQuestion(requestID: string): Promise<void> {
    const client = this.ensureClient() as any

    if (client.question?.reject) {
      await client.question.reject({ requestID })
      this.pendingQuestions.delete(requestID)
      return
    }

    await client._client.post({
      url: "/question/{requestID}/reject",
      path: { requestID },
    })
    this.pendingQuestions.delete(requestID)
  }

  onPermissionAsked(listener: PermissionAskedListener): () => void {
    this.permissionAskedListeners.add(listener)
    return () => {
      this.permissionAskedListeners.delete(listener)
    }
  }

  onQuestionAsked(listener: QuestionAskedListener): () => void {
    this.questionAskedListeners.add(listener)
    return () => {
      this.questionAskedListeners.delete(listener)
    }
  }

  async getLatestAssistantSignature(sessionID: string): Promise<string> {
    const messages = await this.ensureClient().session.messages({ path: { id: sessionID } } as never)
    return assistantSignature(latestAssistantMessage(toMessages(messages)))
  }

  async waitForAssistantAfter(sessionID: string, beforeAssistantSig: string): Promise<string | null> {
    return this.waitForAssistantReply(sessionID, beforeAssistantSig)
  }

  async heartbeatTaskStatus(): Promise<{ file: string; taskCount: number; empty: boolean }> {
    const file = this.opts.heartbeatFile
    const tasks = await this.loadHeartbeatTasks()
    return { file: relativePath(Bun.cwd, file) || basename(file), taskCount: tasks.length, empty: tasks.length === 0 }
  }

  async runHeartbeatTasks(): Promise<string> {
    const startedAt = Date.now()
    const tasks = await this.loadHeartbeatTasks()
    if (tasks.length === 0) {
      return "Heartbeat skipped: heartbeat.md has no tasks."
    }

    const heartbeatSessionID = await this.getOrCreateHeartbeatSession()
    const mainSessionID = await this.getOrCreateMainSession()
    this.logger.info({ heartbeatSessionID, mainSessionID, taskCount: tasks.length }, "heartbeat sessions ready")
    const client = this.ensureClient()

    const memoryContext = await this.memory.readAll()
    const systemPrompt = buildAgentSystemPrompt(
      memoryContext,
      this.opts.heartbeatIntervalMinutes,
      this.opts.inboxDir,
      this.opts.inboxRetentionDays,
    )

    let recentContext = ""
    try {
      const mainMessagesResult = await client.session.messages({ path: { id: mainSessionID } } as never)
      recentContext = buildRecentContext(toMessages(mainMessagesResult))
    } catch (error) {
      this.logger.warn({ err: error, mainSessionID }, "heartbeat main-session context load failed")
    }

    let beforeAssistantSig = ""
    try {
      const beforeMessagesResult = await client.session.messages({ path: { id: heartbeatSessionID } } as never)
      beforeAssistantSig = assistantSignature(latestAssistantMessage(toMessages(beforeMessagesResult)))
    } catch (error) {
      this.logger.warn({ err: error, heartbeatSessionID }, "heartbeat preload messages failed")
    }
    const prompt = [
      "Run these recurring cron tasks for the project.",
      "Return concise actionable bullet points with findings and next actions.",
      "This is routine task execution, not a healthcheck.",
      "If nothing requires action, explicitly say no action is needed.",
      "",
      recentContext ? "Recent main session context:" : "",
      recentContext,
      recentContext ? "" : "",
      "Task list:",
      ...tasks.map((t, i) => `${i + 1}. ${t}`),
    ].join("\n")

    let response: unknown
    try {
      response = await client.session.prompt({
        path: { id: heartbeatSessionID },
        body: {
          noReply: false,
          ...(this.opts.agent ? { agent: this.opts.agent } : {}),
          system: systemPrompt,
          parts: [{ type: "text", text: prompt }],
          ...(this.modelConfig ? { model: this.modelConfig } : {}),
        },
      } as never)
    } catch (error) {
      this.logger.error({ err: error, heartbeatSessionID }, "heartbeat prompt call failed")
      throw error
    }

    let summary = await extractPromptText(response)
    if (summary === "I could not parse the assistant response.") {
      this.logger.warn({ heartbeatSessionID }, "heartbeat response parse failed; polling messages")
      summary = (await this.waitForAssistantReply(heartbeatSessionID, beforeAssistantSig)) ?? ""
    }
    if (!summary) {
      return "Heartbeat failed: no summary reply from model."
    }

    try {
      await client.session.prompt({
        path: { id: mainSessionID },
        body: {
          noReply: true,
          ...(this.opts.agent ? { agent: this.opts.agent } : {}),
          parts: [{ type: "text", text: `[Heartbeat summary]\\n${summary}` }],
          ...(this.modelConfig ? { model: this.modelConfig } : {}),
        },
      } as never)
    } catch (error) {
      this.logger.error({ err: error, mainSessionID }, "heartbeat summary injection failed")
      throw error
    }

    try {
      await client.session.prompt({
        path: { id: mainSessionID },
        body: {
          noReply: false,
          ...(this.opts.agent ? { agent: this.opts.agent } : {}),
          parts: [
            {
              type: "text",
              text: [
                "Heartbeat summary was added to context.",
                "Decide whether the user should be proactively informed now.",
                "If yes, call send_channel_message with a concise plain-text message.",
                "If not needed, do nothing.",
              ].join("\n"),
            },
          ],
          ...(this.modelConfig ? { model: this.modelConfig } : {}),
        },
      } as never)
    } catch (error) {
      this.logger.error({ err: error, mainSessionID }, "heartbeat notify prompt failed")
      throw error
    }

    this.logger.info({ heartbeatSessionID, mainSessionID, taskCount: tasks.length, durationMs: Date.now() - startedAt }, "heartbeat task run complete")
    return `Heartbeat completed with ${tasks.length} tasks.`
  }

  async close(): Promise<void> {
    this.eventAbort?.abort()
    this.eventAbort = undefined
    // No local OpenCode runtime is spawned in remote-only mode.
  }

  private async createSession(key: string): Promise<string> {
    const client = this.ensureClient()
    const session = await client.session.create({
      body: { title: `chat:${key}` },
    } as never)

    const payload = unwrap<Record<string, unknown>>(session, "session.create")
    const id = payload.id
    if (typeof id !== "string" || id.length === 0) {
      throw new Error(`Failed to create session: missing id in payload ${JSON.stringify(payload)}`)
    }

    this.logger.info({ key, sessionID: id }, "created OpenCode session")
    return id
  }

  private async getOrCreateMainSession(): Promise<string> {
    const existing = this.sessions.getMainSessionID()
    if (existing) return existing
    const created = await this.createSession("main")
    await this.sessions.setMainSessionID(created)
    return created
  }

  private async getOrCreateHeartbeatSession(): Promise<string> {
    const existing = this.sessions.getHeartbeatSessionID()
    if (existing) return existing
    const created = await this.createSession("heartbeat")
    await this.sessions.setHeartbeatSessionID(created)
    return created
  }

  private async waitForAssistantReply(sessionID: string, beforeAssistantSig: string, stopOnPendingInteraction = false): Promise<string | null> {
    const timeoutMs = 60_000
    const intervalMs = 700
    const endAt = Date.now() + timeoutMs
    let pollCount = 0

    while (Date.now() < endAt) {
      pollCount += 1
      try {
        const messagesResult = await this.ensureClient().session.messages({
          path: { id: sessionID },
        } as never)
        const messages = toMessages(messagesResult)
        const latestAssistant = latestAssistantMessage(messages)
        const nextSig = assistantSignature(latestAssistant)
        if (latestAssistant && nextSig !== beforeAssistantSig) {
          const text = extractTextFromMessage(latestAssistant)
          if (text.length > 0) return text
        }
        if (pollCount % 5 === 0) {
          this.logger.info(
            { sessionID, pollCount, currentCount: messages.length },
            "waiting for assistant reply",
          )
        }

        if (stopOnPendingInteraction && pollCount % 3 === 0) {
          const hasPending = await this.hasPendingInteraction(sessionID)
          if (hasPending) {
            this.logger.info({ sessionID, pollCount }, "assistant reply wait stopped by pending interaction")
            return PENDING_INTERACTION_SIGNAL
          }
        }
      } catch (error) {
        this.logger.warn({ err: error, sessionID, pollCount }, "polling assistant reply failed")
      }
      await new Promise((resolve) => setTimeout(resolve, intervalMs))
    }

    this.logger.warn({ sessionID, timeoutMs }, "assistant reply polling timed out")
    return null
  }

  private async hasPendingInteraction(sessionID: string): Promise<boolean> {
    const client = this.ensureClient() as any

    try {
      if (client.permission?.list) {
        const permissionsResult = await client.permission.list({})
        const permissions = unwrap<unknown>(permissionsResult)
        if (
          Array.isArray(permissions) &&
          permissions.some((item) => item && typeof item === "object" && (item as Record<string, unknown>).sessionID === sessionID)
        ) {
          return true
        }
      }
    } catch (error) {
      this.logger.debug({ err: error, sessionID }, "pending permission check failed")
    }

    try {
      if (client.question?.list) {
        const questionsResult = await client.question.list({})
        const questions = unwrap<unknown>(questionsResult)
        if (
          Array.isArray(questions) &&
          questions.some((item) => item && typeof item === "object" && (item as Record<string, unknown>).sessionID === sessionID)
        ) {
          return true
        }
      }
    } catch (error) {
      this.logger.debug({ err: error, sessionID }, "pending question check failed")
    }

    return false
  }

  private async buildNoReplyDiagnostic(sessionID: string): Promise<Record<string, unknown>> {
    const client = this.ensureClient()
    const out: Record<string, unknown> = { sessionID }

    try {
      const statusResult = await client.session.status({} as never)
      const statusData = unwrap<Record<string, unknown>>(statusResult)
      out.sessionStatus = statusData[sessionID] ?? null
    } catch (error) {
      out.sessionStatusError = error instanceof Error ? error.message : String(error)
    }

    try {
      const configResult = await client.config.get({} as never)
      const config = unwrap<Record<string, unknown>>(configResult)
      out.configModel = safeString(config.model) ?? null
    } catch (error) {
      out.configError = error instanceof Error ? error.message : String(error)
    }

    try {
      const providers = await client.provider.list({} as never)
      const providerData = unwrap<Record<string, unknown>>(providers)
      out.connectedProviders = Array.isArray(providerData.connected) ? providerData.connected : []
      out.defaultProviders = providerData.default ?? null
    } catch (error) {
      out.providerError = error instanceof Error ? error.message : String(error)
    }

    try {
      const msgs = await client.session.messages({ path: { id: sessionID } } as never)
      const list = toMessages(msgs)
      out.messageCount = list.length
      out.lastRole = list.length > 0 ? list[list.length - 1]?.info?.role ?? null : null
    } catch (error) {
      out.messagesError = error instanceof Error ? error.message : String(error)
    }

    return out
  }

  private async setupRuntime(): Promise<void> {
    if (this.client) return
    this.runtime = await createRuntime(this.opts)
    this.client = this.runtime.client
    this.logger.info("using configured remote OpenCode server")
    this.startEventStream()
  }

  private startEventStream(): void {
    if (!this.client || this.eventAbort) return
    this.eventAbort = new AbortController()

    const run = async () => {
      while (!this.eventAbort?.signal.aborted) {
        try {
          const sse = await (this.ensureClient() as any).event.subscribe({
            signal: this.eventAbort?.signal,
          })
          for await (const event of sse.stream) {
            this.handleEvent(event)
            if (this.eventAbort?.signal.aborted) break
          }
        } catch (error) {
          if (this.eventAbort?.signal.aborted) break
          this.logger.warn({ err: error }, "assistant event stream failed; retrying")
          await new Promise((resolve) => setTimeout(resolve, 1000))
        }
      }
    }

    void run()
  }

  private handleEvent(rawEvent: unknown): void {
    const payload = rawEvent && typeof rawEvent === "object" && "payload" in (rawEvent as Record<string, unknown>)
      ? (rawEvent as { payload: unknown }).payload
      : rawEvent

    if (!payload || typeof payload !== "object") return
    const event = payload as { type?: unknown; properties?: unknown }
    if (typeof event.type !== "string") return

    if (event.type === "permission.updated" || event.type === "permission.asked") {
      const mapped = this.mapPermissionFromEvent(event.properties)
      if (!mapped) return
      this.pendingPermissions.set(mapped.id, mapped)
      for (const listener of this.permissionAskedListeners) {
        void Promise.resolve(listener(mapped)).catch((err) => {
          this.logger.warn({ err }, "permission listener failed")
        })
      }
      return
    }

    if (event.type === "permission.replied") {
      const p = event.properties as Record<string, unknown> | undefined
      const requestID = typeof p?.permissionID === "string" ? p.permissionID : typeof p?.requestID === "string" ? p.requestID : ""
      if (requestID) this.pendingPermissions.delete(requestID)
      return
    }

    if (event.type === "question.asked") {
      const mapped = this.mapQuestionFromEvent(event.properties)
      if (!mapped) return
      this.pendingQuestions.set(mapped.id, mapped)
      for (const listener of this.questionAskedListeners) {
        void Promise.resolve(listener(mapped)).catch((err) => {
          this.logger.warn({ err }, "question listener failed")
        })
      }
      return
    }

    if (event.type === "question.replied" || event.type === "question.rejected") {
      const p = event.properties as Record<string, unknown> | undefined
      const requestID = typeof p?.requestID === "string" ? p.requestID : ""
      if (requestID) this.pendingQuestions.delete(requestID)
    }
  }

  private mapPermissionFromEvent(properties: unknown): PendingPermission | null {
    if (!properties || typeof properties !== "object") return null
    const p = properties as Record<string, unknown>
    const id = typeof p.id === "string" ? p.id : ""
    const sessionID = typeof p.sessionID === "string" ? p.sessionID : ""
    const permission =
      typeof p.permission === "string" ? p.permission : typeof p.type === "string" ? p.type : "permission"
    if (!id || !sessionID) return null

    const patternRaw = p.patterns ?? p.pattern
    const patterns = Array.isArray(patternRaw)
      ? patternRaw.filter((x): x is string => typeof x === "string")
      : typeof patternRaw === "string"
        ? [patternRaw]
        : []

    const always = Array.isArray(p.always) ? p.always.filter((x): x is string => typeof x === "string") : []
    const metadata = p.metadata && typeof p.metadata === "object" ? (p.metadata as Record<string, unknown>) : undefined

    return { id, sessionID, permission, patterns, always, metadata }
  }

  private mapQuestionFromEvent(properties: unknown): PendingQuestion | null {
    if (!properties || typeof properties !== "object") return null
    const p = properties as Record<string, unknown>
    const id = typeof p.id === "string" ? p.id : ""
    const sessionID = typeof p.sessionID === "string" ? p.sessionID : ""
    if (!id || !sessionID) return null

    const rawQuestions = Array.isArray(p.questions) ? p.questions : []
    const questions: PendingQuestionInfo[] = []
    for (const rawQuestion of rawQuestions) {
      if (!rawQuestion || typeof rawQuestion !== "object") continue
      const q = rawQuestion as Record<string, unknown>
      const question = typeof q.question === "string" ? q.question : ""
      const header = typeof q.header === "string" ? q.header : ""
      const multiple = typeof q.multiple === "boolean" ? q.multiple : undefined
      const custom = typeof q.custom === "boolean" ? q.custom : undefined
      const optionsRaw = Array.isArray(q.options) ? q.options : []
      const options: PendingQuestionOption[] = []
      for (const rawOption of optionsRaw) {
        if (!rawOption || typeof rawOption !== "object") continue
        const option = rawOption as Record<string, unknown>
        const label = typeof option.label === "string" ? option.label : ""
        const description = typeof option.description === "string" ? option.description : ""
        if (!label) continue
        options.push({ label, description })
      }
      if (!question || !header) continue
      questions.push({ question, header, options, multiple, custom })
    }

    const rawTool = p.tool
    const tool =
      rawTool && typeof rawTool === "object"
        ? {
            messageID: typeof (rawTool as Record<string, unknown>).messageID === "string" ? (rawTool as Record<string, unknown>).messageID as string : "",
            callID: typeof (rawTool as Record<string, unknown>).callID === "string" ? (rawTool as Record<string, unknown>).callID as string : "",
          }
        : undefined

    const normalizedTool = tool && tool.messageID && tool.callID ? tool : undefined
    return { id, sessionID, questions, tool: normalizedTool }
  }

  private ensureClient(): OpencodeClient {
    if (!this.client) {
      throw new Error("AssistantCore is not initialized. Call init() before ask()/heartbeat().")
    }
    return this.client
  }

  private async syncPendingPermissions(): Promise<void> {
    const client = this.ensureClient() as any
    if (!client.permission?.list) return
    try {
      const result = await client.permission.list({})
      const list = unwrap<unknown>(result)
      if (!Array.isArray(list)) return
      this.pendingPermissions.clear()
      for (const item of list) {
        const mapped = this.mapPermissionFromEvent(item)
        if (!mapped) continue
        this.pendingPermissions.set(mapped.id, mapped)
      }
    } catch (error) {
      this.logger.warn({ err: error }, "sync pending permissions failed")
    }
  }

  private async syncPendingQuestions(): Promise<void> {
    const client = this.ensureClient() as any
    if (!client.question?.list) return
    try {
      const result = await client.question.list({})
      const list = unwrap<unknown>(result)
      if (!Array.isArray(list)) return
      this.pendingQuestions.clear()
      for (const item of list) {
        const mapped = this.mapQuestionFromEvent(item)
        if (!mapped) continue
        this.pendingQuestions.set(mapped.id, mapped)
      }
    } catch (error) {
      this.logger.warn({ err: error }, "sync pending questions failed")
    }
  }

  private async loadHeartbeatTasks(): Promise<string[]> {
    const file = this.opts.heartbeatFile
    await ensureDir(dirname(file))
    try {
      await readText(file)
    } catch {
      await writeText(file, "")
      return []
    }

    const content = await readText(file)
    return content
      .split(/\r?\n/)
      .map((line) => line.trim())
      .filter((line) => line.length > 0 && !line.startsWith("#"))
      .map((line) => line.replace(/^[-*]\s+/, ""))
      .filter((line) => line.length > 0)
  }

}
