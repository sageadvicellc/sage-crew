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
sage-crew respawn <name> [--model M] [--effort E] [--autocompact N]
                             # restart one session with new launch flags
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

Each session's launch flags come from its `autocompact`, `model`, and
`effort` fields in the roles file (section 4). A field that the harness
has no matching flag for is ignored: the CLI prints one warning per
ignored field, names the session and the field, and starts the session
anyway. This addendum verifies the three flags on Claude Code only. On
every other harness the CLI treats all three as having no matching flag
until a build verifies one against the vendor's documentation.

### Claude Code, tier one

Claude Code documents a background mode: `claude --bg "<prompt>"` starts a
session and returns at once, printing the session id and the commands to
manage it. `--name <name>` sets the display name at start, and `/rename`
changes it later. `--bg` cannot be combined with `-p`. The CLI starts each
session as:

```
claude --bg --name main --autocompact 600k [--model <model>] [--effort <level>] "<kickoff message>"
```

`--autocompact <auto|tokens>` sets the session's auto-compact window at
launch, as `auto` or a token count from 100k to 1M, and leaves the
reader's saved settings unchanged. `--model <model>` takes an alias or a
full model name. `--effort <level>` takes `low`, `medium`, `high`,
`xhigh`, or `max`. The CLI adds `--model` and `--effort` only when the
session's roles-file entry sets them.

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

How capacity scales: the cap is per session, so every worker the CLI
starts brings its own 20 concurrent subagents. One chat holds 20 in
flight. The default team, three workers plus four reporters, holds up to
140, and each worker's subagents draw on that worker's context, not on
the lead's. Adding a worker adds a full cap, and `--workers N` is the
one setting a reader changes to scale. No other harness documents a
comparable cap, so the same arithmetic holds only for Claude Code until
a vendor states one.

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

The supervisor is a detached process. `sage-crew start` launches it and
returns at once, as Claude Code's `--bg` does. The supervisor starts each
`codex exec` process and keeps it alive. `team.json` records the
supervisor's process id and each child's. `sage-crew stop` ends the
supervisor and its children.

### Amp, tier three

Amp documents `amp -ox "<prompt>"` to start a thread that runs on the
vendor's servers and returns at once, `--title` to name the thread at
creation, and `amp threads continue <id> -ox "<message>"` to send it a
later message. Its agent-to-agent feature lets a running agent start
another and send it instructions, in natural language. Gap: no way for two
already-running threads to discover each other is documented. The CLI
starts each session as a titled thread and uses the mailbox transport,
where every thread reads and writes the shared inbox.

An Amp thread runs on the vendor's servers, so the CLI holds no local
process for it, and no command to stop a thread is documented.
`sage-crew stop` leaves each Amp thread running. For each one, it prints
the thread id and a line that says the thread still runs.

### Every other tier-three harness

The CLI starts one process per session with the harness's headless
command, names the session in the kickoff message, and points the session
at the mailbox. With `--transport file`, each session reads and writes its
own file in the mailbox folder and sees a new message the next time it
opens the file.

### Respawn

`sage-crew respawn <name>` stops one session the CLI started and starts
it again under the same name, with the flags given: `--model`,
`--effort`, or `--autocompact`. A flag that is not given keeps the value
from the roles file. The new session gets its kickoff message again and
starts with an empty context, so the lead runs `respawn` only between
units, after the worker reports done or idle. `team.json` records the new
process id and session id. The new flags last until the next `respawn` or
`stop`; the roles file does not change. A flag the harness cannot take
gets the same warning as at `start`.

## 3. The default team

Without a roles file, `sage-crew start` creates four reporter sessions
and three workers. `--workers N` changes the count.

| Session | Role | Reports to | Autocompact | What it does |
|---|---|---|---|---|
| `personal-assistant` | reporting chain | the operator | `300k` | carries one line per decision to the operator and takes every report |
| `main` | lead | `personal-assistant` | `600k` | holds the work, owns the workers, sends hand-offs by name |
| `benchmark` | auditor | `personal-assistant` | `600k` | reads each session's job record on a clock, writes one log line per check |
| `research` | researcher | `personal-assistant` | `600k` | answers one cited question at a time |
| `worker-1` to `worker-3` | standby | `main` | `400k` | takes a hand-off, reports done or idle, runs up to 20 subagents of its own |

`benchmark` and `research` start as two sessions; `--merge-reporters`
joins them into one named `benchmark-research`, with `600k`. A worker
that `--workers N` adds gets `400k`.

The default team sets no `model` and no `effort`, so each session uses
the harness's own default. Model names change over time, and a published
default would go stale with them.

### The reporting chain

Every message that needs the operator's own answer flows up one edge at a
time: a worker reports to `main`, `main`, `benchmark`, and `research`
report to `personal-assistant`, and `personal-assistant` writes one line
to the operator. No session skips a level. A reply from the operator flows
back down the same edges. A relayed reply never counts as the operator's
own approval inside another session's permission layer; an irreversible
step is confirmed by the session that would take it.

### Kickoff messages

Each session's first prompt is its kickoff message from the roles file,
followed by a start-up block that the CLI generates. The CLI adds the
block for every roles file, the default team's and the reader's own, so
the reporting chain starts the same way on every team. The block holds
the session's capacity line on Claude Code (a worker may run up to 20
subagents at once; a lead may run its worker count times 20) and the
start-up message that session sends, listed below.

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

### Task profiles

A running session cannot change a peer's model; Claude Code documents no
message or setting for that. The lead therefore sets the model and effort
for a unit of work in one of two ways.

1. A task profile, the usual way. The roles file's top-level
   `task_profiles` map names each profile's `model` and `effort`. The
   lead names a profile in the hand-off. The worker runs that unit
   through subagents with the profile's model and effort, and keeps its
   own model and its context. A hand-off that names no profile runs on
   the worker's own `model` and `effort` from the roles file. The lead
   picks the profile; no rule table picks one for it.
2. A respawn, for a unit that must run on the worker's own model. The
   lead runs `sage-crew respawn <name> --model <m> --effort <e>` between
   units, as in section 2. The worker loses its context.

On Claude Code, a subagent takes `model` on each call, and a subagent
definition takes `model` and `effort` in its frontmatter.

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
| `sessions[].name` | session | yes | the session's address; lowercase letters, digits, and hyphens, starting with a letter |
| `sessions[].role` | session | yes | `lead`, `standby`, `auditor`, `researcher`, `reporting-chain` |
| `sessions[].reports_to` | session | yes | a session name or `operator` |
| `sessions[].workers` | session | lead only | the names this lead owns |
| `sessions[].clock` | session | auditor only | check interval, such as `30m` |
| `sessions[].kickoff` | session | yes | the first prompt, multi-line |
| `sessions[].autocompact` | session | no | `auto` or a token count such as `400k`; the auto-compact window at launch |
| `sessions[].model` | session | no | the session's model; unset means the harness default |
| `sessions[].effort` | session | no | the session's effort level; unset means the harness default |
| `task_profiles` | top | no | a map from a profile name to its `model` and `effort`, named by the lead in a hand-off |

Rules the CLI checks before it starts anything: every `reports_to` names
a session in the file or `operator`; exactly one session has the
`reporting-chain` role; every worker is owned by exactly one lead; no name
repeats; every `autocompact` is `auto` or a token count; every task
profile sets `model`, `effort`, or both. On Claude Code, an `autocompact`
count outside 100k to 1M fails, and so does an `effort` other than `low`,
`medium`, `high`, `xhigh`, or `max`. A failed check prints the line and
starts nothing.

`--workers N` together with `--roles` overrides the file. The CLI
replaces the file's `standby` sessions with N generated workers, named
`worker-1` to `worker-N`, each owned by the file's lead and given `400k`.
A file with more than one lead fails with exit code 2, because the CLI
cannot tell which lead owns the new workers.

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

1. Compare the CLI's own version with the latest version published on
   the npm registry under the package name `sage-crew`, and print both.
2. Update the plugin through the harness: `claude plugin update
   sage-crew@<marketplace>` on Claude Code, `qwen extensions update` on
   Qwen Code, `hermes skills install` again on Hermes, `amp skill update
   sage-crew` on Amp, and a fresh copy of the skill folders on Codex.
3. Print the harness's own update command without running it: `claude
   update`, `hermes update`, `amp update`, and the installer script for
   Codex. Gap: no update command for Qwen Code itself is documented.
4. Rewrite the version fields in `~/.sage-crew/config.yml`.

`sage-crew update --check` prints the versions and changes nothing.

## Decisions

The maintainer answered all four choices on 2026-09-28, on the pull
request that carries this document.

1. CLI language and packaging. Answer A: Node, run with
   `npx sage-crew@latest` and installed with `npm install -g sage-crew`.
2. The default worker count. Answer B: three workers. The maintainer's
   words: "workers leverage up to 20 subagents of their own; emphasize
   how the subagent workflow capacity scales." Applied in section 2.
3. Whether `benchmark` and `research` start as two sessions. Answer A:
   split by default.
4. Publishing. Answer A: under the maintainer's own npm account, with
   the package name `sage-crew`, once the CLI's first version passes its
   gates. Nothing is published by the pull request that carries this
   document.

### Implementation plan decisions

The maintainer answered these on 2026-09-28, on issue 4 of this
repository, the CLI's implementation plan. The numbers are the issue's
decision numbers.

- Decision 2: Who keeps `codex exec` alive. Answer A: a detached supervisor.
  `start` returns at once, and `stop` ends the supervisor and its
  children. Applied in section 2.
- Decision 3: The researcher skill and the audit-log fields. Answer A: add a
  `department-researcher` skill and the audit-log field order to the
  specification first. Build steps 1 to 7 of the plan do not wait on
  them; the kickoff and auditor steps do.
- Decision 4: The start-up block on a custom roles file. Answer A: the CLI adds it
  to every roles file. Applied in section 3.
- Decision 5: `--workers` together with `--roles`. Answer B: `--workers N`
  overrides the file's `standby` sessions. Applied in section 4.
- Decision 7: What `stop` does to an Amp thread. Answer B: it leaves the thread
  running and prints its id. Applied in section 2.
- Decision 8: The minimum Node version. Answer B: Node 24, `engines.node >=24`.
- Decision 9: How the lead sets a worker's model for one task. Answer C: task
  profiles by default, and `sage-crew respawn` for a unit that must run
  on the worker's own model. Applied in sections 2, 3, and 4.
- Decision 10: Who picks the model and effort for a task. Answer A: the lead names
  a profile in the hand-off. A hand-off without one uses the worker's
  own `model` and `effort`. Applied in section 3.
- Decision 11: Model and effort in the default team. Answer A: none ship. The
  fields stay unset, and `roles.example.yml` shows them commented out.
  Applied in sections 3 and 4.

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
- The `department-researcher` skill and the audit-log field order are not
  written yet (decision 3).
- `--autocompact`, `--model`, and `--effort` are verified on Claude Code
  only. No other harness's matching flags were checked.
- Claude Code documents no per-call `effort` for a subagent, so a task
  profile's `effort` reaches a subagent only through a subagent
  definition's frontmatter.
- The hand-off contract skill does not yet name a task profile as part
  of a hand-off.

## Sources

1. Claude Code CLI reference and headless mode, `--bg`, `--name`, `-p`,
   `--bare`, `--autocompact`, `--model`, `--effort`:
   https://code.claude.com/docs/en/cli-reference and
   https://code.claude.com/docs/en/headless, retrieved 2026-09-28. The
   three launch flags and their values were also read from
   `claude --help` on version 2.1.284, 2026-09-28.
2. Claude Code cross-session messaging, `ListAgents`, `SendMessage`, the
   per-session socket, `crossSessionInbound`, the 50-message queue, the
   container limit: https://code.claude.com/docs/en/cross-session-messaging,
   retrieved 2026-09-28.
3. Claude Code subagent cap, 20 by default, and a subagent's `model` and
   `effort`: https://code.claude.com/docs/en/sub-agents, retrieved
   2026-09-28. No way for one session to change a peer's model:
   https://code.claude.com/docs/en/agent-teams, retrieved 2026-09-28.
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
