# trellis-crew

👷🏻‍♀️🌱 Build anything, grow smarter

trellis-crew sets up a small team of agent sessions that split work, hand
off tasks, and report status. It sits on Trellis, an open framework,
and ships free under the MIT licence. Peer messaging runs on three
tiers. Tier one is native: Claude Code and Qwen Code ship a peer list,
an addressed send, and a delivery outcome per message today. Tier two
is a general path: a harness that speaks the Agent2Agent protocol
moves a task to another agent, as Hermes Agent does now. Tier three is
a shared mailbox, for every other harness checked. A shared local MCP
mailbox is the tier-three default path. A shared file is the fallback
for a reader who runs no server. This folder holds draft skills and a
manifest, not yet an installed plugin. The code's permanent home is a
decision still open on the build issue.

## Use the CLI

The `trellis-crew` command line tool installs the plugin on your harness
and starts, lists, and stops your team. A harness is the agent tool that
runs each session, such as Claude Code or Codex CLI.

### Get the CLI

You need Node.js 24 or later. When the package is on npm, install it
with `npm install -g trellis-crew`. From a clone of this repository, run
these commands in its folder:

```
npm ci
npm run build
npm link
```

### Set it up once

Run `trellis-crew install`. The CLI looks for each harness it knows and
asks you to confirm the one it found. Then it installs the plugin on that
harness and writes your choice to `~/.trellis-crew/install.yml`.

- `--harness <name>` picks the harness and skips the search. The names
  are `claude-code`, `qwen-code`, `hermes`, `codex`, `amp`, and
  `opencode`.
- `--transport <name>` picks how sessions send messages. The names are
  `native`, `a2a`, and `file`.
- `--non-interactive` asks no question. It takes the best candidate.
- `--reconfigure` asks again, even when `install.yml` holds a choice.

On Claude Code and Qwen Code, install also sets your user settings file
to accept messages from other sessions. It first copies the file to a
dated backup beside it, and it prints both paths.

### Run your team

1. Write your roles file. Copy `sagespec.example.yml` to `sagespec.yml`
   and change it. With no roles file, the CLI starts the default team.
2. Run `trellis-crew start`. It reads `./sagespec.yml`. Pass
   `--roles <file>` to read another file. When `start` finds
   `./sagespec.yml` on its own, it prints the file's path and each
   kickoff message, and it asks before it starts anything. A cloned
   folder can hold another author's prompts. Add `--yes` to skip the
   question in a script. With no terminal and no `--yes`, it starts
   nothing.
3. Run `trellis-crew status` to list each session and its state.
4. Run `trellis-crew stop` to end the team. It ends only the processes
   the CLI started, and then it removes the team record.

`trellis-crew start` also takes `--workers N`, which sets the number of
workers, and `--merge-reporters`, which joins the default team's auditor
and researcher into one session.

To restart one session with new settings, run
`trellis-crew respawn <name>`. It takes `--model`, `--effort`, and
`--autocompact`. A flag that you leave out keeps the value from the
roles file. The session starts again with an empty context. So run it
only between units of work.

To check for a newer CLI and update the plugin, run
`trellis-crew update`. Add `--check` to change nothing. The CLI prints
your harness's own update command, and it never runs that command.

### What each harness does

The launch fields `autocompact`, `model`, and `effort` are checked on
Claude Code only. On every other harness, the CLI ignores each field
that you set and prints a warning that names the session and the field.

- Claude Code starts each session in the background with `claude --bg`.
  The CLI records no process for it. So `stop` and `respawn` cannot end
  it, and `stop` tells you so.
- Qwen Code starts each session as its own `qwen -p` process. The first
  prompt tells the session its name.
- Hermes Agent sessions do not start on their own. The CLI prints the
  `hermes chat -p <name>` command and the kickoff message for each one.
  You start each session in its own terminal.
- Codex CLI sessions start under one supervisor process. `start` returns
  at once. The supervisor starts each `codex exec` process and records
  its process ID. `stop` ends the supervisor and each session.
- Amp starts each session as a titled thread on the vendor's servers.
  No command to stop a thread is documented. So `stop` leaves each
  thread running and prints its ID when the CLI has it.
- Any other harness, such as OpenCode, gets the kickoff message for
  each session printed. The CLI runs nothing on it.

By default, on every harness except Claude Code and Qwen Code, sessions
talk through a file mailbox. The default folder is
`~/.trellis-crew/mailbox`. Set `mailbox` in the roles file to use
another folder.

### Exit codes

- `0`: the command finished.
- `1`: a step failed, or a documented gap stopped a step. The output
  names the step.
- `2`: a flag or the roles file is wrong. Nothing was started or
  stopped.

### Known gaps

Some facts that the CLI needs are not documented yet. The CLI names each
gap when it reaches one, and it never guesses.

- The plugin install source on Qwen Code, Hermes Agent, Amp, and
  OpenCode.
- The session ID format that `claude --bg` prints, and the thread ID
  format that `amp -ox` prints.
- A way to keep a finished `codex exec` process running. The supervisor
  does not restart a session that ends.
- A way to give a new Hermes Agent chat its first prompt.

## Your config: the tree and the prompts

A trellis-crew config has two halves. The roles file, `sagespec.yml`,
sets the team layout: which sessions run, who reports to whom, and how
each one starts. The agent definitions are the other half. They are the
prompts that tell each session how to do its role. The two halves form
one config, and you change either one to change how your team works.

## The agent definitions

The agent definitions ship as skills in `skills/`. Hanna Sage wrote
them, and Sage Advice LLC publishes them as open source under the MIT
licence.

| Skill | What it defines |
|---|---|
| `department-lead` | The lead, who names each peer and sends work |
| `department-standby` | A worker, who waits for a hand-off and claims it |
| `department-auditor` | The auditor, who checks the team on a fixed clock |
| `department-reporting-chain` | The reporting chain, which carries decisions to the operator |
| `department-researcher` | The researcher, who answers one question at a time from cited sources |
| `department-handoff-contract` | The hand-off block that a lead sends with each task |
| `department-audit-log` | The log line that the auditor writes for each check |

## Build your own config

1. Copy `sagespec.example.yml` to `sagespec.yml`, and change the team to
   fit your work.
2. Start from the shipped agent definitions. Run your team on them first.
3. Write your own agent definitions. Change a shipped prompt in
   `skills/`, or write your own skill and name it in the `kickoff`
   message of the session that uses it.

## The sanitizer

This repository is public. The sanitizer keeps private text out of it.
Run it with `npm run sanitize`. It scans every tracked file, the staged
diff, and the messages of a range of commits. It fails on four classes
of text.

1. Secrets: an API key or token prefix followed by a full key, a
   private-key block, a committed `.env` file, and a password inside a
   URL.
2. Internal names from your deny-list.
3. Private paths: an absolute home path, such as `/Users/<name>/` or
   `/home/<name>/`, and socket paths.
4. Ticket links to any GitHub repository other than
   sageadvicellc/trellis-crew, and links to a private tracker.

A finding names the class, the file, and the line. It never prints the
text it found.

### The deny-list file

The deny-list is never committed. Keep it in a local file and point the
`SANITIZE_DENYLIST` environment variable at it. CI writes the same
content from the `SANITIZE_DENYLIST_CONTENT` repository secret.

- Write one term per line. A term matches in any letter case, and only
  as a whole word. A term may hold spaces.
- A line that starts with `#` is a comment.
- A line `allow <path> <term>` clears one term in one file. The path is
  relative to the repository root. The allowance never applies to a
  commit message.

```
# deny-list
project-codename
allow docs/history.md project-codename
```

When `SANITIZE_DENYLIST` is unset, a local run prints a warning and still
runs the other three checks. With `SANITIZE_REQUIRE_DENYLIST=1`, an unset
deny-list fails the run. CI and `prepublishOnly` set that variable, so CI
stays red until the maintainer adds the secret.

### The committed allowlist

`.sanitize-allow` holds reviewed false positives for the secret,
private-path, and ticket-link classes. Each line is `<path> <class>`. It
never holds a deny-list allowance.

### The commit range

`npm run sanitize -- --range <base>..<head>` scans the messages in that
range. The `SANITIZE_RANGE` variable does the same. With neither, the
range is `origin/main..HEAD` when `origin/main` exists.

### The pre-push hook

`.githooks/pre-push` runs the sanitizer on the commits you push. Turn it
on once per clone with `git config core.hooksPath .githooks`. CI runs the
same checks on every pull request and push.
