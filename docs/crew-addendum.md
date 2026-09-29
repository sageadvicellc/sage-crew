# trellis-crew: role modules and `crew.yml`, spec addendum

Status: draft, 2026-09-29. Specification only. Nothing here is built, and
the maintainer approves this design before any build starts. Extends
`docs/cli-addendum.md`. Sources are listed at the end, each with its
retrieval date. A fact that the vendor documentation does not state is
written as a gap.

## Purpose

Today `trellis-crew start` reads `sagespec.yml`. Each session there has
one of four built-in roles (`lead`, `standby`, `auditor`,
`reporting-chain`) and an inline `kickoff` string. The agent definitions
are the flat `skills/department-*` plugin skills, shared by every session.

This addendum adds a second path. A person opens a terminal in any
project folder and runs `trellis-crew up`. The CLI reads the project
config, `crew.yml`, finds a crew repository, and starts one harness in
the foreground, in that same terminal window. That foreground session is
the front role. It then starts the crew's other roles as background
sessions on the same harness. The CLI opens no other window or terminal.

A role module is a folder of plain files: a role prompt, a catalog,
skills, and memory. The CLI maps those files onto the chosen harness's
native format through that harness's adapter.

The `sagespec.yml` path stays as it is. Section 9 covers compatibility.

The existing commands `install`, `start`, `status`, `stop`, and `respawn`
are defined in `docs/cli-addendum.md`. The `Adapter` interface, with its
`launch` and `installPlugin` steps, is in `src/adapters/types.ts`.

## 1. The commands

```
trellis-crew up [--config crew.yml] [--update] [--dry-run]
trellis-crew spawn
trellis-crew down
```

- `up` reads `crew.yml` from the project root, validates it, resolves the
  crew repository, and loads every role module. Then it replaces its own
  process with the harness, started in the foreground in the same
  terminal, as the front role.
- `spawn` starts the background roles. The front session runs it once,
  as its first action (section 5). It is not for a person to run.
- `--dry-run` prints the foreground command, each background command, and
  each generated file, and starts nothing.
- `--update` fetches the crew repository before it loads anything.
  Section 3 covers this.
- `down` stops every background session that `spawn` started. It uses the
  same `team.json` record as `trellis-crew stop`. The foreground session
  ends when the person exits it.

The project root is the top level of the git work tree that holds the
current directory. Outside a git work tree, the project root is the
current directory. The CLI never changes to a directory outside the
project root, and it never assumes a fixed home path or a fixed root.

## 2. The project config: `crew.yml`

```yaml
version: 1
harness: claude-code          # the one harness for this window and the whole crew
crew:
  path: ../my-crew            # a local crew repository, relative to the project root
  # git: https://example.com/owner/my-crew.git
  # ref: main
require:                      # files that must exist in the project root
  - AGENTS.md
front: lead                   # the role that runs in the foreground
roles:
  - role: lead                # a folder name under roles/ in the crew repository
    model: <model>            # optional; unset means the harness default
  - role: worker
    lanes: 3                  # background sessions of this role; default 1
  - role: reviewer
```

| Field | Required | Meaning |
|---|---|---|
| `version` | yes | Schema version, `1`. |
| `harness` | yes | The one harness for the crew: `claude-code`, `codex`, or `cursor`. |
| `crew.path` | one of `path`, `git` | A local crew repository. A relative path resolves against the project root. `~` expands to the home directory. |
| `crew.git` | one of `path`, `git` | A git remote URL for the crew repository. Only `https://` and `ssh://` (or `git@host:`) URLs are accepted. |
| `crew.ref` | no | The branch, tag, or commit to use with `crew.git`. Default: the remote's default branch. |
| `require` | no | Files that must exist in the project root before anything starts. |
| `front` | yes | The role that runs in the foreground. It names one entry in `roles`, by its `role` or `builtin` value. |
| `roles[].role` | one of `role`, `builtin` | The role module name: lowercase letters, digits, and hyphens. |
| `roles[].builtin` | one of `role`, `builtin` | A built-in role: `lead`, `standby`, `auditor`, or `reporting-chain`. Section 9 covers it. |
| `roles[].kickoff` | with `builtin` only | The first prompt for a built-in role, as in `sagespec.yml`. |
| `roles[].permission_mode` | no | The permission mode for a background session: `manual`, `acceptEdits`, `auto`, `dontAsk`, or `plan`. Default: `manual`. Section 6 covers it. |
| `roles[].restricted` | no | `true` adds the harness's restricted mode. Default: `false`. Section 7 covers it. |
| `roles[].model` | no | Passed to the harness's model flag. |
| `roles[].lanes` | no | An integer from 1 to 10. Default: 1. The front role always has one lane. |
| `roles[].name` | no | The session name prefix. Default: the value of `role`, or of `builtin` for a built-in entry. |

Checks before anything starts. Each failed check prints the file, the line,
the field, and the reason, then exits with code 2 and starts nothing.

- `crew.path` and `crew.git` are not both set, and one of them is set.
- `harness` has an adapter, and the harness is installed and detected.
- `front` names exactly one entry in `roles`, and that entry has no
  `lanes` value above 1.
- Each `roles` entry sets exactly one of `role` and `builtin`. A
  `builtin` entry sets `kickoff`, and a `role` entry does not.
- Each `roles[].role` names a folder that exists in the crew repository.
- Each module passes the module checks in section 4.
- No `permission_mode` is `bypassPermissions`. That value fails the
  check, because the CLI never starts a session that skips permission
  checks.
- No two sessions share a name. Section 6 gives the naming rule.
- Each file under `require` exists in the project root.

An unknown field fails the check. It is not ignored, so a spelling
mistake cannot silently change the team. A `harness` field on a role
entry is an unknown field in version 1.

## 3. Resolving the crew repository

1. The environment variable `TRELLIS_CREW_PATH`, when set, overrides
   `crew.path` and `crew.git`. It is for tests and for local development
   of a crew.
2. With `crew.path`, the CLI reads that folder in place. The folder must
   hold a `roles/` folder.
3. With `crew.git`, the CLI keeps one clone per URL under
   `~/.trellis-crew/crews/<hash of the URL>/`. The first `up` clones it.
   Each later `up` uses the cached clone as it is. `up --update` fetches
   and checks out `crew.ref`. The CLI prints the commit it loaded, so a
   run can be repeated.
4. The CLI never runs code from the crew repository. Section 4 covers
   start scripts.
5. Crew content is trusted input. Its `role.md`, skills, and memory
   become prompt content for every session. Use only a crew repository
   whose content you trust as much as your own instructions.
6. With `crew.git`, `up` refuses to start when the cached clone has
   local changes, and tells the person to run `up --update`. A session
   can write into its module folder (section 5), so this check keeps a
   change made in one run out of the next.

## 4. The role module

A role module is the folder `roles/<name>/` in the crew repository.

| Path | Required | Use |
|---|---|---|
| `role.md` | yes | The role's system prompt. |
| `catalog.yml` | yes | The public index of the module: skills, scripts, and the start entry. |
| `skills/<skill>/SKILL.md` | no | The role's skills, one folder each. |
| `memory/*.md` | no | Reference files that the session reads at start. |
| `start.sh`, `START.md` | no | Manual start instructions for a person. The CLI does not read or run them. |

`catalog.yml`:

```yaml
skills:
  - name: triage
    description: Classify an incoming message and route it.
    path: roles/lead/skills/triage/SKILL.md
scripts:
  - name: ready-check
    description: Report whether a pull request is ready.
    path: roles/lead/scripts/ready_check.py
start:
  name: Lead                  # the display name; lanes add a suffix
  prompt: Read catalog.yml and every file under memory/, then wait for a task.
```

Module checks:

- `role.md` and `catalog.yml` exist and are regular files.
- Each `path` is relative to the crew repository root and resolves inside
  `roles/<name>/`. An absolute path, a `..` segment, or a symbolic link
  that leaves the module fails the check.
- Each skill `path` names a `SKILL.md` file that exists.
- `start.prompt` is required. `start.name` is optional.
- Every file under `memory/` is a regular `.md` file. Their total size is
  at most 256 KiB, so the start prompt stays bounded.

The catalog is data. The CLI never runs a catalog script or a start
script. A script that a role needs runs later, from inside the session,
under that harness's own permission rules.

## 5. The start sequence

Every session, front or background, receives the same four inputs from
its module. The adapter maps them onto the harness's format, as section 7
describes.

1. The role prompt: `role.md`.
2. The first prompt: `start.prompt`, followed by the list of `memory/`
   files as paths the session can read.
3. The module folder: tool access to `roles/<name>/`. On Claude Code,
   `--add-dir` allows tool access, which includes writes, not only reads.
   This addendum offers no read-only guarantee for the module folder.
   `--restricted` does not give one, because it confines the file tools
   to the working directories, and those include each `--add-dir` folder
   (section 7).
4. The skills: each `SKILL.md` that the catalog lists.

The sequence:

1. `up` validates the config and every module, and writes a start plan.
   The plan folder `~/.trellis-crew/plan/` has mode 0700. The plan file
   has mode 0600 and a random 128-bit id, written as 32 hex characters,
   as its file name.
2. The plan holds data, not commands: for each background session, its
   role, lane, name, module path, model, and permission mode. It never
   holds a command line.
3. `up` computes the SHA-256 hash of the plan file. Then it replaces its
   process with the front session, in the foreground, in the same
   terminal. Two environment variables go to that session:
   `TRELLIS_CREW_PLAN`, the plan id, and `TRELLIS_CREW_PLAN_SHA256`, the
   hash.
4. The front session's first prompt starts with one extra line: run
   `trellis-crew spawn`, then continue with the role's own start prompt.
   The front session runs it through its own shell tool, under the
   harness's own permission rules, so the person sees and approves it.
5. `spawn` checks the plan before it starts anything:
   - `TRELLIS_CREW_PLAN` is 32 hex characters. `spawn` reads only
     `~/.trellis-crew/plan/<id>.json`. The variable is never a path.
   - The file is a regular file, not a symbolic link, owned by the
     current user, with mode 0600.
   - Its SHA-256 hash equals `TRELLIS_CREW_PLAN_SHA256`.
   - Each module path passes the module checks in section 4 again.
6. `spawn` builds each launch command itself, through the adapter's
   `background` step, from the plan's data. It starts each background
   session, records each one in `team.json`, and exits.
7. Any failed check starts nothing and names the check. A plan runs once:
   `spawn` renames it to `<id>.used` before it starts the first session,
   so a second `spawn` on the same plan starts nothing and says so.

On Claude Code, the front command is
`claude --name <name> --append-system-prompt-file <role.md> --plugin-dir <stage plugin> [--model M] "<first prompt>" --add-dir <module folder>`.
The prompt comes before `--add-dir`, because `--add-dir` accepts more
than one directory and would otherwise read the prompt as a directory.
Each background command is the same command with
`--bg --permission-mode <mode>` added. The CLI never passes
`--dangerously-skip-permissions` or `--permission-mode bypassPermissions`
to any session.

## 6. Foreground, background, and lanes

- The front role runs in the foreground: an interactive session in the
  terminal where the person ran `up`. On Claude Code this is `claude`
  without `-p` and without `--bg`.
- Every other role runs in the background. A background session opens
  no window and no terminal. On Claude Code this is `--bg`, which returns
  at once. On Codex it is the existing supervisor from
  `docs/cli-addendum.md` section 2. On Cursor it is a supervised
  `agent -p` process.
- A background session has no person at its terminal to answer a
  permission prompt. It runs in the role's `permission_mode`, default
  `manual`. A person opens a background session in the terminal with
  `claude attach <id>`. Gap: this addendum does not verify that a prompt
  in `manual` mode waits for an attach, rather than failing the tool
  call. A build verifies it first. The foreground session asks
  its own person in the normal way. `bypassPermissions` is never allowed
  (section 2).
- `lanes: N` starts N background sessions of a role. With N equal to 1,
  the session name is the role's `name`. With N above 1, the names are
  `<name>-1` to `<name>-N`.
- Every background session is recorded in `~/.trellis-crew/team.json`,
  with its role, the harness, and the crew commit that it loaded.

## 7. Adapters

The crew runs on one harness, chosen by `harness` in `crew.yml`. Each
harness has one adapter, so any harness with an adapter can be the chosen
one. Each adapter implements the existing `Adapter` interface in
`src/adapters/types.ts`, plus three new steps:

- `stage(module, session)` returns the files to generate for a session.
- `foreground(module, session)` returns the command that replaces `up`.
- `background(module, session)` returns the command that `spawn` runs.

Every generated file goes under `~/.trellis-crew/stage/<session>/`,
outside the project, unless this section says otherwise. `down` deletes
the stage folder of each session that it stops.

### Claude Code

The foreground start, the background start, the permission mode, and the
per-session skills route are each documented, either in the vendor
documentation or in the local `claude --help`.

- Foreground: `claude` with a positional prompt starts an interactive
  session with that prompt. Background: `--bg` starts a background
  session and returns at once.
- Permission mode: `--permission-mode <mode>` for each background
  session, from the role's `permission_mode`. A role can also set
  `restricted: true`, which adds `--restricted`. That flag removes the
  tools that run commands or code, confines the file tools to the
  working directories, `--add-dir` folders included, and refuses
  `bypassPermissions`. So a restricted session can still write in the
  module folder. It cannot write outside the project root and the module
  folder.
- Role prompt: `--append-system-prompt-file <role.md>`.
- Module folder: `--add-dir <module folder>`. This allows tool access,
  including writes. The docs state that most `.claude/` configuration in
  an added directory is not discovered, so the skills need their own
  route.
- Skills: the adapter builds a local plugin in the stage folder from the
  catalog's skills, and passes it with `--plugin-dir <stage plugin>`,
  which loads a plugin for that session only. Nothing is installed at
  user scope, so a crew adds no skills to any other session.
- Memory: the first prompt lists the memory files. The session reads
  them with its own tools.

### Codex

- Background: `codex exec -C <project root> --add-dir <module folder> [-m M] --sandbox workspace-write "<first prompt>"`,
  under the existing supervisor.
- Foreground: gap. This addendum did not verify that `codex` with a
  positional prompt and the same flags starts the interactive terminal
  interface. A build verifies it first.
- Role prompt: Codex reads `AGENTS.md` from `~/.codex/`, then from the git
  root down to the working directory. The adapter writes the role prompt
  as `AGENTS.md` in a per-session Codex home folder in the stage folder,
  and sets `CODEX_HOME` to it. Gap: the docs name `~/.codex/AGENTS.md`,
  and do not state that `CODEX_HOME` moves that file. If it does not
  move, the fallback is a `--profile` that sets the instructions, subject
  to the same check.
- Skills: Codex reads skills from `.agents/skills` in the working
  directory, the repository root, and the home directory. How a staged
  skills folder reaches one Codex session without writing into the
  project is a gap.
- Credentials: each parallel session uses its own credential file.

### Cursor

- Background: `agent -p --workspace <project root> [--model M] "<first prompt>"`,
  supervised.
- Foreground: gap. This addendum did not verify the flags that start the
  interactive `agent` terminal with a first prompt. A build verifies it
  first.
- Role prompt: Cursor reads project rules only from `.cursor/rules/*.mdc`
  in the workspace. The adapter writes `.cursor/rules/crew-<session>.mdc`
  with `alwaysApply: true`. This is the one adapter that writes inside
  the project. The CLI adds the file to `.git/info/exclude`, so it is
  never committed, and `down` removes it. This is a decision for the
  maintainer (section 11, item 2).
- Skills: Cursor reads skills from `.cursor/skills/` and `.agents/skills/`
  in the project, and from the same names in the home directory. The
  adapter stages them under `.cursor/skills/crew-<session>-<skill>/`, with
  the same exclude and removal as the rule file.
- Memory: listed in the first prompt, as on Claude Code.

### Routing between harnesses

Version 1 runs one harness for the whole crew, so it routes nothing
between harnesses. The Codex and Cursor adapters stay off until a
routing design is published in this repository. That design covers
three terms for each vendor: whether its terms of service allow an
outside program to drive its CLI, which of the crew's rules its CLI can
follow and which need a wrapper, and whether its remaining usage can be
read.

## 8. The project-root check

Before it starts anything, `up` checks the project root.

1. The project root resolves as section 1 describes.
2. Every file under `require` exists there.
3. The front session and every background session start with the project
   root as their working directory.

A failed check prints the missing file and starts nothing. No absolute
default path exists. A crew that needs a specific root names it through
`require`.

## 9. Compatibility with `sagespec.yml`

- `trellis-crew start` keeps its current behavior. It reads `sagespec.yml`
  or `--roles <file>`, with the four built-in roles, all in the
  background.
- `trellis-crew up` reads only `crew.yml`. It ignores `sagespec.yml`.
- A `crew.yml` role can name a built-in role as `builtin: lead` in place
  of `role:`, with an inline `kickoff`. That session uses the built-in
  skills, exactly as `sagespec.yml` does today. So one team can mix
  built-in roles and module roles. Section 2 lists the fields and the
  checks.
- `team.json` gains three optional fields: `role_module`, `harness`, and
  `crew_commit`. An older entry without them stays valid.
- `status`, `stop`, and `respawn` work on sessions from either path.

## 10. Gaps this addendum closes

Each line names a gap between the current CLI and a role-module crew, and
the section above that closes it.

1. The role name is an enum with no folder lookup: sections 2 and 4.
2. There is no start entry other than the inline kickoff: section 5.
3. There is no catalog reader: section 4.
4. There is no role prompt file, so the role lives only in the kickoff: sections 5 and 7.
5. There is no tool access to the role folder: section 5 (`--add-dir`).
6. There is no memory reader: sections 4 and 5.
7. Skills are flat and shared by every session: section 7, per adapter.
8. There is no project-root check before a start: section 8.
9. Only background sessions are supported: sections 5 and 6 add the foreground front session.
10. Crew modules start in several different ways: section 5 gives one start sequence for all of them.
11. The display name drifts from the role name: section 6 takes the name from `catalog.yml` and `crew.yml`.
12. Start scripts hold an absolute default root: sections 3 and 8 remove every absolute default.

## 11. Decisions for the maintainer

1. The command name: `trellis-crew up`, as written here, or a separate
   `crew` binary.
2. The Cursor adapter writes a rule file and skills inside the project,
   excluded from git and removed by `down`. The alternatives are to accept
   that, or to leave Cursor out until it documents a rules path outside
   the workspace.
3. Whether `crew.git` can name a private remote, which needs the user's
   own git credentials, or only a public one. Either way, crew content
   is trusted input (section 3).
4. The memory size cap of 256 KiB.

## Later work

- Multi-harness crews: a `harness` field per role, so one crew mixes
  Claude Code, Codex, and Cursor sessions. This waits for the routing
  design's open decisions and for each adapter's foreground and
  background checks.
- A foreground session on Codex or Cursor, once a build verifies each
  one's interactive start flags.

## Checks before a build

A build checks these claims against the vendor documentation first:

- Claude Code: the prompt placed before `--add-dir`, and `.claude/`
  discovery in an added folder.
- Codex: the `codex exec` flags, and the `AGENTS.md` and skills paths.
- Cursor: `agent -p --workspace`, and the rules and skills paths.
- Codex and Cursor: whether hooks run in non-interactive mode.
- Every link under Sources.

## Gaps

- Claude Code: whether a permission prompt in a `manual` background
  session waits for `claude attach`, or fails the tool call, is not
  verified here.
- Codex: the interactive start flags, and whether `CODEX_HOME` moves the
  global `AGENTS.md` and the skills folder, are not verified here.
- Cursor: the interactive start flags are not verified here, and the
  subagent file format is not published on the page read.
- Codex and Cursor: whether hooks run in non-interactive mode is not
  published.

## Sources

Retrieved 2026-09-29.

- Claude Code CLI reference, the positional prompt and the flags
  `--append-system-prompt-file`, `--add-dir`, `--name`, `--model`, `--bg`:
  https://code.claude.com/docs/en/cli-reference
- Claude Code local help, `claude --help` and `claude attach --help` in
  Claude Code 2.1.285: the flags `--permission-mode`, `--restricted`,
  `--plugin-dir`, and `--add-dir`, and the `attach <id>` command.
- Claude Code skills, project and nested locations:
  https://code.claude.com/docs/en/skills
- Claude Code subagents, `.claude/agents/`:
  https://code.claude.com/docs/en/sub-agents
- Claude Code memory, `CLAUDE.md` and `AGENTS.md` discovery:
  https://code.claude.com/docs/en/memory
- Codex `AGENTS.md` discovery:
  https://learn.chatgpt.com/docs/agent-configuration/agents-md
- Codex skills: https://learn.chatgpt.com/docs/build-skills
- Codex non-interactive mode: https://learn.chatgpt.com/docs/non-interactive-mode
- Codex CLI flags `-C`, `-m`, `--add-dir`, `--profile`:
  https://learn.chatgpt.com/docs/developer-commands?surface=cli
- Codex local help, `codex exec --help` in codex-cli 0.157.0: the flags
  `-C`, `-m`, `--add-dir`, and `--sandbox`, with the values `read-only`,
  `workspace-write`, and `danger-full-access`.
- Cursor rules: https://cursor.com/docs/context/rules
- Cursor CLI, the flags `-p`, `--model`, and `--workspace`:
  https://cursor.com/docs/cli/overview and
  https://cursor.com/docs/cli/using
- Cursor skills: https://cursor.com/docs/skills
