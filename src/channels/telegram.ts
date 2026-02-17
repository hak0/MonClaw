import { Bot, InlineKeyboard } from "grammy"
import type { Logger } from "pino"
import { AssistantCore, type PendingPermission, type PendingQuestion, type PermissionReply } from "../core/assistant"
import { PairAttemptStore } from "../core/pair-attempt-store"
import { WhitelistStore } from "../core/whitelist-store"
import { splitTextChunks } from "../utils/format-message"
import { pruneInbox, saveInboxBinary, type InboxKind } from "../utils/inbox"
import { ackOutbox, listOutbox } from "../utils/outbox"

type TelegramAdapterOptions = {
  token: string
  logger: Logger
  assistant: AssistantCore
  whitelist: WhitelistStore
  pairAttempts: PairAttemptStore
  pairToken?: string
  pairMaxAttempts: number
  pairLockMinutes: number
  inboxDir: string
  inboxRetentionDays: number
}

function whitelistInstruction(userID: string, filePath: string): string {
  return [
    "Access restricted.",
    `Your Telegram ID: ${userID}`,
    "Send /pair <token> to whitelist yourself.",
    `If you don't have a token, ask admin to add you under 'telegram' in ${filePath}.`,
  ].join("\n")
}

function encodeApprovalAction(action: PermissionReply, requestID: string): string {
  const kind = action === "once" ? "o" : action === "always" ? "a" : "r"
  return `apr:${kind}:${requestID}`
}

function decodeApprovalAction(data: string): { action: PermissionReply; requestID: string } | null {
  const parts = data.split(":")
  if (parts.length !== 3 || parts[0] !== "apr") return null
  const action = parts[1] === "o" ? "once" : parts[1] === "a" ? "always" : parts[1] === "r" ? "reject" : null
  if (!action) return null
  const requestID = parts[2]?.trim()
  if (!requestID) return null
  return { action, requestID }
}

function encodeQuestionAction(requestID: string, questionIndex: number, optionIndex: number): string {
  return `qst:${requestID}:${questionIndex}:${optionIndex}`
}

function decodeQuestionAction(data: string): { requestID: string; questionIndex: number; optionIndex: number } | null {
  const parts = data.split(":")
  if (parts.length !== 4 || parts[0] !== "qst") return null
  const requestID = parts[1]?.trim()
  const questionIndex = Number.parseInt(parts[2] ?? "", 10)
  const optionIndex = Number.parseInt(parts[3] ?? "", 10)
  if (!requestID || !Number.isFinite(questionIndex) || !Number.isFinite(optionIndex)) return null
  if (questionIndex < 0 || optionIndex < 0) return null
  return { requestID, questionIndex, optionIndex }
}

function approvalKeyboard(requestID: string): InlineKeyboard {
  return new InlineKeyboard()
    .text("Allow once", encodeApprovalAction("once", requestID))
    .text("Always allow", encodeApprovalAction("always", requestID))
    .row()
    .text("Reject", encodeApprovalAction("reject", requestID))
}

function questionKeyboard(requestID: string, question: PendingQuestion["questions"][number], questionIndex: number): InlineKeyboard {
  const keyboard = new InlineKeyboard()
  for (let i = 0; i < question.options.length; i += 1) {
    keyboard.text(question.options[i].label, encodeQuestionAction(requestID, questionIndex, i)).row()
  }
  return keyboard
}

function formatPermissionLine(item: PendingPermission): string {
  const patterns = item.patterns.length > 0 ? item.patterns.join(", ") : "<none>"
  return [`Permission: ${item.permission}`, `Patterns: ${patterns}`, `Request ID: ${item.id}`].join("\n")
}

function formatQuestionLine(item: PendingQuestion, index: number): string {
  const q = item.questions[index]
  if (!q) return `Question request: ${item.id}`
  const mode = q.multiple ? "multiple" : "single"
  return [
    `Question: ${q.header}`,
    q.question,
    `Mode: ${mode}`,
    `Request ID: ${item.id}`,
  ].join("\n")
}

function canUseInlineQuestion(item: PendingQuestion): boolean {
  if (item.questions.length !== 1) return false
  const q = item.questions[0]
  if (!q || q.multiple) return false
  return q.options.length > 0
}

function parseQuestionAnswers(raw: string): Array<Array<string>> {
  return raw
    .split(";")
    .map((group) => group.split(",").map((part) => part.trim()).filter(Boolean))
}

function pickFileExtension(filePath: string | undefined, fallback: string): string {
  if (!filePath) return fallback
  const match = filePath.match(/(\.[A-Za-z0-9]+)$/)
  if (!match) return fallback
  return match[1]
}

async function downloadTelegramFile(token: string, filePath: string): Promise<Uint8Array> {
  const url = `https://api.telegram.org/file/bot${token}/${filePath}`
  const response = await fetch(url)
  if (!response.ok) {
    throw new Error(`telegram file download failed: HTTP ${response.status}`)
  }
  const buffer = await response.arrayBuffer()
  return new Uint8Array(buffer)
}

function buildMediaPrompt(params: { kind: InboxKind; filePath: string; caption: string }): string {
  const header =
    params.kind === "voice"
      ? "User sent a Telegram voice message."
      : "User sent a Telegram image upload."
  const captionLine = params.caption ? `Caption: ${params.caption}` : "Caption: <none>"
  return [
    header,
    `Saved file path: ${params.filePath}`,
    captionLine,
    "Handle this request using available tools and local files.",
    "If you cannot parse this media type, clearly tell the user and ask for plain text.",
  ].join("\n")
}

export async function startTelegramAdapter(opts: TelegramAdapterOptions): Promise<void> {
  const bot = new Bot(opts.token)
  let flushingOutbox = false
  let pruningInbox = false
  const inboxMaxAgeMs = Math.max(1, opts.inboxRetentionDays) * 24 * 60 * 60 * 1000
  const activeChats = new Set<number>()
  const activeSessionRequests = new Map<string, { chatID: number; userID: string }>()
  const announcedPermissionIDs = new Set<string>()
  const announcedQuestionIDs = new Set<string>()

  const showPendingApprovals = async (ctx: { reply: (text: string, extra?: any) => Promise<unknown> }, userID: string) => {
    const allowed = opts.whitelist.isWhitelisted("telegram", userID)
    if (!allowed) {
      await ctx.reply(whitelistInstruction(userID, opts.whitelist.displayFile()))
      return { permissionCount: 0, questionCount: 0 }
    }

    const sessionID = await opts.assistant.getMainSessionID()
    const pending = await opts.assistant.listPendingPermissions(sessionID)
    const pendingQuestions = await opts.assistant.listPendingQuestions(sessionID)

    for (const item of pending) {
      await ctx.reply(formatPermissionLine(item), {
        reply_markup: approvalKeyboard(item.id),
      })
      announcedPermissionIDs.add(item.id)
    }

    for (const item of pendingQuestions) {
      announcedQuestionIDs.add(item.id)
      if (canUseInlineQuestion(item)) {
        const q = item.questions[0]
        await ctx.reply(formatQuestionLine(item, 0), {
          reply_markup: questionKeyboard(item.id, q, 0),
        })
        continue
      }
      for (let i = 0; i < item.questions.length; i += 1) {
        await ctx.reply(formatQuestionLine(item, i))
      }
      await ctx.reply(["Reply with /answer <requestID> <answers>.", "For multiple questions use ';' between questions and ',' between labels."].join("\n"))
    }

    if (pending.length === 0 && pendingQuestions.length === 0) {
      await ctx.reply("No pending approvals or questions for the current session.")
    }

    return { permissionCount: pending.length, questionCount: pendingQuestions.length }
  }

  const notifyPendingApproval = async (item: PendingPermission) => {
    if (announcedPermissionIDs.has(item.id)) return
    const target = activeSessionRequests.get(item.sessionID)
    if (!target) return

    announcedPermissionIDs.add(item.id)
    await bot.api.sendMessage(target.chatID, formatPermissionLine(item), {
      reply_markup: approvalKeyboard(item.id),
    })
    await bot.api.sendMessage(target.chatID, "OpenCode is waiting for approval. Tap a button above or run /approvals.")
  }

  const notifyPendingQuestion = async (item: PendingQuestion) => {
    if (announcedQuestionIDs.has(item.id)) return
    const target = activeSessionRequests.get(item.sessionID)
    if (!target) return

    announcedQuestionIDs.add(item.id)
    if (canUseInlineQuestion(item)) {
      const q = item.questions[0]
      await bot.api.sendMessage(target.chatID, formatQuestionLine(item, 0), {
        reply_markup: questionKeyboard(item.id, q, 0),
      })
      await bot.api.sendMessage(target.chatID, "OpenCode needs your choice. Tap an option above.")
      return
    }

    await bot.api.sendMessage(
      target.chatID,
      [
        ...item.questions.map((_, i) => formatQuestionLine(item, i)),
        "OpenCode needs your answer.",
        "Reply with /answer <requestID> <answers>.",
        "For multiple questions use ';' between questions and ',' between labels.",
      ].join("\n"),
    )
  }

  opts.assistant.onPermissionAsked((item) => {
    void notifyPendingApproval(item).catch((error) => {
      opts.logger.warn({ err: error, sessionID: item.sessionID, permissionID: item.id }, "failed to notify pending approval")
    })
  })

  opts.assistant.onQuestionAsked((item) => {
    void notifyPendingQuestion(item).catch((error) => {
      opts.logger.warn({ err: error, sessionID: item.sessionID, requestID: item.id }, "failed to notify pending question")
    })
  })

  const flushOutbox = async () => {
    if (flushingOutbox) return
    flushingOutbox = true
    try {
      const pending = await listOutbox("telegram")
      for (const item of pending) {
        const chunks = splitTextChunks(item.message.text, 3000)
        for (const chunk of chunks) {
          await bot.api.sendMessage(item.message.userID, chunk)
        }
        await ackOutbox(item.filePath)
        opts.logger.info({ userID: item.message.userID, chunkCount: chunks.length }, "telegram proactive message sent")
      }
    } catch (error) {
      opts.logger.warn({ err: error }, "telegram outbox flush failed")
    } finally {
      flushingOutbox = false
    }
  }

  const pruneInboxFiles = async () => {
    if (pruningInbox) return
    pruningInbox = true
    try {
      const result = await pruneInbox(opts.inboxDir, inboxMaxAgeMs)
      if (result.deleted > 0) {
        opts.logger.info({ deleted: result.deleted, kept: result.kept, inboxDir: opts.inboxDir }, "telegram inbox pruned")
      }
    } catch (error) {
      opts.logger.warn({ err: error, inboxDir: opts.inboxDir }, "telegram inbox prune failed")
    } finally {
      pruningInbox = false
    }
  }

  const continueAfterUserInput = (params: { chatID: number; userID: string; sessionID: string; beforeAssistantSig: string; source: string }) => {
    void (async () => {
      try {
        const text = await opts.assistant.waitForAssistantAfter(params.sessionID, params.beforeAssistantSig)
        if (!text) return
        const chunks = splitTextChunks(text, 3000)
        for (const chunk of chunks) {
          await bot.api.sendMessage(params.chatID, chunk)
        }
        opts.logger.info(
          {
            chatID: params.chatID,
            userID: params.userID,
            sessionID: params.sessionID,
            source: params.source,
            answerLength: text.length,
            chunkCount: chunks.length,
          },
          "telegram follow-up reply sent",
        )
      } catch (error) {
        opts.logger.warn(
          { err: error, chatID: params.chatID, userID: params.userID, sessionID: params.sessionID, source: params.source },
          "telegram follow-up reply failed",
        )
      }
    })()
  }

  bot.command("start", async (ctx) => {
    const userID = String(ctx.from?.id ?? ctx.chat.id)
    const allowed = opts.whitelist.isWhitelisted("telegram", userID)
    opts.logger.info({ chatID: ctx.chat.id, userID, allowed }, "telegram /start")
    if (!allowed) {
      await ctx.reply(whitelistInstruction(userID, opts.whitelist.displayFile()))
      return
    }
    await ctx.reply("MonClaw is online. Try /remember <note>.")
  })

  bot.command("pair", async (ctx) => {
    const userID = String(ctx.from?.id ?? ctx.chat.id)
    const token = ctx.match?.toString().trim() ?? ""

    const state = await opts.pairAttempts.getState("telegram", userID)
    if (state.isLocked) {
      opts.logger.warn({ userID, failedCount: state.failedCount, lockedUntil: state.lockedUntil }, "telegram pair locked")
      await ctx.reply("Too many failed attempts. Please try again later.")
      return
    }

    if (!opts.pairToken) {
      await ctx.reply("Pairing is disabled by admin. Ask admin to whitelist your account.")
      return
    }
    if (!token) {
      await ctx.reply("Usage: /pair <token>")
      return
    }
    if (token !== opts.pairToken) {
      const next = await opts.pairAttempts.recordFailure("telegram", userID, opts.pairMaxAttempts, opts.pairLockMinutes)
      opts.logger.warn(
        { userID, failedCount: next.failedCount, isLocked: next.isLocked, lockedUntil: next.lockedUntil },
        "telegram pair token mismatch",
      )
      if (next.isLocked) {
        await ctx.reply("Too many failed attempts. Please try again later.")
        return
      }
      await ctx.reply("Invalid pairing token.")
      return
    }

    await opts.pairAttempts.clear("telegram", userID)
    const created = await opts.whitelist.add("telegram", userID)
    opts.logger.info({ userID, created }, "telegram pairing")
    await ctx.reply(created ? "Pairing successful. You are now whitelisted." : "You are already whitelisted.")
  })

  bot.command("new", async (ctx) => {
    const userID = String(ctx.from?.id ?? ctx.chat.id)
    const allowed = opts.whitelist.isWhitelisted("telegram", userID)
    if (!allowed) {
      await ctx.reply(whitelistInstruction(userID, opts.whitelist.displayFile()))
      return
    }
    const sessionID = await opts.assistant.startNewMainSession(`telegram:${userID}`)
    await ctx.reply(`Started new shared session: ${sessionID}`)
  })

  bot.command("remember", async (ctx) => {
    const userID = String(ctx.from?.id ?? ctx.chat.id)
    const allowed = opts.whitelist.isWhitelisted("telegram", userID)
    opts.logger.info({ chatID: ctx.chat.id, userID, allowed }, "telegram /remember")
    if (!allowed) {
      await ctx.reply(whitelistInstruction(userID, opts.whitelist.displayFile()))
      return
    }
    const text = ctx.match?.toString().trim() ?? ""
    if (!text) {
      await ctx.reply("Usage: /remember <text>")
      return
    }

    const source = `telegram:${userID}`
    await opts.assistant.remember(text, source)
    await ctx.reply("Saved to long-term memory.")
  })

  bot.command("approvals", async (ctx) => {
    const userID = String(ctx.from?.id ?? ctx.chat.id)
    const counts = await showPendingApprovals(ctx, userID)
    opts.logger.info({ chatID: ctx.chat.id, userID, ...counts }, "telegram /approvals")
  })

  bot.command("approval", async (ctx) => {
    const userID = String(ctx.from?.id ?? ctx.chat.id)
    const counts = await showPendingApprovals(ctx, userID)
    opts.logger.info({ chatID: ctx.chat.id, userID, ...counts }, "telegram /approval")
  })

  bot.command("answer", async (ctx) => {
    const userID = String(ctx.from?.id ?? ctx.chat.id)
    const chatID = ctx.chat?.id
    if (!chatID) {
      await ctx.reply("Could not determine chat target for this answer.")
      return
    }
    const allowed = opts.whitelist.isWhitelisted("telegram", userID)
    if (!allowed) {
      await ctx.reply(whitelistInstruction(userID, opts.whitelist.displayFile()))
      return
    }

    const raw = ctx.match?.toString().trim() ?? ""
    const splitAt = raw.indexOf(" ")
    if (!raw || splitAt <= 0) {
      await ctx.reply("Usage: /answer <requestID> <answers>")
      return
    }

    const requestID = raw.slice(0, splitAt).trim()
    const answerText = raw.slice(splitAt + 1).trim()
    if (!requestID || !answerText) {
      await ctx.reply("Usage: /answer <requestID> <answers>")
      return
    }

    const sessionID = await opts.assistant.getMainSessionID()
    const pending = await opts.assistant.listPendingQuestions(sessionID)
    const current = pending.find((item) => item.id === requestID)
    if (!current) {
      await ctx.reply("Question request not found or already handled.")
      return
    }

    const answers = parseQuestionAnswers(answerText)
    if (answers.length !== current.questions.length) {
      await ctx.reply(
        `This request expects ${current.questions.length} question answer group(s). Use ';' between questions and ',' between labels.`,
      )
      return
    }

    const beforeAssistantSig = await opts.assistant.getLatestAssistantSignature(sessionID)
    await opts.assistant.replyQuestion(current.id, answers)
    announcedQuestionIDs.delete(current.id)
    await ctx.reply("Answer submitted. Waiting for assistant to continue...")
    continueAfterUserInput({
      chatID,
      userID,
      sessionID,
      beforeAssistantSig,
      source: "command:answer",
    })
  })

  bot.on("callback_query:data", async (ctx) => {
    const parsed = decodeApprovalAction(ctx.callbackQuery.data)
    const parsedQuestion = decodeQuestionAction(ctx.callbackQuery.data)
    if (!parsed && !parsedQuestion) return

    const userID = String(ctx.from?.id ?? "")
    const chatID = ctx.chat?.id ?? ctx.callbackQuery.message?.chat.id
    if (!userID) {
      await ctx.answerCallbackQuery({ text: "Unknown user", show_alert: true })
      return
    }
    if (!chatID) {
      await ctx.answerCallbackQuery({ text: "Unknown chat", show_alert: true })
      return
    }
    const allowed = opts.whitelist.isWhitelisted("telegram", userID)
    if (!allowed) {
      await ctx.answerCallbackQuery({ text: "Access restricted", show_alert: true })
      return
    }

    const sessionID = await opts.assistant.getMainSessionID()

    if (parsed) {
      const pending = await opts.assistant.listPendingPermissions(sessionID)
      const current = pending.find((item) => item.id === parsed.requestID)
      if (!current) {
        await ctx.answerCallbackQuery({ text: "Request already handled or expired." })
        await ctx.editMessageReplyMarkup({ reply_markup: undefined })
        return
      }

      const beforeAssistantSig = await opts.assistant.getLatestAssistantSignature(sessionID)
      await opts.assistant.replyPermission(current.id, parsed.action, undefined, current.sessionID)
      announcedPermissionIDs.delete(current.id)

      const actionText = parsed.action === "reject" ? "Rejected" : "Approved"
      await ctx.answerCallbackQuery({ text: `${actionText}.` })
      await ctx.editMessageReplyMarkup({ reply_markup: undefined })

      if (parsed.action === "reject") {
        await ctx.reply("Approval rejected.")
        return
      }

      const remaining = await opts.assistant.listPendingPermissions(sessionID)
      if (remaining.length > 0) {
        await ctx.reply(`Approval submitted. ${remaining.length} approval request(s) still pending.`)
        return
      }

      await ctx.reply("Approval submitted. Waiting for assistant to continue...")
      continueAfterUserInput({
        chatID,
        userID,
        sessionID,
        beforeAssistantSig,
        source: "callback:permission",
      })
      return
    }

    const pendingQuestions = await opts.assistant.listPendingQuestions(sessionID)
    const currentQuestion = pendingQuestions.find((item) => item.id === parsedQuestion?.requestID)
    if (!currentQuestion || !parsedQuestion) {
      await ctx.answerCallbackQuery({ text: "Question already handled or expired." })
      await ctx.editMessageReplyMarkup({ reply_markup: undefined })
      return
    }

    if (currentQuestion.questions.length !== 1) {
      await ctx.answerCallbackQuery({ text: "Use /answer for this question type.", show_alert: true })
      return
    }

    const q = currentQuestion.questions[parsedQuestion.questionIndex]
    if (!q) {
      await ctx.answerCallbackQuery({ text: "Invalid question index.", show_alert: true })
      return
    }
    const opt = q.options[parsedQuestion.optionIndex]
    if (!opt) {
      await ctx.answerCallbackQuery({ text: "Invalid option.", show_alert: true })
      return
    }

    const beforeAssistantSig = await opts.assistant.getLatestAssistantSignature(sessionID)
    await opts.assistant.replyQuestion(currentQuestion.id, [[opt.label]])
    announcedQuestionIDs.delete(currentQuestion.id)

    await ctx.answerCallbackQuery({ text: `Selected: ${opt.label}` })
    await ctx.editMessageReplyMarkup({ reply_markup: undefined })
    await ctx.reply("Answer submitted. Waiting for assistant to continue...")
    continueAfterUserInput({
      chatID,
      userID,
      sessionID,
      beforeAssistantSig,
      source: "callback:question",
    })
  })

  const handleTextMessage = async (ctx: any) => {
    const text = ctx.message.text.trim()
    if (!text || text.startsWith("/")) return

    const startedAt = Date.now()
    const userID = String(ctx.from?.id ?? ctx.chat.id)
    const allowed = opts.whitelist.isWhitelisted("telegram", userID)
    opts.logger.info(
      {
        updateID: ctx.update.update_id,
        chatID: ctx.chat.id,
        userID,
        allowed,
        textLength: text.length,
      },
      "telegram message received",
    )
    if (!allowed) {
      await ctx.reply(whitelistInstruction(userID, opts.whitelist.displayFile()))
      return
    }

    const sessionID = await opts.assistant.getMainSessionID()
    activeSessionRequests.set(sessionID, { chatID: ctx.chat.id, userID })

    let typingTimer: ReturnType<typeof setInterval> | undefined
    try {
      await ctx.replyWithChatAction("typing")
      typingTimer = setInterval(() => {
        void ctx.replyWithChatAction("typing").catch((err: unknown) => {
          opts.logger.debug({ err, chatID: ctx.chat.id }, "failed to send typing action")
        })
      }, 3500)

      const answer = await opts.assistant.ask({
        channel: "telegram",
        userID,
        text,
      })

      const chunks = splitTextChunks(answer, 3000)
      for (const chunk of chunks) {
        await ctx.reply(chunk)
      }
      opts.logger.info(
        {
          updateID: ctx.update.update_id,
          chatID: ctx.chat.id,
          userID,
          durationMs: Date.now() - startedAt,
          answerLength: answer.length,
          chunkCount: chunks.length,
        },
        "telegram reply sent",
      )
    } catch (error) {
      opts.logger.error(
        {
          err: error,
          updateID: ctx.update.update_id,
          chatID: ctx.chat.id,
          userID,
          durationMs: Date.now() - startedAt,
        },
        "telegram message handling failed",
      )

      try {
        const pending = await showPendingApprovals(ctx, userID)
        if (pending.permissionCount + pending.questionCount > 0) {
          await ctx.reply("Your request is waiting for approval or question input. Use the buttons above or run /approvals.")
          return
        }
      } catch (approvalError) {
        opts.logger.warn({ err: approvalError, chatID: ctx.chat.id, userID }, "failed to check pending approvals")
      }

      await ctx.reply("I hit an internal error while preparing the reply. Check server logs.")
    } finally {
      activeSessionRequests.delete(sessionID)
      if (typingTimer) clearInterval(typingTimer)
    }
  }

  const handleMediaMessage = async (ctx: any, kind: InboxKind) => {
    const startedAt = Date.now()
    const userID = String(ctx.from?.id ?? ctx.chat.id)
    const allowed = opts.whitelist.isWhitelisted("telegram", userID)
    if (!allowed) {
      await ctx.reply(whitelistInstruction(userID, opts.whitelist.displayFile()))
      return
    }

    const caption = typeof ctx.message?.caption === "string" ? ctx.message.caption.trim() : ""
    const sessionID = await opts.assistant.getMainSessionID()
    activeSessionRequests.set(sessionID, { chatID: ctx.chat.id, userID })

    let typingTimer: ReturnType<typeof setInterval> | undefined
    try {
      await ctx.replyWithChatAction("typing")
      typingTimer = setInterval(() => {
        void ctx.replyWithChatAction("typing").catch((err: unknown) => {
          opts.logger.debug({ err, chatID: ctx.chat.id }, "failed to send typing action")
        })
      }, 3500)

      const fileID =
        kind === "voice"
          ? (ctx.message?.voice?.file_id as string | undefined)
          : ((ctx.message?.photo?.[ctx.message.photo.length - 1]?.file_id as string | undefined) ??
            ((ctx.message?.document?.mime_type as string | undefined)?.startsWith("image/")
              ? (ctx.message?.document?.file_id as string | undefined)
              : undefined))
      if (!fileID) {
        await ctx.reply("I could not read this media file from Telegram.")
        return
      }

      const file = await bot.api.getFile(fileID)
      if (!file.file_path) {
        await ctx.reply("Telegram did not return a downloadable file path.")
        return
      }

      const raw = await downloadTelegramFile(opts.token, file.file_path)
      const extension = pickFileExtension(file.file_path, kind === "voice" ? ".ogg" : ".jpg")
      const saved = await saveInboxBinary({
        dir: opts.inboxDir,
        channel: "telegram",
        userID,
        kind,
        extension,
        data: raw,
        metadata: {
          telegram: {
            fileID,
            filePath: file.file_path,
            fileSize: file.file_size,
            mimeType: ctx.message?.document?.mime_type,
            fileName: ctx.message?.document?.file_name,
          },
          caption,
        },
      })

      const prompt = buildMediaPrompt({ kind, filePath: saved.filePath, caption })
      const answer = await opts.assistant.ask({
        channel: "telegram",
        userID,
        text: prompt,
      })
      const chunks = splitTextChunks(answer, 3000)
      for (const chunk of chunks) {
        await ctx.reply(chunk)
      }
      opts.logger.info(
        {
          updateID: ctx.update.update_id,
          chatID: ctx.chat.id,
          userID,
          kind,
          durationMs: Date.now() - startedAt,
          savedFilePath: saved.filePath,
          answerLength: answer.length,
          chunkCount: chunks.length,
        },
        "telegram media reply sent",
      )
    } catch (error) {
      opts.logger.error(
        {
          err: error,
          updateID: ctx.update.update_id,
          chatID: ctx.chat.id,
          userID,
          kind,
          durationMs: Date.now() - startedAt,
        },
        "telegram media message handling failed",
      )
      await ctx.reply("I hit an internal error while handling this media message. Check server logs.")
    } finally {
      activeSessionRequests.delete(sessionID)
      if (typingTimer) clearInterval(typingTimer)
    }
  }

  bot.on("message:text", (ctx) => {
    const chatID = ctx.chat.id
    if (activeChats.has(chatID)) {
      void ctx.reply("Still working on your previous message. You can use /approvals if it is waiting for permission or question input.")
      return
    }

    activeChats.add(chatID)
    void handleTextMessage(ctx).finally(() => {
      activeChats.delete(chatID)
    })
  })

  bot.on("message:voice", (ctx) => {
    const chatID = ctx.chat.id
    if (activeChats.has(chatID)) {
      void ctx.reply("Still working on your previous message. You can use /approvals if it is waiting for permission or question input.")
      return
    }

    activeChats.add(chatID)
    void handleMediaMessage(ctx, "voice").finally(() => {
      activeChats.delete(chatID)
    })
  })

  bot.on("message:photo", (ctx) => {
    const chatID = ctx.chat.id
    if (activeChats.has(chatID)) {
      void ctx.reply("Still working on your previous message. You can use /approvals if it is waiting for permission or question input.")
      return
    }

    activeChats.add(chatID)
    void handleMediaMessage(ctx, "photo").finally(() => {
      activeChats.delete(chatID)
    })
  })

  bot.on("message:document", (ctx) => {
    const mimeType = (ctx.message?.document?.mime_type as string | undefined) ?? ""
    if (!mimeType.startsWith("image/")) return
    const chatID = ctx.chat.id
    if (activeChats.has(chatID)) {
      void ctx.reply("Still working on your previous message. You can use /approvals if it is waiting for permission or question input.")
      return
    }

    activeChats.add(chatID)
    void handleMediaMessage(ctx, "photo").finally(() => {
      activeChats.delete(chatID)
    })
  })

  bot.catch((err) => {
    opts.logger.error({ err, updateID: err.ctx?.update?.update_id }, "telegram bot error")
  })

  try {
    await bot.api.setMyCommands([
      { command: "start", description: "Start or check bot status" },
      { command: "pair", description: "Pair your Telegram ID" },
      { command: "new", description: "Start a new shared session" },
      { command: "remember", description: "Save durable memory" },
      { command: "approvals", description: "List pending approvals/questions" },
      { command: "approval", description: "Alias of /approvals" },
      { command: "answer", description: "Answer a pending question" },
    ])
  } catch (error) {
    opts.logger.warn({ err: error }, "telegram command registration failed")
  }

  const startPromise = bot.start()
  void pruneInboxFiles()
  void flushOutbox()
  setInterval(() => {
    void pruneInboxFiles()
  }, 60 * 60 * 1000)
  setInterval(() => {
    void flushOutbox()
  }, 60000)
  opts.logger.info("telegram adapter started")
  await startPromise
}
