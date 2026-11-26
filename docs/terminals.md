# Terminals

How terminals work in Manta, for anyone changing them. Built for roadmap item P4 ([roadmap.md](roadmap.md)). The plan, decisions (D38 to D48) and spike results live outside the repo.

## What a terminal is

A terminal runs in a context root (the docs repo or a worktree) and opens as a tab next to that context's files and threads. Two kinds:

- **Claude** (`claude`): the user's own Claude Code, started by Manta with its hooks attached, so Manta knows whether the session is working, waiting on the user, or at its prompt.
- **Shell** (`shell`): the user's login shell.

Invariant: **the process lives in main, not in the tab.** Switching context, closing the window or reloading the renderer never stops a terminal; only closing its tab, removing its worktree or project, or quitting Manta does.

## Data model

```
TerminalManager (core/terminal/terminals.ts), one per app run
 ├─ TerminalHost          running terminals: a PTY each, plus a headless screen copy
 ├─ HookServer            loopback HTTP endpoint Claude Code's hooks post to
 └─ TerminalRecordStore   <userData>/terminals.json: id, root, kind, title, session id, resumable
```

| State | Kind | Meaning |
|---|---|---|
| `running` | shell | Process alive |
| `starting` | claude | Launched; Claude Code hasn't fired `SessionStart` yet (it can take 6 to 30 s, and its folder-trust prompt comes before it) |
| `idle` | claude | At its prompt |
| `working` | claude | In a turn |
| `waiting` | claude | Needs the user: a permission request or a question |
| `exited` | both | Process ended. `startedAt: null` means it ended when Manta quit |

## Flows

### Create

`TerminalManager.create(root, kind, size)` (main resolves `root` through `ProjectRegistry.resolveRoot` first):

1. A record with a fresh id, a title numbered per root and kind (`Claude`, `Claude 2`), and for Claude a fresh session id.
2. Environment (`terminalEnv.ts`): the user's login shell env, read once per run with `$SHELL -ilc 'env -0'`; minus variables a parent Claude Code, Orca or Superset session sets for its children (a Manta started from an Orca terminal would otherwise report its Claude sessions to Orca through Orca's hooks); plus `TERM`, `MANTA_TERMINAL_ID`, `MANTA_ROOT`, and for Claude `MANTA_HOOK_PORT` / `MANTA_HOOK_TOKEN`.
3. Spawn. Claude: `claude <extra args> --settings <userData>/hooks/claude-settings.json --session-id <uuid>`. Shell: `$SHELL -l`. An implementation session ([implementation-threads.md](implementation-threads.md)) also gets a first prompt (placed before every option), a brief (`--append-system-prompt-file`, rewritten before each start) and the docs repo (`--add-dir`), and its tab links back to the doc.

The extra arguments are the user's (**+** → **Claude command…**), one setting for every context in `<userData>/terminal-settings.json` (`claudeArgs.ts`). They're stored as typed and split shell-style at each start, so a change applies to new and resumed sessions, not running ones. `--settings`, `--session-id`, `--resume` / `-r` and `--continue` / `-c` are refused: Manta sets them, and a second copy would break the hooks or Resume.

### Output and the screen copy

```
PTY ──▶ headless xterm (main) ──▶ batch (16 ms, seq n) ──▶ terminal:data ──▶ tab's xterm
                                    snapshot = screen as of seq n ──────────▶ on mount
```

Output reaches listeners only after the headless screen has processed it, and `snapshot` serialises inside a `screen.write('', cb)` callback, so a snapshot plus output with a later `seq` is exact. A mounting tab buffers `terminal:data`, asks for the snapshot, writes it, then applies only chunks with `seq` above it.

The headless copy never answers terminal queries (cursor position, device attributes); the tab's xterm does when it is showing, so a query is never answered twice. Claude Code starts fine with no answers.

### Claude state from hooks

`claudeHookSettings()` registers one command hook for `SessionStart`, `UserPromptSubmit`, `PreToolUse`, `PostToolUse`, `PostToolUseFailure`, `PermissionRequest`, `Notification`, `Stop`, `StopFailure`, `PostCompact`, `SessionEnd`. Hooks passed with `--settings` are **added** to the user's own (verified with 2.1.285), so `~/.claude/settings.json` is never touched.

`HOOK_COMMAND` pipes the payload to `curl` at `127.0.0.1:$MANTA_HOOK_PORT/hook` with the token and terminal id in headers (`--noproxy`, 0.5 s connect, 1.5 s max), then prints `{}` so a hook that must answer defers to Claude Code. It never fails, and does nothing outside a Manta terminal.

`stateAfterHook` (`terminalState.ts`) maps each payload, following the hook sequences Orca recorded from real sessions:

| Event | State |
|---|---|
| `SessionStart` with `source` `startup` / `resume` / `clear` | `idle` (a compaction restart is ignored) |
| `UserPromptSubmit`, `PreToolUse`, `PostToolUse`, `PostToolUseFailure` | `working` |
| `PermissionRequest`, `PreToolUse` of `AskUserQuestion`, `Notification` `permission_prompt` | `waiting` |
| `Stop`, `StopFailure`, `PostCompact` with `trigger: manual` | `idle` |
| `Notification` `idle_prompt` while `working` | `idle`: cancelling a turn (Esc) sends no hook, so Claude's idle reminder is the only sign |

Events carrying `agent_id` (subagents) only count when they need the user. `SessionStart` also updates the session id (`/clear` starts a new one), and `UserPromptSubmit` marks the session resumable: Claude Code only saves a session once it has had a prompt.

### Sending a prompt

`TerminalManager.sendPrompt(id, text)` types a prompt into a Claude session for it, so Manta can hand an agent work (review comments, [reviews.md](reviews.md)) without switching to its tab.

- **Bracketed paste, then Enter.** It writes `ESC[200~<text>ESC[201~`, waits 50 ms and writes `\r`, as Orca does. The paste makes a multi-line prompt one prompt: typed raw, each newline would submit a line. Enter right after the paste can land before the TUI has taken it in, hence the gap. Paste markers inside the text are removed so they can't end the paste early.
- **The state is checked again before Enter.** A working session can stop for a permission prompt during the gap, and Enter would answer it; then nothing more is typed and the send is refused ("stopped before it was sent; the text is in its input").
- **One more Enter for an idle session that doesn't start working** within 1.5 s (Orca retries once for Claude too); an Enter on an empty input submits nothing. If it still doesn't start, the send is refused ("didn't submit it … press Enter there"), so nothing is marked sent that wasn't. `promptTiming` (manager option) sets both waits; tests widen them.
- **When it's refused** (an `OpResult`, nothing written):
  - a shell: "Only Claude sessions take review comments"
  - exited: "<title> isn't running"
  - `waiting`: "<title> is waiting for you; answer it first". The text would answer the permission prompt.
  - `starting`, or bracketed paste not on yet (`TerminalHost.pasteReady`, read from the headless screen's modes): "<title> is still starting"
- `idle` and `working` both take it: Claude Code queues a prompt sent while it works.
- Main does it, so it works when the agent's tab isn't mounted. The session's own hooks then move it to `working`, which its tab dot and sidebar row show.

### Restart and relaunch

- An exited Claude terminal restarts with `claude --resume <session id>` when resumable, otherwise with a new session id. A shell restarts fresh. The tab is keyed by `startedAt`, so a restart mounts a clean screen.
- Quitting kills every terminal (SIGHUP to the process group, SIGKILL after 3 s) but keeps the records. After a relaunch they are listed as exited (`startedAt: null`) and their tabs offer **Resume session** or **Restart shell**.

### Rename

- Double-click a tab, or right-click it and choose **Rename**. `TerminalManager.rename` stores the name in the terminal's record, so restarts, relaunches, the header and every tab showing the terminal use it. Other non-file tabs (threads, maps, compares, reviews, Plugins) are renamed in the renderer's saved tabs only; file tabs keep the file's name.
- Right-click a Claude tab for **Copy session ID** (the id `claude --resume` takes).

### Close

- Closing a tab closes its terminal. Main asks first when a Claude session is `working` or `waiting`.
- Removing a worktree: the confirm dialog counts its running terminals; they're closed before `git worktree remove`. Removing a project closes the terminals of its root and worktrees.

## Renderer

| Piece | File | What it does |
|---|---|---|
| Terminal tab | `App.tsx`, `components/TerminalView.tsx` | Tab kind `terminal` (`{ root, terminal, title }`), persisted with the context's tabs. `@xterm/xterm` + fit + web-links, themed from the CSS variables; fits on resize and when shown. Plain URLs open in the browser on click; a hyperlink the program prints (OSC 8, which Claude Code uses) can show text other than its target, so clicking one asks first in `OpenLinkDialog.tsx` (Open, Copy link, Cancel). xterm's own handler used `confirm()` and then opened a blank window that main's window-open handler refused, so OK did nothing. Option acts as Meta; Option+Delete sends Ctrl+W (`lib/terminalKeys.ts`), not xterm's `ESC DEL`, so it deletes a word in zsh's vi mode too (zsh picks vi mode when `$EDITOR` is vi). Exit bar with Resume session / Start a new session / Restart shell |
| New terminal | `App.tsx`, `components/NewTabButton.tsx`, `components/Sidebar.tsx` | A **+** after the last tab (shown whenever a context is open): New Claude session, New shell, Claude command… (`ClaudeCommandDialog.tsx`). Header buttons **New Claude session** (⌘T, caught in the capture phase so it works from the editor or a terminal) and **New shell** in any context; a **New Claude session** button on each worktree row |
| Hidden terminals | `App.tsx`, `lib/warmContexts.ts`, `lib/webglBudget.ts` | Every tab of the current context is mounted, and so are the tabs of the last 3 contexts you left (`WARM_CONTEXTS`). Hidden ones keep their xterm and keep receiving output, but xterm doesn't draw them, and their cursor stops blinking. Switching back is a CSS change. A 5th context unmounts the least recent one, which mounts again from the snapshot. At most 6 hidden terminals keep a WebGL context, the most recently hidden; the rest draw with the DOM renderer until shown again (`data-renderer` on `.terminal-screen`). Chromium drops the oldest context past 16 per page |
| Status | `lib/terminalStatus.ts`, `lib/hooks.ts` (`useTerminals`) | A dot on Claude tabs; the header badge (`Ready`, `Working`, `Waiting for you`); on each context's sidebar row, its most urgent Claude session (waiting > working > starting > idle) |

**Sizing.** `fitTerminal` counts the rows and columns that fit `.terminal-screen`'s content box, using the cell size from xterm's render state (`lib/terminalFit.ts`), not `FitAddon.fit()` (which counts the box's padding as height and reserves a strip for a scrollbar that floats). Never derive the cell size from the drawn `.xterm-screen`: while a terminal is hidden xterm defers the renderer's resize, so after a fit in a hidden-mounted tab the drawn size still belongs to the old rows and columns, and the next fit came out far too tall (the bottom rows, Claude's prompt included, below the footer and unscrollable).

## IPC

`listTerminals`, `createTerminal`, `restartTerminal`, `closeTerminal` (false when the user cancelled), `terminalSnapshot`, `writeTerminal` and `resizeTerminal` (fire and forget), `claudeArgs` and `setClaudeArgs` (an `OpResult`; refused for an open quote or a reserved flag). Streamed: `terminal:data` (`id, data, seq`), `terminal:changed` (`TerminalInfo`), `terminal:removed` (`id`).

## Developing

- `node-pty` loads in vitest's Node and in Electron (N-API prebuilds). Its `spawn-helper` installs without its exec bit; the `postinstall` script sets it. Without it every spawn fails with `posix_spawnp failed`.
- `scripts/fake-claude.mjs` stands in for `claude` in tests and under `MANTA_FAKE_AGENT=1` (run with Electron's own Node via `ELECTRON_RUN_AS_NODE`). It runs the real hook command from `--settings`. Each line is a prompt: `ask <thing>` asks permission (answer `y`/`n`), `work <seconds>` stays busy, `exit` quits. It turns bracketed paste on at start, and a pasted block of lines is one prompt.
- UI e2e: `terminals-e2e.mjs` in the dev-scripts folder (`docs/threads.md` → Developing), renderer on 9339, main on `--inspect=9337` for the dialog stubs. Launch the instance with `--disable-backgrounding-occluded-windows --disable-renderer-backgrounding`: xterm draws on animation frames, which Chromium pauses for a window behind others, so DOM checks read stale text while screenshots look right.
- A live check (real `claude`, no prompt, no usage): create a Claude terminal in a folder Claude Code already trusts, wait for `idle`, send `/exit`.

## Known limits

Deferred: none of these is scheduled ([roadmap.md](roadmap.md), P4).


- Terminals end when Manta quits; only the Claude conversation survives (Resume). Orca keeps its PTYs in a detached daemon instead.
- Claude Code's folder-trust prompt comes before `SessionStart`, so the tab says `starting` while it is really waiting on the user.
- After Esc cancels a turn, the tab stays `working` until Claude's idle reminder (about a minute) or the next prompt.
- No output flow control: a flood of output (`cat` of a huge file) is batched but not throttled.
- Shift+Enter isn't mapped to a newline for Claude Code's prompt yet.
- A terminal whose tab is gone (only possible through the API) stays in `terminals.json` until its root is closed.
