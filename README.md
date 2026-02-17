# MonClaw

![MonClaw Telegram](openclaw-telegram.png)

MonClaw is a minimal implementation of OpenClaw using the OpenCode SDK.

- Telegram adapter (`grammy`)
- Single markdown memory file (`MEMORY.md`) loaded on every message
- Durable memory updates via Telegram command (`/remember <text>`)
- Heartbeat task runner (periodic checklist from `heartbeat.md`)
- Channel-level whitelist with disk persistence

## Auth model (OpenCode-native)

This project is set up to reuse OpenCode's existing auth mechanisms.

- Requires `OPENCODE_SERVER_URL` and connects to an already-running OpenCode server/client setup.
- No app-specific API key is required in this repo.

## Quick start

1. Install Bun and dependencies:

```bash
# install bun
curl -fsSL https://bun.com/install | bash

# clone repo
git clone https://github.com/CefBoud/MonClaw.git && cd MonClaw

# install
bun install
```

2. Log in using the OpenCode CLI:

```bash
bun run opencode auth login
```

Then open the TUI with `bun run opencode` and pick a model using `/models`.

3. Create the env file:

```bash
cp .env.example .env
```

4. Fill required values in `.env` (manually or via the setup script below):

- `TELEGRAM_BOT_TOKEN` (if Telegram enabled)
- `OPENCODE_SERVER_URL` to connect to an existing OpenCode server

Optional:

- `OPENCODE_MODEL` in `provider/model` format
- `OPENCODE_AGENT` to force prompts to use a specific OpenCode agent (default `monclaw`)
- `OPENCODE_DIRECTORY` to pin sessions under a specific OpenCode project directory
- `OPENCODE_SERVER_PASSWORD` if that server enforces HTTP Basic auth
- `OPENCODE_SERVER_USERNAME` optional username for Basic auth (defaults to empty username)
- `HEARTBEAT_INTERVAL_MINUTES` (default 30)
- `HEARTBEAT_FILE` (default `.data/heartbeat.md`; empty file disables heartbeat)
- `ASYNC_BASH_QUEUE_DIR` (default `.data/async-jobs`)
- `ASYNC_BASH_CONCURRENCY` (default 1)
- `ASYNC_BASH_REPORT_SECONDS` (default 60)
- `ASYNC_BASH_DEFAULT_TIMEOUT_MS` (default 86400000, i.e. 24h)
- `WHITELIST_FILE` (default `.data/whitelist.json`)
- `WHITELIST_PAIR_TOKEN` (required for self-pairing via chat command)
- `PAIR_MAX_ATTEMPTS` (default 5, max failed `/pair` attempts before temporary lock)
- `PAIR_LOCK_MINUTES` (default 15, lock duration after reaching max failed attempts)
- `INBOX_DIR` (default `.data/inbox`, temp Telegram media files)
- `INBOX_RETENTION_DAYS` (default 7, auto-delete files older than this)

5. Run:

```bash
bun run dev
```

To keep it running after an SSH session ends:

```bash
nohup bun run dev > monclaw.log 2>&1 &
disown
```

## CLI onboarding

Run the interactive setup to configure channels and auth:

```bash
bun run setup
```

This will:
- Enable Telegram
- Capture bot token and remote OpenCode server settings
- Update `.env`

## OpenCode E2E health check

Run a local end-to-end check that starts its own OpenCode server via SDK, sends a prompt, and verifies a model reply:

```bash
bun run test:opencode:e2e
```

## Commands

In Telegram chat:

- `/remember <text>`: force-save durable memory in `.data/workspace/MEMORY.md`
- `/pair <token>`: add your account to whitelist (if pairing token is configured)
- `/approvals`: list pending OpenCode permission approvals and question prompts with Telegram action buttons
- `/answer <requestID> <answers>`: answer a pending OpenCode question when manual text input is required

Pairing protection (new):
- Failed `/pair` attempts are tracked per `channel:userID` in `.data/pair-attempts.json`.
- If failures reach `PAIR_MAX_ATTEMPTS`, the user is temporarily locked for `PAIR_LOCK_MINUTES`.
- During lock period, `/pair` returns a “try again later” message; successful pairing clears prior failure state.

- `/new`: start a new shared main OpenCode session
- Any normal message: sent to OpenCode SDK session, with relevant memory context injected

## Data layout

- `.data/sessions.json`: shared `mainSessionID` + separate `heartbeatSessionID`
- `.data/workspace/MEMORY.md`: durable user memory (single memory file)
- `.data/whitelist.json`: allowed Telegram accounts
- `.data/pair-attempts.json`: failed `/pair` counters + temporary lock state per `channel:userID`
- `.data/inbox/`: temporary incoming Telegram media files (voice/photo + metadata)
- `.data/async-jobs/`: async_bash queue (`*.json`) and execution logs (`output/*.log`)

## Security

- Warning: This project is experimental. Use at your own risk and exercise extreme care and caution, especially in production or with sensitive data.
