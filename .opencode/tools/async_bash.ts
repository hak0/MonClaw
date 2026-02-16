import { tool } from "@opencode-ai/plugin"

const SEP = "/"
const defaultTimeoutMs = Number.parseInt(Bun.env.ASYNC_BASH_DEFAULT_TIMEOUT_MS || "86400000", 10)

function joinPath(...parts: string[]): string {
  return parts
    .filter((part) => part !== "")
    .map((part, index) => {
      if (index === 0) return part.replace(/\/+$/g, "")
      return part.replace(/^\/+/, "").replace(/\/+$/g, "")
    })
    .filter(Boolean)
    .join(SEP)
}

function isAbsolute(path: string | undefined): boolean {
  return typeof path === "string" && path.startsWith(SEP)
}

async function run(cmd: string[]): Promise<boolean> {
  const proc = Bun.spawn(cmd, { stdout: "ignore", stderr: "ignore" })
  await proc.exited
  return proc.exitCode === 0
}

function resolvePaths(worktree?: string): { root: string; queueDir: string; lastChannelFile: string; whitelistFile: string } {
  const root =
    (typeof worktree === "string" && worktree.trim()) ||
    (typeof Bun.env.MONCLAW_ROOT === "string" && Bun.env.MONCLAW_ROOT.trim()) ||
    Bun.cwd

  const queueOverride = Bun.env.ASYNC_BASH_QUEUE_DIR
  const dataOverride = Bun.env.MONCLAW_DATA_DIR

  const dataDir = dataOverride && dataOverride.trim().length > 0
    ? isAbsolute(dataOverride)
      ? dataOverride
      : joinPath(root, dataOverride)
    : joinPath(root, ".data")

  const queueDir = queueOverride && queueOverride.trim().length > 0
    ? isAbsolute(queueOverride)
      ? queueOverride
      : joinPath(root, queueOverride)
    : joinPath(dataDir, "async-jobs")

  return {
    root,
    queueDir,
    lastChannelFile: joinPath(dataDir, "last-channel.json"),
    whitelistFile: joinPath(dataDir, "whitelist.json"),
  }
}

function commandIsDangerous(command: string): boolean {
  const c = command.toLowerCase()
  const patterns = [
    /(^|\s)shutdown(\s|$)/,
    /(^|\s)reboot(\s|$)/,
    /(^|\s)halt(\s|$)/,
    /(^|\s)poweroff(\s|$)/,
    /rm\s+-rf\s+\/$/,
    /rm\s+-rf\s+\/\s/,
    /:\(\)\s*\{\s*:\|:&\s*\};:/,
    /mkfs(\.|\s)/,
    /dd\s+if=\/dev\/zero\s+of=\/dev\//,
  ]
  return patterns.some((p) => p.test(c))
}

async function loadJson(path: string): Promise<any> {
  return JSON.parse(await Bun.file(path).text())
}

async function currentTarget(lastChannelFile: string): Promise<{ channel: "telegram"; userID: string }> {
  const raw = await loadJson(lastChannelFile)
  if (!raw || raw.channel !== "telegram" || typeof raw.userID !== "string") {
    throw new Error("No valid last-used channel/user is available.")
  }
  return { channel: "telegram", userID: raw.userID }
}

async function ensureTargetWhitelisted(userID: string, whitelistFile: string): Promise<void> {
  let parsed
  try {
    parsed = await loadJson(whitelistFile)
  } catch {
    throw new Error("Whitelist is unavailable. async_bash is blocked.")
  }
  const allowed = Array.isArray(parsed?.telegram) ? parsed.telegram.map(String) : []
  if (!allowed.includes(String(userID))) {
    throw new Error("Target user is not whitelisted for async_bash notifications.")
  }
}

function makeJobID(): string {
  return `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`
}

export default tool({
  description:
    "Queue a bash command for asynchronous background execution. The system will send periodic progress updates and a completion result to chat.",
  args: {
    command: tool.schema.string().describe("Bash command to run asynchronously"),
    workdir: tool.schema.string().optional().describe("Optional working directory for command execution"),
    timeoutMs: tool.schema.number().optional().describe("Optional timeout in milliseconds (default: 24h)"),
  },
  async execute(args, context) {
    const paths = resolvePaths(context?.worktree)
    const command = (args.command || "").trim()
    if (!command) throw new Error("command is required")
    if (commandIsDangerous(command)) {
      throw new Error("Blocked by async_bash safety policy: dangerous command pattern detected.")
    }

    await context.ask({
      permission: "tool.async_bash.execute",
      patterns: [command],
      always: [],
      metadata: {
        tool: "async_bash",
        command,
        workdir: typeof args.workdir === "string" ? args.workdir : undefined,
        timeoutMs: Number.isFinite(args.timeoutMs) ? Number(args.timeoutMs) : defaultTimeoutMs,
      },
    })

    const timeoutMsRaw = Number.isFinite(args.timeoutMs) ? Number(args.timeoutMs) : defaultTimeoutMs
    const timeoutMs = Math.max(1000, timeoutMsRaw)
    const target = await currentTarget(paths.lastChannelFile)
    await ensureTargetWhitelisted(target.userID, paths.whitelistFile)

    await run(["mkdir", "-p", paths.queueDir])

    const id = makeJobID()
    const filePath = joinPath(paths.queueDir, `${id}.json`)
    const now = new Date().toISOString()
    await Bun.write(
      filePath,
      JSON.stringify(
        {
          id,
          command,
          workdir: typeof args.workdir === "string" && args.workdir.trim() ? args.workdir.trim() : undefined,
          timeoutMs,
          status: "queued",
          channel: target.channel,
          userID: target.userID,
          sessionID: context?.sessionID,
          createdAt: now,
          updatedAt: now,
          progress: {
            totalBytes: 0,
            totalLines: 0,
            deltaBytesSinceReport: 0,
            deltaLinesSinceReport: 0,
            reportsSent: 0,
          },
        },
        null,
        2,
      ),
    )

    return `Queued async_bash job ${id}. Progress updates are sent every minute and final result is pushed when complete.`
  },
})
