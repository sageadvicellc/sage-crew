# sage-crew CLI: spec addendum

Status: draft, 2026-09-28. Extends the sage-crew plugin specification.
Sources are listed at the end, each with its retrieval date. A fact the
vendor's own documentation does not state is written as a gap.

## Purpose

A person who has never run two agent sessions at once types one command
and gets a working team. The plugin carries the skills. The CLI, named
`sage-crew`, does the three things the plugin cannot: it finds the agent
harness on the machine, installs the plugin the way that harness expects,
and starts the right number of named sessions, each with its own kickoff
message. The team then runs as separate sessions, not as subagents inside
one chat, so no single context window fills up and no subagent cap is
touched.

Commands:

```
sage-crew install            # detect the harness, confirm it, install the plugin
sage-crew update             # update the CLI and the plugin
sage-crew start [--workers N] [--roles roles.yml]   # start the team
sage-crew status             # list the team's sessions and their state
sage-crew stop               # stop every session the CLI started
sage-crew --roles roles.yml  # shorthand for start with a roles file
```

## 1. Harness detection and confirmation

The CLI never guesses silently. It probes, shows what it found, and asks.

### Probe

For each supported harness, in the order below, the CLI checks three
things: the binary is on `PATH`, the version command answers, and the
configuration directory exists. One hit is a candidate; three hits is a
confident candidate.

| Harness | Binary | Version command | Configuration directory | Tier |
|---|---|---|---|---|
| Claude Code | `claude` | `claude --version` | `~/.claude` (or `CLAUDE_CONFIG_DIR`) | one, native |
| Qwen Code | `qwen` | gap: no shell-level version flag documented; `/about` inside a session | `~/.qwen` | one, native |
| Hermes Agent | `hermes` | `hermes --version` | `~/.hermes` | two, A2A |
| Codex CLI | `codex` | gap: `--version` not confirmed on a fetched page | `~/.codex` (or `CODEX_HOME`) | three, mailbox |
| Amp | `amp` | `amp version` | `~/.config/amp` (path from a search snippet, not a fetched page) | three, mailbox |

Every other harness in the plugin specification's tier table is detected
by binary name only and lands on tier three.

### Confirm

The CLI prints one line per candidate, best tier first, and asks:

```
Found Claude Code 2.1.x at /opt/homebrew/bin/claude (tier one, native messaging).
Found Codex CLI at /usr/local/bin/codex (tier three, shared mailbox).
Use Claude Code? [Y/n/other]
```

`--harness <name>` skips the question. `--non-interactive` takes the best
candidate and prints the choice. With no candidate the CLI stops and
prints the install page of each supported harness. The choice is written
to `~/.sage-crew/config.yml` and reused until the reader runs
`sage-crew install --reconfigure`.

### Transport follows the tier

Tier one uses the harness's own peer messaging. Tier two uses A2A when
the reader has configured the gateway, and the mailbox otherwise. Tier
three uses the shared local MCP mailbox by default and the file mailbox
with `--transport file`. The transport is a field in the roles file and
the CLI fills it from the tier when the field says `auto`.

## 2. How each harness starts N named sessions

The CLI starts each session as its own operating-system process, records
the process id, the session name, and the harness's own session id in
`~/.sage-crew/team.json`, and sends the kickoff message as the session's
first prompt. `sage-crew status` reads that file. `sage-crew stop` ends
each process it started and nothing else.

### Claude Code, tier one

Claude Code documents a background mode: `claude --bg "<prompt>"` starts a
session and returns at once, printing the session id and the commands to
manage it. `--name <name>` sets the display name at start, and `/rename`
changes it later. `--bg` cannot be combined with `-p`. The CLI starts each
session as:

```
claude --bg --name main "<kickoff message>"
```

Peer messaging is built in. A session lists its peers with the
`ListAgents` tool and sends plain text to one by name with `SendMessage`.
On macOS and Linux the message travels over a per-session Unix domain
socket, never through the vendor's servers. Inbound messages are governed
by the `crossSessionInbound` setting, with `accept`, `hold`, or `refuse`;
the CLI sets it to `accept` for the team's sessions so a busy peer queues
a message instead of asking a person to approve it. The documented queue
holds 50 accepted messages, and a session in a container cannot reach one
on the host. A `-p` session binds an inbox socket too unless `--bare` is
set, so a headless worker can still receive.

Why sessions and not subagents: Claude Code caps concurrently running
subagents at 20 per session by default, and every subagent draws on the
parent's context and usage. A team of separate sessions leaves that cap
untouched and gives each role its own context window.

Kickoff delivery: the kickoff message is the `--bg` prompt itself. A
second message, from the reporting chain, arrives through `SendMessage`
once every session is listed by `ListAgents`.

### Qwen Code, tier one

Qwen Code documents headless mode with `qwen -p "<text>"`, a rename
command `/rename <name>` inside a session, `qwen sessions ps` to list the
interactive sessions running, and a same-machine cross-session protocol
with a session registry, addressed send by name, and delivery receipts.
Gaps: no shell-level flag to name a session at start, and no shell-level
detach flag, are documented. The CLI therefore starts each session as its
own process with `qwen -p`, gives it a name through the first prompt, and
reads `qwen sessions ps` for status. The exact setting names and defaults
of the cross-session protocol are cited only from the documentation page
named in the sources, and the CLI treats them as a gap until a build
verifies them against a running install.

### Hermes Agent, tier two

Hermes documents `hermes chat` for an interactive session, `/bg <prompt>`
inside a session for a background task with a numbered id, and
`hermes sessions` for rename, export, and delete. Its documented peer
messaging, `hermes peer dm <peer> < message.txt`, runs between machines
through each machine's gateway with a key, not between two sessions on
one machine. Gap: no shell-level detach flag and no same-machine
session-to-session messaging are documented. The CLI starts each session
as its own `hermes chat` process under a profile named after the session
(`-p <name>`), and uses the mailbox transport on one machine. A reader
who has set up the gateway on two machines can set `transport: a2a` and
name each peer's URL and key in the roles file.

### Codex CLI, tier three

Codex documents `codex exec "<prompt>"` for non-interactive runs, with
`--json` for event output and `--output-last-message <file>` for the
final message, and `codex exec resume <session id or name>` to continue
one. Gaps: no background or detach flag, no flag to name a session at
start, and no cross-session messaging are documented. The CLI starts each
session as its own `codex exec` process, keeps the process alive under its
own supervision, and gives each one the mailbox tools through the
harness's MCP client configuration in `~/.codex/config.toml`. Each session
polls the mailbox on its own schedule, because Codex has no open channel
to wait on.

### Amp, tier three

Amp documents `amp -ox "<prompt>"` to start a thread that runs on the
vendor's servers and returns at once, `--title` to name the thread at
creation, and `amp threads continue <id> -ox "<message>"` to send it a
later message. Its agent-to-agent feature lets a running agent start
another and send it instructions, in natural language. Gap: no way for two
already-running threads to discover each other is documented. The CLI
starts each session as a titled thread and uses the mailbox transport,
where every thread reads and writes the shared inbox.

### Every other tier-three harness

The CLI starts one process per session with the harness's headless
command, names the session in the kickoff message, and points the session
at the mailbox. With `--transport file`, each session reads and writes its
own file in the mailbox folder and sees a new message the next time it
opens the file.

## 3. The default team

Without a roles file, `sage-crew start` creates four reporter sessions
and N workers.

| Session | Role | Reports to | What it does |
|---|---|---|---|
| `personal-assistant` | reporting chain | the operator | carries one line per decision to the operator and takes every report |
| `main` | lead | `personal-assistant` | holds the work, owns the workers, sends hand-offs by name |
| `benchmark` | auditor | `personal-assistant` | reads each session's job record on a clock, writes one log line per check |
| `research` | researcher | `personal-assistant` | answers one cited question at a time |
| `worker-1` to `worker-N` | standby | `main` | takes a hand-off, reports done or idle |

Whether `benchmark` and `research` start as two sessions or one, and the
default N, are open choices on the pull request that carries this
document.

### The reporting chain

Every message that needs the operator's own answer flows up one edge at a
time: a worker reports to `main`, `main`, `benchmark`, and `research`
report to `personal-assistant`, and `personal-assistant` writes one line
to the operator. No session skips a level. A reply from the operator flows
back down the same edges. A relayed reply never counts as the operator's
own approval inside another session's permission layer; an irreversible
step is confirmed by the session that would take it.

### Kickoff messages

Each session's first prompt is its kickoff message from the roles file.
Once every session appears in the peer list, the three reporters send one
message each:

1. `personal-assistant` to every session: "I am the reporting chain. Send
   me one line per change. Decisions go to the operator through me."
2. `main` to each worker: the hand-off contract's three parts for the
   first unit of work, or "No work yet; wait for a hand-off addressed to
   you."
3. `benchmark` to `personal-assistant`: "Auditor clock started at
   <time>, interval <clock>. First check at <time>."

`research` sends nothing at kickoff; it waits for a question.

## 4. The roles file

`sage-crew --roles roles.yml` replaces the default team. The file is YAML.
`roles.example.yml` in this repository matches the default team.

| Field | Where | Required | Meaning |
|---|---|---|---|
| `version` | top | yes | schema version, `1` |
| `harness` | top | no | `auto` or a harness name; `auto` runs detection |
| `transport` | top | no | `auto`, `native`, `a2a`, `mcp-mailbox`, `file-mailbox` |
| `mailbox` | top | no | folder for the mailbox transports |
| `operator` | top | no | how kickoff messages name the person |
| `sessions[].name` | session | yes | the session's address; lowercase, hyphens |
| `sessions[].role` | session | yes | `lead`, `standby`, `auditor`, `researcher`, `reporting-chain` |
| `sessions[].reports_to` | session | yes | a session name or `operator` |
| `sessions[].workers` | session | lead only | the names this lead owns |
| `sessions[].clock` | session | auditor only | check interval, such as `30m` |
| `sessions[].kickoff` | session | yes | the first prompt, multi-line |

Rules the CLI checks before it starts anything: every `reports_to` names
a session in the file or `operator`; exactly one session has the
`reporting-chain` role; every worker is owned by exactly one lead; no name
repeats. A failed check prints the line and starts nothing.

## 5. Install and update

### `sage-crew install`

1. Detect and confirm the harness, as in section 1.
2. Install the plugin the way that harness documents:

| Harness | Documented install path | Installed location |
|---|---|---|
| Claude Code | `claude plugin marketplace add <marketplace>` then `claude plugin install sage-crew@<marketplace>` | `~/.claude/plugins/` |
| Qwen Code | `qwen extensions install <repository url>` | `~/.qwen/extensions/sage-crew/` |
| Hermes Agent | `hermes skills install <source>` | `~/.hermes/skills/` |
| Codex CLI | copy each skill folder into `~/.agents/skills/` | `~/.agents/skills/<skill>/` |
| Amp | `amp skill add <source> --global` | `~/.config/agents/skills/` |

3. Write `~/.sage-crew/config.yml` with the harness, the transport, and
   the installed plugin version.
4. For a mailbox transport, write the MCP mailbox entry into the harness's
   own MCP configuration, or create the mailbox folder for the file
   transport.

The plugin is published on each harness's own plugin channel, never on a
separate marketplace; that was decided in the plugin specification.

### `sage-crew update`

1. Compare the CLI's own version with the latest published version on its
   registry and print both; the registry is an open choice on the pull
   request that carries this document.
2. Update the plugin through the harness: `claude plugin update
   sage-crew@<marketplace>` on Claude Code, `qwen extensions update` on
   Qwen Code, `hermes skills install` again on Hermes, `amp skill update
   sage-crew` on Amp, and a fresh copy of the skill folders on Codex.
3. Print the harness's own update command without running it: `claude
   update`, `hermes update`, `amp update`, and the installer script for
   Codex. Gap: no update command for Qwen Code itself is documented.
4. Rewrite the version fields in `~/.sage-crew/config.yml`.

`sage-crew update --check` prints the versions and changes nothing.

## Open choices

Four choices are posed as decision comments on the pull request that
carries this document: the CLI's language and packaging, the default
worker count, whether `benchmark` and `research` start as two sessions,
and where the CLI is published. The first three carry a default. The
fourth has none.

## Gaps

- Codex CLI documents no background flag, no session-name flag, and no
  cross-session messaging, so the CLI supervises each process itself.
- Qwen Code documents no shell-level version flag, no name-at-start flag,
  and no detach flag; the cross-session protocol's setting names were not
  re-read from a single fetched page.
- Hermes Agent documents no same-machine session-to-session messaging and
  no shell-level detach flag.
- Amp documents no discovery between two already-running threads, and its
  configuration path was read from a search snippet, not a fetched page.
- No harness other than Claude Code documents a cap on concurrent
  subagents or sessions.
- No measurement exists yet for how many sessions one machine runs before
  the harness or the model provider rate-limits them.

## Sources

1. Claude Code CLI reference and headless mode, `--bg`, `--name`, `-p`,
   `--bare`: https://code.claude.com/docs/en/cli-reference and
   https://code.claude.com/docs/en/headless, retrieved 2026-09-28.
2. Claude Code cross-session messaging, `ListAgents`, `SendMessage`, the
   per-session socket, `crossSessionInbound`, the 50-message queue, the
   container limit: https://code.claude.com/docs/en/cross-session-messaging,
   retrieved 2026-09-28.
3. Claude Code subagent cap, 20 by default:
   https://code.claude.com/docs/en/sub-agents, retrieved 2026-09-28.
4. Claude Code plugin install and update:
   https://code.claude.com/docs/en/plugin-marketplaces and
   https://code.claude.com/docs/en/plugins, retrieved 2026-09-28.
5. Qwen Code headless mode, sessions, rename:
   https://qwenlm.github.io/qwen-code-docs/en/users/features/headless/ and
   https://qwenlm.github.io/qwen-code-docs/en/users/features/commands/,
   retrieved 2026-09-28. Cross-session protocol:
   https://qwenlm.github.io/qwen-code-docs/en/users/features/cross-session-protocol/,
   retrieved 2026-09-28. Extensions:
   https://qwenlm.github.io/qwen-code-docs/en/developers/extensions/extension/,
   retrieved 2026-09-28.
6. Hermes Agent CLI commands, sessions, bot mode and peers, skills:
   https://hermes-agent.nousresearch.com/docs/reference/cli-commands,
   https://hermes-agent.nousresearch.com/docs/user-guide/sessions,
   https://hermes-agent.nousresearch.com/docs/user-guide/bot-mode,
   https://hermes-agent.nousresearch.com/docs/getting-started/quickstart,
   retrieved 2026-09-28.
7. Codex CLI commands, `codex exec`, configuration, skills, install:
   https://developers.openai.com/codex/cli/reference,
   https://developers.openai.com/codex/config-basic,
   https://developers.openai.com/codex/skills, and
   https://developers.openai.com/codex/cli, retrieved 2026-09-28 (served
   from the vendor's learn.chatgpt.com domain by redirect).
8. Amp CLI, orbs, agent-to-agent, skills:
   https://ampcode.com/docs/cli, https://ampcode.com/docs/cli/spawning-orbs,
   https://ampcode.com/docs/orbs/agent-to-agent, and
   https://ampcode.com/docs/customize/skills, retrieved 2026-09-28.
9. The three-tier table and the mailbox design: the sage-crew plugin
   specification, 2026-09-28.
