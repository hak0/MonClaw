# MonClaw: Repository Guide

MonClaw is a minimal assistant layer on top of the OpenCode SDK.
OpenCode handles core agent/runtime behavior; this repo adds channels, memory, heartbeat cron tasks, and a few tools.

## Design Goals

- Keep custom code small ("less is more").
- Reuse OpenCode-native mechanisms (auth, sessions, tools/plugins).
- Persist only essential state on disk.
- Share one main conversation session across channels.

## Runtime Overview

Entry point: `src/index.ts`

Startup flow:
1. Load config from `src/config.ts`.
2. Set `OPENCODE_CONFIG_DIR` to this repo.
3. Initialize `AssistantCore`, `MemoryStore`, `SessionStore`, `WhitelistStore`.
4. Start Telegram adapter.
5. Start heartbeat scheduler if `.data/heartbeat.md` has tasks.

## OpenCode Integration

`AssistantCore` (`src/core/assistant.ts`) owns OpenCode client usage:
- One shared **main** OpenCode session across all channels.
- One separate **heartbeat** session.
- Each user message uses `session.prompt` with a dynamic `system` prompt.
- Falls back to message polling only if prompt output cannot be parsed.

Model selection:
- `OPENCODE_MODEL` if set.
- Else first recent model in `~/.local/state/opencode/model.json` (`XDG_STATE_HOME` respected).

## Channels

Telegram: `src/channels/telegram.ts`
- `grammy`
- `/pair`, `/new`, `/remember`
- typing indicator

Telegram adapter enforces whitelist and chunks long replies.

## Memory

Single file: `.data/workspace/MEMORY.md`

- Always injected into the system prompt.
- Durable memory writes happen through `/remember <text>`.
- Agent should ask the user to use `/remember` when a stable fact should be persisted.

No search, no embeddings, no extra memory files.

## Heartbeat (Cron Tasks)

Files: `.data/heartbeat.md`, `src/scheduler/heartbeat.ts`

- One task per line (comments start with `#`).
- Runs in its own session.
- Uses the same system prompt + memory.
- Adds a short recent main-session context snippet.
- Writes summary back into main session.
- Then asks the agent whether to notify the user.

## Proactive Messaging

Tool: `send_channel_message` (plugin)

Flow:
1. Agent decides to notify.
2. Tool writes to `.data/outbox/`.
3. Channel adapters flush outbox and send.

Destination:
- Last used channel/user, stored in `.data/last-channel.json`.

## Tools (Plugins)

Configured in `opencode.json`:

- `install_skill` → installs GitHub tree URL skill into `.opencode/skills/`
- `send_channel_message` → queue proactive message

## Security / Pairing

Whitelist: `.data/whitelist.json`
- `/pair <token>` if `WHITELIST_PAIR_TOKEN` is set
- Otherwise manual edit by admin

## Persistent Data

- `.data/workspace/MEMORY.md`
- `.data/sessions.json`
- `.data/whitelist.json`
- `.data/last-channel.json`
- `.data/outbox/`
- `.data/heartbeat.md`

## Commands

User:
- `/new`
- `/remember <text>`
- `/pair <token>`

Developer:
- `bun run dev`
- `bun run start`
- `bun run typecheck`
- `bun run test:opencode:e2e`

## Tradeoffs

- Message polling is a fallback (not streaming).
- Memory is append-only.
- Whitelist is file-based.
- Heartbeat is checklist-style, not a workflow engine.

## Extension Points

- Add channels under `src/channels/`.
- Add tools via `.opencode/plugins/*.plugin.js` and register in `opencode.json`.
- Add skills under `.opencode/skills/`.
