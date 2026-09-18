# pi-interactive-subagents

Async subagents for Pi 0.85.1, running in Herdr panes. Spawn a subagent, keep working in the main session, and receive its result when it finishes.

## Herdr Orchestration Fork

This fork uses normal source modules, not downstream patches. The central JSON
configuration is authoritative; bundled, global and project Markdown agent files
are not loaded. Claude CLI spawning and its permission-bypass path are removed.
The older upstream reference below is retained for historical context; its tmux,
Markdown discovery, role-folder configuration and original-loadout resume
instructions do not apply to this fork.

### Integration

- Parent settings load the package entry `pi-extension/subagents/index.ts`. Its factory installs the root runtime with a statically imported, typed workflow callback.
- Every child must run the absolute `PI_GUARDED_EXECUTABLE` Nix wrapper. That wrapper must inject `-e <fork>/pi-extension/subagents/orchestrator/index.ts`, `-e <permissions>/src/index.ts`, and `-e <permissions>/src/ai-authorizer/index.ts`, even when the child requests `--no-extensions`.
- Do not inject the standalone orchestrator entry into the parent as well as the package entry: the parent factory already installs it. In children, only the mandatory entry owns lifecycle/usage hooks; an optional nested launcher uses a separate typed IPC client without registering duplicate accounting hooks.
- The separate child entry is intentionally small: leaf agents need the mandatory guard, but not the launcher UI or spawn tools. Agents with nonempty `canSpawn` also load the main entry and retain the upstream child-result/auto-exit lifecycle.
- `PI_ORCHESTRATOR_CONFIG` must be an absolute path to the single central JSON file, such as `config/pi/config.json`. Missing/invalid configuration or root IPC fails closed, aborting the session instead of falling back to unguarded execution.
- `PI_WEB_EXTENSION` must be the absolute web extension entry when an agent requests `web_search`, `fetch_content`, `get_search_content`, or `source_check`.
- Herdr must be on PATH, with `HERDR_ENV=1` and `HERDR_PANE_ID` identifying the parent pane. Splits preserve focus and use the admitted working directory.
- The mandatory permissions/reviewer fork must consume the same central JSON and disable project-local permission overrides and YOLO. This package does not replace that authorization layer or provide an OS sandbox. No Nix-generated agent Markdown is needed.

Child launches explicitly use `--no-extensions --no-skills --no-prompt-templates`,
plus a current tool allowlist and explicit tool extension paths. Initial tasks and
resume messages use files, not slash-command CLI arguments. Live messages use
authenticated Unix-socket IPC and `sendUserMessage` with template expansion off,
never terminal keystrokes. `pane run` is only used for launch scripts.

### Configuration

See [`orchestrator.config.example.json`](orchestrator.config.example.json) for a
complete configuration. All fields are required, unknown fields are rejected,
and the validated snapshot is immutable until the root Pi process restarts.

| Field | Meaning |
| --- | --- |
| `schemaVersion` | Must be `1` |
| `reviewer` | `mode` (`auto`/`manual`), nullable `provider` and `model`, `reasoning`, `timeoutMs` (1..120000), `maxTokens` (1..16384); consumed by the mandatory reviewer |
| `permissions` | `authorizerChain: ["ai-authorizer"]`, `yoloMode: false`, and `permission` action rules (`allow`, `ask`, `deny`) |
| `limits.maxOpenPanes` | Default configuration: 3; allowed 1..64; shared across the complete descendant tree |
| `limits.maxDepth` | Default configuration: 2; allowed 1..16; computed by root, never trusted from child input |
| `limits.maxLaunchesPerTurn` | Default configuration: 8; allowed 1..1000; failed launches also consume budget |
| `limits.maxTurnsPerRun` | Default configuration: 20; allowed 1..1000; each child lease gets a fresh run budget, not each worker message |
| `limits.maxTokensPerSession` | `null` or a positive safe integer; cumulative reported root, descendant and reviewer tokens for the root process, including session switches/reloads |
| `panes` | `direction: "right"` or `"down"`; `shellReadyDelayMs: 0..10000` (example: 500) |
| `agents.<name>` | `description`, nullable `model`, `reasoning`, `tools`, `canSpawn`, `prompt`, `sessionMode` |
| `workflows.<name>` | `description` and ordered `steps`: `{agent, task}` or `{parallel: [{agent, task}, ...]}` |

Agent names use letters, digits, `_` and `-`. `reasoning` accepts `off`, `minimal`,
`low`, `medium`, `high`, `xhigh`, or `max` (provider/model support still applies).
`model: null` inherits the current parent model. Explicit initial model overrides
are honored; resumes use the **current central model/reasoning and current parent
fallback**, never a persisted model override. Prompts are appended through a
system-prompt file on both initial launch and resume. All agents auto-exit when
finished, but pending questions, queued messages and running children keep them
alive. `canSpawn` alone grants spawning tools; naming those tools in `tools` does
not grant delegation. `ask_question` is always available; `workflow` is root-only.

`sessionMode` is `standalone`, `lineage-only`, or `fork`. Conversation history can
be inherited without inheriting old permissions. A persisted loadout supplies
only the agent identity and working directory for resume; current JSON rebuilds
tools, spawn targets, prompt, model and reasoning. Root admission validates cwd
containment after resolving symlinks.

### Workflows And Limits

Use `/workflow list`, `/workflow <name> <task>`, or the root `workflow` tool.
Only `{{task}}` and `{{previous}}` are interpolated; previous summaries are bounded
to 8000 characters. Parallel group size and total workflow launches are validated
against configured limits. Admission is immediate: capacity failure never waits
in a queue, so nested delegation cannot deadlock waiting for occupied panes.
Failure or new human input cancels further steps and revokes descendant work.
Completion/failure notifications arrive asynchronously.

Only interactive root input or an admitted manual launch/workflow command renews
the launch budget. Status/list commands, workflow tools, worker messages and
session reloads do not refund it. A manual `/workflow` command records exactly
`pi.appendEntry("orchestrator-user-intent", { text: task })` before the first
launch, after workflow validation/busy admission. The AI reviewer must recognize
that custom entry as the human request. The workflow tool never writes this
entry; its task is not promoted to human authority.

Session switches/reloads revoke children and close known leased panes while
preserving the root socket and spent budgets. Quit closes the socket. Capacity
is released only after pane closure is confirmed and a registered child PID has
exited. Ambiguous split/close failures retain capacity rather than risk reuse.
`/orchestrator status` reports limits, leases, launches and total tokens. The
reviewer usage hook remains at `Symbol.for("dotfiles.pi.orchestrator")`; launcher
and workflow execution do not use a global run bridge.

### Verification

Dependencies are provided by Nix, not installed into the working tree. The old
npm lockfile described Pi 0.65 and was removed, not relabeled as Pi 0.85.1.
From a copied source tree with Pi 0.85.1 `@earendil-works/pi-coding-agent`,
`@earendil-works/pi-tui`, TypeBox 1.x (`typebox`), TypeScript and Node types:

```sh
node --experimental-transform-types --test test/test.ts test/*.test.ts
tsc --noEmit -p tsconfig.json
```

New tests are `test/herdr.test.ts`, `test/orchestrator.test.ts`, and
`test/workflows.test.ts`. They import local source directly; no
`PI_SUBAGENTS_TEST_SOURCE`/`PI_PERMISSION_TEST_SOURCE` opt-in or patch substitution
is used. The obsolete tmux live harness and duplicated Markdown-parser smoke
tests were replaced by local-source Herdr launch/resume/IPC tests. The main
upstream suite retains its session, activity, rendering and sandbox assertions,
with discovery and message expectations updated for this fork. Tests of the
external permission implementation belong in that fork, not this package.

The dependency-free runtime/workflow subset can also run directly:

```sh
node --experimental-transform-types --test test/orchestrator.test.ts test/workflows.test.ts
```

## Upstream Reference

## How it works

`subagent()` returns immediately. The sub-agent runs in its own tmux pane — a right split off the parent pi pane, so pane creation never steals keyboard focus. A live widget above the input tracks every running sub-agent, and when one finishes, its result is steered into the main session as a notification that triggers a new turn.

```
╭─ Subagents ──────────────────────────── 2 running ─╮
│ 00:23  scout      active · bash 7m                 │
│ 00:45  scout-2    waiting 2m                       │
╰────────────────────────────────────────────────────╯
```

Spawn several in parallel — they run concurrently and steer results back independently as each finishes.

Panes are kept evenly sized: the extension re-applies an `even-horizontal` layout after every spawn and exit (debounced). The layout is a single constant, `SUBAGENT_TMUX_LAYOUT` in `pi-extension/subagents/tmux.ts` — change it to any named tmux layout (`main-vertical`, `tiled`, …).

If your shell startup is slow and launch commands get dropped before the prompt is ready, raise the delay:

```bash
export PI_SUBAGENT_SHELL_READY_DELAY_MS=2500   # default: 500
```

## Tools

| Tool | Description |
| --- | --- |
| `subagent` | Spawn a sub-agent in a dedicated tmux pane (async) |
| `subagent_message` | Message a sub-agent by name — steers it if running, resumes its session if finished |
| `subagents_list` | List available agent definitions |
| `ask_question` | *(sub-agent sessions only)* Ask the orchestrator a question and wait for the reply |

There is also a `/subagent <agent> <task>` command for spawning directly.

### Spawning

```typescript
subagent({ agent: "scout", task: "Analyze the auth module" });
subagent({ agent: "worker", name: "dark-mode", task: "Implement the dark mode toggle" });
```

| Parameter | Type | Default | Description |
| --------- | ---- | ------- | ----------- |
| `agent` | string | required | Which agent to spawn (must be known and permitted) |
| `task` | string | required | Task prompt |
| `name` | string | agent name | Display name for the pane and widget. Must be unique — duplicates are auto-suffixed (`scout`, `scout-2`, …) |
| `model` | string | agent's model | Override the model for this spawn |
| `cwd` | string | agent's `cwd` | Working directory (see [Role folders](#role-folders)) |

### Messaging

`subagent_message` is addressed **by name only**. Names are unique per session and persist after a sub-agent finishes, so the same name works either way:

```typescript
subagent_message({ name: "scout", message: "Also check the auth middleware" });
```

- **Running** — the message is typed into the live pane (newlines flattened) and picked up at the next turn boundary. The call returns immediately; the eventual completion still arrives as a steer message.
- **Finished** — the session is resumed with the message as the follow-up task, like a fresh spawn: fire-and-forget, always autonomous, result steered back later. The resumed run reclaims its original name.

Every spawn records name → session file in `artifacts/<sessionId>/subagent-registry.json`, so names stay addressable across pi restarts. A nested sub-agent that spawns children gets its own registry keyed by its own session id. Resume is refused with a clear error (listing known names) if the name isn't registered, the session file is gone, or the session predates sandboxed resume.

**Resume replays the original sandbox.** At spawn time the fully-resolved loadout — tool allowlist, backing extensions, model, thinking level, system prompt, spawn whitelist, cwd — is snapshotted to `<session>.loadout.json`. Resume rebuilds the exact same restricted process from that snapshot rather than relaunching unrestricted.

### ask_question

A sub-agent can ask its orchestrator a single freeform question when requirements are ambiguous or a decision materially affects the work. The session **stays open** (parked as `waiting`) instead of exiting; the parent is notified with the sub-agent's name, replies via `subagent_message({ name, message })`, and the reply arrives as the sub-agent's next turn. Parallel questions are supported — each waiting sub-agent has its own name.

If the reply arrives while the sub-agent is still mid-turn, it is absorbed into the current turn — either way the question is marked answered and the session exits normally when the work is done. If the parent never replies, the pane stays open until a human closes it. Only available inside sub-agent sessions.

## Bundled agents

| Agent | Model | Tools | Role |
| ----- | ----- | ----- | ---- |
| **scout** | `openrouter/z-ai/glm-5.3` | `read`, `grep`, `find`, `ls` | Fast read-only codebase recon |
| **researcher** | `openrouter/z-ai/glm-5.3` | `web_search`, `web_fetch`, `safe_bash` | Web research, synthesized into a sourced brief |
| **worker** | `openrouter/z-ai/glm-5.3` | `read`, `write`, `edit`, `bash`, `web_search`, `web_fetch` + spawning | General implementer; may spawn `scout` and `researcher` |

All three are autonomous (`auto-exit: true`) and carry their identity in the system prompt (`system-prompt: append`).

## Custom agents

Place a `.md` file in `.pi/agents/` (project) or `~/.pi/agent/agents/` (global). Discovery priority: **project > global > package-bundled** — a project-local file overrides a bundled agent with the same name.

```markdown
---
name: my-agent
description: Does something specific
model: openrouter/z-ai/glm-5.3
thinking: medium
tools: read, edit, write, safe_bash, web_search
session-mode: lineage-only
auto-exit: true
---

You are a specialized agent that does X...
```

### Frontmatter reference

| Field | Type | Description |
| ----- | ---- | ----------- |
| `name` | string | Agent name (used in `agent: "my-agent"`) |
| `description` | string | Shown in `subagents_list` |
| `model` | string | Default model |
| `thinking` | string | `minimal`, `low`, `medium`, or `high` |
| `tools` | string | Strict tool allowlist. Built-ins: `read`, `write`, `edit`, `bash`, `grep`, `find`, `ls`. Extension-backed: `web_search`, `web_fetch`, `safe_bash`, `video_extract`, `youtube_search`, `google_image_search`. Only the extensions backing the listed tools are loaded into the child |
| `subagent_agents` | string | Comma-separated agent names this agent may spawn. **Presence of this field grants the spawning toolset** (`subagent`, `subagent_message`, `subagents_list`) and restricts spawn targets to the list. Omit it and the agent cannot spawn at all |
| `skills` | string | Comma-separated skill names to auto-load |
| `session-mode` | string | `standalone` (default), `lineage-only`, or `fork` — see below |
| `system-prompt` | string | `append` or `replace`: pass the body as the child's `--append-system-prompt` / `--system-prompt`. Omit and the body is prepended to the task prompt instead |
| `auto-exit` | boolean | Auto-shutdown when the agent finishes (see below) |
| `interactive` | boolean | Whether stall/recovery transitions wake the parent (see below) |
| `cwd` | string | Default working directory |
| `disable-model-invocation` | boolean | Hide from `subagents_list`; still spawnable by explicit name |
| `cli` | string | `claude` runs the agent via the Claude Code CLI instead of pi |

### session-mode

- `standalone` — fresh session, no lineage link to the caller (default)
- `lineage-only` — fresh session with `parentSession` linkage for discovery/fork UX, but no copied turns
- `fork` — child session seeded with the caller's conversation context

### auto-exit

With `auto-exit: true`, the session shuts down when the agent's turn ends — the agent just writes its final message and stops (there is no "done" tool). The last assistant message becomes the summary returned to the parent. Recommended for all autonomous agents.

Notes:

- **Manual input does not strand an auto-exit sub-agent.** If a human types into the pane, the session still closes once that turn completes normally — only an escape/abort leaves it open.
- **Auto-exit is suppressed while work is in flight:** the session parks as `waiting` instead of exiting when an `ask_question` is still unanswered, or when the agent's own child sub-agents are still running (a worker can stop after dispatching children and stays open until the last result returns).

### interactive

Controls whether `stalled`/`recovered` status transitions send a steer message to the parent session. Defaults to the inverse of `auto-exit`: autonomous agents get stall pings; user-driven agents stay quiet (the user is already working in that pane — the widget still updates). Set explicitly to override.

## Tool access control

Access is **whitelist-only**. Every sub-agent process is launched with `--no-extensions` (extension discovery disabled) and `--tools <allowlist>`; only the extensions backing the listed tools are loaded back in explicitly. There is no default toolset and no deny-list — an agent gets exactly what its frontmatter lists. The restriction survives resume via the loadout snapshot.

Spawns must name a known agent at **every** depth. A top-level session may spawn anything discoverable; a sub-agent may only spawn the agents in its `subagent_agents` list (enforced via `PI_SUBAGENT_ALLOWED`). There is no agentless spawn route, so a child can never escalate to a full-toolset profile by omitting its agent.

Extensions can register additional tools for sub-agents at runtime via `registerToolExtension(name, path)` on the `__pi_interactive_subagents` process global.

## Role folders

`cwd` starts a sub-agent in a directory with its own config, so role-specific setups (CLAUDE.md, skills, extensions) apply:

```
project/
└── agents/
    ├── game-designer/   ← CLAUDE.md, .pi/…
    └── sre/             ← CLAUDE.md, .pi/…
```

```typescript
subagent({ agent: "worker", cwd: "agents/sre", task: "Review the deployment pipeline" });
```

Set a per-agent default with `cwd:` in frontmatter.

## Status widget & configuration

The widget tracks each sub-agent from a runtime activity snapshot written by the child: `starting`, `active` (turn/provider/tool work), `waiting` (open for input or another stage), `stalled` (no valid snapshot for too long), or `running` (fallback). Sub-agent sessions also show their own tools widget — toggle it with `Ctrl+Alt+O`. Completion messages expand with `Ctrl+O`.

Status display is configured via `config.json` in the extension directory (copy `config.json.example`; it's gitignored):

```json
{
  "status": { "enabled": true }
}
```

## Requirements

- [pi](https://github.com/badlogic/pi-mono)
- [tmux](https://github.com/tmux/tmux)

```bash
tmux new -A -s pi 'pi'
```

## Acknowledgements

Forked from [HazAT/pi-interactive-subagents](https://github.com/HazAT/pi-interactive-subagents), which originated the subagent architecture, the multi-multiplexer surface layer, and the status widget; its supervision features were inspired by [RepoPrompt](https://repoprompt.com/).

## License

MIT
