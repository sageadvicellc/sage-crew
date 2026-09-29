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

This addendum adds a second path. A person runs one command from the root
of any project. The CLI reads a project config, `crew.yml`, finds a crew
repository, loads one role module for each configured role, and starts
each role on the harness that the config names. A role module is a folder
of plain files: a role prompt, a catalog, skills, and memory. The CLI maps
those files onto each harness's native format through that harness's
adapter.

The `sagespec.yml` path stays as it is. Section 9 covers compatibility.

## 1. The command

```
trellis-crew up [--config crew.yml] [--update] [--dry-run]
trellis-crew down
```

- `up` reads `crew.yml` from the project root, validates it, resolves the
  crew repository, loads each role module, and starts the sessions.
- `--dry-run` prints each launch command and each generated file, and
  starts nothing.
- `--update` fetches the crew repository before it loads anything.
  Section 3 covers this.
- `down` stops every session that `up` started. It uses the same
  `team.json` record as `trellis-crew stop`.

The project root is the top level of the git work tree that holds the
current directory. Outside a git work tree, the project root is the
current directory. The CLI never changes to a directory outside the
project root, and it never assumes a fixed home path or a fixed root.

## 2. The project config: `crew.yml`

```yaml
version: 1
crew:
  path: ../my-crew            # a local crew repository, relative to the project root
  # git: https://example.com/owner/my-crew.git
  # ref: main
require:                      # files that must exist in the project root
  - AGENTS.md
roles:
  - role: lead                # a folder name under roles/ in the crew repository
    harness: claude-code      # claude-code | codex | cursor
    mode: interactive         # interactive | background
    model: <model>            # optional; unset means the harness default
    lanes: 1                  # sessions of this role; default 1
  - role: worker
    harness: codex
    mode: background
    lanes: 3
```

| Field | Required | Meaning |
|---|---|---|
| `version` | yes | Schema version, `1`. |
| `crew.path` | one of `path`, `git` | A local crew repository. A relative path resolves against the project root. `~` expands to the home directory. |
| `crew.git` | one of `path`, `git` | A git remote URL for the crew repository. Only `https://` and `ssh://` (or `git@host:`) URLs are accepted. |
| `crew.ref` | no | The branch, tag, or commit to use with `crew.git`. Default: the remote's default branch. |
| `require` | no | Files that must exist in the project root before anything starts. |
| `roles[].role` | yes | The role module name: lowercase letters, digits, and hyphens. |
| `roles[].harness` | yes | `claude-code`, `codex`, or `cursor`. |
| `roles[].mode` | no | `interactive` or `background`. Default: `background`. |
| `roles[].model` | no | Passed to the harness's model flag. |
| `roles[].lanes` | no | An integer from 1 to 10. Default: 1. |
| `roles[].name` | no | The session name prefix. Default: the value of `role`. |

Checks before anything starts. Each failed check prints the file, the line,
the field, and the reason, then exits with code 2 and starts nothing.

- `crew.path` and `crew.git` are not both set, and one of them is set.
- Each `roles[].role` names a folder that exists in the crew repository.
- Each module passes the module checks in section 4.
- Each `harness` has an adapter that is installed and detected.
- At most one role uses `mode: interactive`, because one terminal holds
  one interactive session.
- No two sessions share a name. Section 6 gives the naming rule.
- Each file under `require` exists in the project root.

An unknown field fails the check. It is not ignored, so a spelling
mistake cannot silently change the team.

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

## 5. The start entry

Every harness receives the same four inputs from the module. The adapter
maps them onto its own format, as section 7 describes.

1. The role prompt: `role.md`.
2. The first prompt: `start.prompt`, followed by the list of `memory/`
   files as paths the session can read.
3. The module folder: read access to `roles/<name>/`.
4. The skills: each `SKILL.md` that the catalog lists.

On Claude Code, the launch order is fixed as
`claude --name <name> --append-system-prompt-file <role.md> [--model M] "<first prompt>" --add-dir <module folder>`.
The prompt comes before `--add-dir`, because `--add-dir` takes one or
more directories and would otherwise read the prompt as a directory.
A background session adds `--bg`.

## 6. Modes and lanes

- `background` starts each session detached and returns at once. On
  Claude Code this is `--bg`. On Codex it is the existing supervisor from
  `docs/cli-addendum.md` section 2. On Cursor it is a supervised
  `agent -p` process.
- `interactive` starts the session in the current terminal, after all
  background sessions have started. On Claude Code this is `claude`
  without `-p` and without `--bg`. Codex and Cursor are background only in
  this addendum, and a config that sets `interactive` for them fails the
  check.
- `lanes: N` starts N sessions of the role. With N equal to 1, the
  session name is the role's `name`. With N above 1, the names are
  `<name>-1` to `<name>-N`.
- Every session is recorded in `~/.trellis-crew/team.json`, with its role,
  harness, mode, and the crew commit that it loaded.

## 7. Adapters

One adapter for each harness implements the existing `Adapter` interface
in `src/adapters/types.ts`, plus one new step, `stage(module, session)`.
That step returns the launch arguments and the files to generate. Every
generated file goes under `~/.trellis-crew/stage/<session>/`, outside the
project, unless this section says otherwise. `down` deletes the stage
folder of each session that it stops.

### Claude Code

- Role prompt: `--append-system-prompt-file <role.md>`.
- Module folder: `--add-dir <module folder>`. The docs state that most
  `.claude/` configuration in an added directory is not discovered, so
  the skills need their own route.
- Skills: the adapter builds a local plugin in the stage folder from the
  catalog's skills, and installs it through the existing `installPlugin`
  step. Gap: a per-session plugin directory flag is not verified in this
  addendum. Until a build verifies one, the plugin is installed at user
  scope and is shared across Claude Code sessions.
- Memory: the first prompt lists the memory files. The session reads
  them with its own tools.
- A subagent file under `.claude/agents/` is not generated, because the
  role runs as the main session, not as a subagent.

### Codex

- Launch: `codex exec -C <project root> --add-dir <module folder> [-m M] --sandbox workspace-write "<first prompt>"`,
  under the existing supervisor.
- Role prompt: Codex reads `AGENTS.md` from `~/.codex/`, then from the git
  root down to the working directory. The adapter writes the role prompt
  as `AGENTS.md` in a per-session Codex home folder in the stage folder,
  and sets `CODEX_HOME` to it. Gap: the docs name `~/.codex/AGENTS.md`,
  and do not state that `CODEX_HOME` moves that file. A build verifies
  this first. If it does not move, the fallback is a `--profile` that
  sets the instructions, subject to the same check.
- Skills: Codex reads skills from `.agents/skills` in the working
  directory, the repository root, and the home directory. The adapter
  stages the catalog's skills in the stage folder. How a staged skills
  folder reaches one Codex session without writing into the project is a
  gap.
- Credentials: each parallel session uses its own credential file. The
  routing design below explains why.

### Cursor

- Launch: `agent -p --workspace <project root> [--model M] "<first prompt>"`,
  supervised.
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

This addendum does not decide which harness takes which task, and it does
not restate the terms-of-service or parity findings for Codex and Cursor.
Those live in the maintainer's separate routing design for Codex and
Cursor, which this addendum reuses as is. The Codex and Cursor adapters
stay off until that design's open decisions are closed.

## 8. The project-root check

Before it starts anything, `up` checks the project root.

1. The project root resolves as section 1 describes.
2. Every file under `require` exists there.
3. All sessions start with the project root as their working directory.

A failed check prints the missing file and starts nothing. No absolute
default path exists. A crew that needs a specific root names it through
`require`.

## 9. Compatibility with `sagespec.yml`

- `trellis-crew start` keeps its current behavior. It reads `sagespec.yml`
  or `--roles <file>`, with the four built-in roles.
- `trellis-crew up` reads only `crew.yml`. It ignores `sagespec.yml`.
- A `crew.yml` role can name a built-in role as `builtin: lead` in place
  of `role:`. That session uses the built-in skills and an inline
  `kickoff`, exactly as `sagespec.yml` does today. So one team can mix
  built-in roles and module roles.
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
5. There is no read access to the role folder: section 5 (`--add-dir`).
6. There is no memory reader: sections 4 and 5.
7. Skills are flat and shared by every session: section 7, per adapter.
8. There is no project-root check before a start: section 8.
9. Only background sessions are supported: section 6.
10. Crew modules start in several different ways: section 5 gives one start contract for all of them.
11. The display name drifts from the role name: section 6 takes the name from `catalog.yml` and `crew.yml`.
12. Start scripts hold an absolute default root: sections 3 and 8 remove every absolute default.

## 11. Decisions for the maintainer

1. The command name: `trellis-crew up`, as written here, or a separate
   `crew` binary.
2. The Cursor adapter writes a rule file and skills inside the project,
   excluded from git and removed by `down`. The alternatives are to accept
   that, or to leave Cursor out until it documents a rules path outside
   the workspace.
3. Whether `crew.git` may name a private remote, which needs the user's
   own git credentials, or only a public one.
4. The memory size cap of 256 KiB.

## Gaps

- Claude Code: a flag that loads a plugin or skills folder for one
  session only is not verified here.
- Codex: whether `CODEX_HOME` moves the global `AGENTS.md` and the
  skills folder is not stated in the docs read here.
- Codex and Cursor: whether hooks run in non-interactive mode is not
  published. The routing design records this gap too.
- Cursor: the subagent file format is not published on the page read.

## Sources

Retrieved 2026-09-29.

- Claude Code CLI reference, flags `--append-system-prompt-file`,
  `--add-dir`, `--name`, `--model`, `--bg`:
  https://code.claude.com/docs/en/cli-reference
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
- Cursor rules: https://cursor.com/docs/context/rules
- Cursor CLI: https://cursor.com/docs/cli/overview and
  https://cursor.com/docs/cli/using
- Cursor skills: https://cursor.com/docs/skills
