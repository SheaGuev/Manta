# core/agent

The agent behind a thread. `Workspace` only sees the `ThreadAgent` interface; `main/` picks the implementation.

| Entry | What it does |
|---|---|
| `threadAgent.ts` | `ThreadAgent` interface (one turn in, a stream of `AgentEvent`s out, permission requests); a turn's context is a thread's (`ThreadTurnContext`) or a context map agent's (`MapTurnContext`: Ask the map or the sweep, with Manta's MCP endpoint as `McpAccess` and an optional model). `ScriptedAgent`, the fake used by tests and `MANTA_FAKE_AGENT=1`; its `call` step calls one of Manta's MCP tools for real. |
| `claudeCodeAgent.ts` | `ClaudeCodeAgent`: runs the user's own Claude Code via the Agent SDK in the thread's (or map's) folder. `claudeCodeOptions` builds the session options, with a system prompt for a thread or for a map's agent; `fenceDenial` is the `PreToolUse` hook that keeps file writes inside that folder. |
| `claudeStatus.ts` | `claudeCodeStatus`: whether Claude Code is installed and signed in, and with which provider, for the status bar. |

**Imports:** `../../shared/ipc.ts`; `claudeCodeAgent.ts` uses `threadAgent.ts`. Nothing here imports the rest of core.

**Tests:** `__tests__/claudeCodeAgent.test.ts` (options and the write fence, no live calls), `__tests__/claudeStatus.test.ts`. Live runs against Claude Code spend the user's usage: ask first ([docs/patterns.md](../../../docs/patterns.md)).
