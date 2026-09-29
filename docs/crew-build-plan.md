# trellis-crew build plan: role modules and `crew.yml`

Status: draft for the maintainer's review, 2026-09-29. This is a plan only. It holds no code, and no build starts until the maintainer approves it.

## A. Purpose and scope

This plan turns `docs/crew-addendum.md` into small pull requests. Each one adds a thin piece that a test or a user can run. The plan covers `trellis-crew up`, `spawn`, `down`, the `crew.yml` file, role modules, the start plan, and the Claude Code adapter. The Codex and Cursor adapters come last and stay off. Group D holds the crew changes that wait on the coordinator, which is a separate tool that will start more than one part, crew being one of them. Its spec is not yet published, so group D stays blocked.

Sources for the plan: the crew addendum (cited as "addendum section N"), `docs/cli-addendum.md`, and the code in `src` and `test`. The existing code already provides a `Runner` (`src/runner.ts`), an `Adapter` interface (`src/adapters/types.ts`), `team.json` (`src/store/team-json.ts`), `install.yml`, a probe (`src/detect/probe.ts`), and a sanitizer (`src/sanitize`). The plan reuses them and extends them without breaking them.

## Working rules for every slice

- Tests come first. Write the red tests, watch them fail, then write the smallest change that passes.
- One slice is one pull request. A slice must merge with all earlier gates green.
- Standard gates, called "G" below: `npm run typecheck`, `npm run lint`, `npm test`, `npm run build`, and `npm run sanitize -- --range origin/main..HEAD` with `SANITIZE_DENYLIST` set to a local file.
- Every test uses the existing home guard (`test/setup/home-guard.ts`) and temporary folders. No test touches the real home folder.
- Slices 1 to 8 must not change the output of `install`, `start`, `status`, `stop`, `respawn`, or `update`. The existing test files for those commands must pass unchanged.
- Each command adds its own `USAGE` assertion in its own slice, so the assertion is red before the command exists.
- A name that becomes part of a path uses only the characters `a` to `z`, `0` to `9`, and `-`. It must start with a letter or a digit, so it can never reach a command as an option. It has a length cap (question Q13). This is the "path-safe name rule". Session names, role names, and skill names follow it.
- A term is defined at first use. A "start plan" is a data file that `up` writes and `spawn` reads. A "lane" is one background session of a role. A "front role" is the role that runs in the foreground.

## B. Vertical slices, in build order

### Slice 1. The `crew.yml` parser and its checks

- Goal: read a `crew.yml` text and return a checked config or a list of errors, with no file access beyond the one file and no change to any command.
- Spec: addendum section 2, checks that need no other file.
- Tests first, `test/crew-yml.test.ts`.
  - Red: a valid file parses. A missing `version` or `harness` fails. An unknown field fails, including `harness` on a role entry. Setting both or neither of `crew.path` and `crew.git` fails. `crew.git` accepts only `https://`, `ssh://`, and `git@host:` forms. `front` must name exactly one entry, and that entry cannot have `lanes` above 1. Each role entry sets exactly one of `role` and `builtin`. `builtin` accepts only `lead`, `standby`, `auditor`, and `reporting-chain`, and any other value fails. A `builtin` entry needs `kickoff` and a `role` entry cannot set it. `restricted` must be a boolean and defaults to `false`. `role` names allow only lowercase letters, digits, and hyphens. `lanes` accepts 1 to 10. `permission_mode` accepts the five listed values and rejects `bypassPermissions`. `harness: codex` and `harness: cursor` fail with the message "not built yet". Each error names file, line, field, and reason.
  - Red, path-safe name rule: `roles[].name` accepts only `a` to `z`, `0` to `9`, and `-`, it must start with a letter or a digit, and it cannot be empty. These values each fail: `../../.ssh`, `a/b`, `a\b`, `.`, `..`, `.hidden`, `-x`, `--x`, `Name`, `a b`, a name with a control character, and a name with a Unicode lookalike, such as a Cyrillic `а` or a full-width `-`. A name over the length cap fails, and a name exactly at the cap passes.
  - Skipped until slice 4: two sessions with one name fail.
  - Green: a schema module and a loader that use the `yaml` package already in `package.json`, with line numbers from its line counter.
- Files: add `src/crew/schema.ts`, `src/crew/load.ts`, `test/crew-yml.test.ts`, `test/helpers/crew.ts`. Change nothing else.
- Extra gates: G. Coverage of the new files at 80 percent or more.
- Size: 4 files, about 500 lines. M.
- Depends on: none.
- Notes: the check that the harness is installed and detected needs the probe, so it lives in slice 9.
- Hygiene: fixture text uses placeholder names such as `example-crew` and `worker`. No URL in a fixture except `https://example.com/owner/my-crew.git`.

### Slice 2. Role module checks

- Goal: check one role module folder and return a checked module or a list of errors.
- Spec: addendum section 4.
- Tests first, `test/crew-module.test.ts`.
  - Red: a valid module loads. A missing `role.md` or `catalog.yml` fails. A non-regular file fails. A catalog `path` that is absolute, has `..`, or is a symbolic link leaving the module fails. A skill `path` that does not name an existing `SKILL.md` fails. A missing `start.prompt` fails and a missing `start.name` passes. A file in `memory/` that is not a regular `.md` file fails. Memory over 256 KiB total fails and exactly 256 KiB passes.
  - Red, path-safe name rule: a catalog skill `name` follows the rule from the working rules, including the start character and the length cap. These skill names each fail: `.`, `..`, `../x`, `a/b`, `.hidden`, `-x`, `Name`, a Unicode lookalike, and an empty name. A module folder name that breaks the rule fails too.
  - Green: a module reader with real-path checks, built on temporary folders.
- Files: add `src/crew/module.ts`, `test/crew-module.test.ts`. Extend `test/helpers/crew.ts`.
- Extra gates: G.
- Size: 3 files, about 400 lines. M.
- Depends on: none in code. The slice order puts it after slice 1.
- Hygiene: symbolic link tests link to temporary folders only.

### Slice 3. Project root and the `require` check

- Goal: settle the project root and check the `require` files.
- Spec: addendum sections 1 and 8, items 1 and 2.
- Tests first, `test/crew-root.test.ts`.
  - Red: inside a git work tree the root is its top level. Outside one the root is the current folder. Each `require` file must exist in the root and a missing one is named in the error. The function never returns a folder outside the root and holds no absolute default. Use `test/helpers/git-repo.ts`.
  - Green: a small resolver.
- Files: add `src/crew/project-root.ts`, `test/crew-root.test.ts`.
- Extra gates: G.
- Size: 2 files, about 150 lines. S.
- Depends on: slice 1 (the `require` list type).
- Reworked by group D: slice D1 changes the root rule (decision 5).
- Hygiene: none beyond the standard checks.

### Slice 4. Sessions, lanes, and naming

- Goal: expand the checked config into the list of sessions, with names and lanes.
- Spec: addendum sections 2 and 6.
- Tests first, `test/crew-sessions.test.ts`.
  - Red: `lanes` of 1 gives the plain `name`. `lanes` of 3 gives `<name>-1` to `<name>-3`. The default `name` is the `role` or `builtin` value. The front role always has one lane. A name clash between two sessions fails, including a clash created by a lane suffix. Every final session name, lane suffix included, follows the path-safe name rule and stays under the final-name length cap (question Q13). A base name at its cap with the longest lane suffix passes, and one character more fails. Then turn on the skipped test in `test/crew-yml.test.ts`.
  - Green: a pure expansion function.
- Files: add `src/crew/sessions.ts`, `test/crew-sessions.test.ts`. Change `src/crew/load.ts` to call it.
- Extra gates: G.
- Size: 3 files, about 220 lines. S.
- Depends on: slice 1.
- Hygiene: none beyond the standard checks.

### Slice 5. Resolving the crew repository

- Goal: find the crew folder from `crew.path`, `crew.git`, or `TRELLIS_CREW_PATH`.
- Spec: addendum section 3.
- Tests first, `test/crew-repo.test.ts`, with the recording runner in `test/helpers/recording-runner.ts`.
  - Red: `TRELLIS_CREW_PATH` overrides both fields. `crew.path` resolves against the project root and `~` expands. The folder must hold `roles/`. `crew.git` uses one cache folder per URL hash. The first `up` clones. A later `up` reuses the clone. `--update` fetches and checks out `crew.ref`. The loaded commit is printed. A cache with local changes stops the run and names `up --update`. No step runs code from the crew repository. Each role in `crew.yml` must name a folder under `roles/`, and each module passes slice 2.
  - Red, git safety: a `crew.ref` that starts with `-` fails. A `crew.git` value that starts with `-` fails. A host that starts with `-` fails in both remote forms, `ssh://-o...` and `git@-...:`. The URL goes to `git` after a `--` separator, and the recording runner asserts it. A ref after `--` in `git checkout` would be read as a path, so the resolver first turns the ref into a full commit id with `git rev-parse --verify`, and then checks out that id. The recording runner asserts both steps and their order. A `roles/<name>` folder that is a symbolic link leaving the crew repository fails.
  - Green: a resolver that calls `git` only through the `Runner`.
- Files: add `src/crew/repo.ts`, `test/crew-repo.test.ts`. Extend `src/env.ts` for the cache path. Change `src/crew/load.ts`.
- Reworked by group D: slice D6 moves the clone and the `--update` fetch out of `up` and into install. Build the clone step as its own function that the resolver calls, so D6 can move it to install without a rewrite.
- Extra gates: G. Decision 3 in section E is settled, or the slice keeps the `git` path to what the runner does with the user's own credentials.
- Size: 4 files, about 450 lines. L.
- Depends on: slices 1, 2.
- Hygiene: test remotes are local bare repositories in temporary folders. No real remote URL appears.

### Slice 6. The start plan: write, check, and single use

- Goal: write a plan file and check it before use.
- Spec: addendum section 5, steps 1, 2, 3 (hash), 5, and 7.
- Tests first, `test/crew-plan.test.ts`.
  - Red: the plan folder has mode 0700 and the file has mode 0600. The id is 32 hex characters from a random source. The plan holds data only: the resolved crew repository path, role, lane, name, module path, model, permission mode, and never a command line. The SHA-256 matches the file. Checks fail for a bad id, a path in the id, a symbolic link, a wrong owner, a wrong mode, a wrong hash, and a module that fails the slice 2 checks again. Reading renames the file to `<id>.used` before the first launch. A second read finds nothing and says so.
  - Red, revalidation: the check reads every field again, because a plan with a matching hash can still hold hostile data. It fails when `permission_mode` is `bypassPermissions` or any value outside the five. It fails when `lanes` is outside 1 to 10. It fails when a name breaks the path-safe name rule. It fails when `model` is empty, starts with `-`, or holds a space or a control character. It fails when a module path does not resolve to a folder inside `<crew repository>/roles/`, for an absolute path elsewhere, a `..` segment, and a symbolic link that leaves the crew repository, even when the hash matches the file.
  - Green: a plan module using `src/fs-private.ts` and `src/fs-atomic.ts`.
- Files: add `src/crew/plan.ts`, `test/crew-plan.test.ts`. Change nothing else.
- Extra gates: G. Add tests on the failure order so a failed check never renames the file.
- Size: 3 files, about 480 lines. L.
- Depends on: slices 2, 4.
- Hygiene: fixtures use temporary state folders.

### Slice 7. The first prompt and the memory list

- Goal: build the first prompt for a session from its module.
- Spec: addendum section 5 (input 2, and step 4) and section 7 (memory).
- Tests first, `test/crew-prompt.test.ts`.
  - Red: the prompt is `start.prompt` followed by the list of `memory/` files as paths. The front prompt starts with the one extra line that tells the session to run `trellis-crew spawn`. A background prompt has no such line. Memory content is never inlined. Paths are printed with `src/printable.ts`, so control characters cannot hide text.
  - Green: a prompt composer beside `src/kickoff/compose.ts`, leaving that file unchanged.
- Files: add `src/crew/prompt.ts`, `test/crew-prompt.test.ts`.
- Extra gates: G.
- Size: 2 files, about 150 lines. S.
- Depends on: slice 2.
- Hygiene: none beyond the standard checks.

### Slice 8. The Claude Code adapter: stage, foreground, background

- Goal: turn a session into files and two commands, with no launch yet.
- Spec: addendum sections 5 (front command, background command), 6, and 7 (Claude Code).
- Tests first, `test/crew-claude.test.ts`.
  - Red: `stage` returns the files under `~/.trellis-crew/stage/<session>/`, including a local plugin built from the catalog skills. `foreground` returns `claude --name <name> --append-system-prompt-file <role.md> --plugin-dir <stage plugin> [--model M] "<first prompt>" --add-dir <module folder>`, with the prompt before `--add-dir`. `background` returns the same command plus `--bg --permission-mode <mode>`. `restricted: true` adds `--restricted`. The default mode is `manual`. No command holds `--dangerously-skip-permissions` or `bypassPermissions`. Nothing installs at user scope. Both commands set the working directory to the project root.
  - Red, path safety: `stage` resolves every path it returns and fails when one is not inside the stage root. A session name or a skill name that breaks the path-safe name rule fails before any file is written. The stage root is created with mode 0700. `stage` refuses a stage root that is a symbolic link, a stage root that another user owns, a parent folder, `~/.trellis-crew`, that is a symbolic link or has another owner, and a stage root whose real path differs from `<real path of the home folder>/.trellis-crew/stage`.
  - Green: extend `Adapter` in `src/adapters/types.ts` with optional `stage`, `foreground`, and `background` steps, and implement them in `src/adapters/claude-code.ts`. Every other adapter leaves them unset.
- Files: change `src/adapters/types.ts`, `src/adapters/claude-code.ts`. Add `src/crew/stage.ts`, `test/crew-claude.test.ts`.
- Extra gates: G. Checks V1, V2, V3, V4, and V5 must be done first. The existing `test/plugin-claude.test.ts` and `test/start.test.ts` must pass unchanged.
- Size: 5 files, about 500 lines. L.
- Depends on: slices 4, 7.
- Hygiene: fixture module names are placeholders. The stage folder in tests is a temporary folder.

### Slice 9. `up --dry-run`

- Goal: a user can run `trellis-crew up --dry-run` and see the whole plan, with nothing started.
- Spec: addendum sections 1 and 8.
- Tests first, `test/up-dry-run.test.ts` and additions to `test/args.test.ts` and `test/cli.test.ts`.
  - Red: the `up` command parses `--config`, `--update`, and `--dry-run`. `USAGE` lists `up`. With `--dry-run` the output shows the front command, each background command, and each generated file. No process starts, no plan file is written, and no `team.json` changes. Any failed check exits with code 2 and names file, line, field, and reason. A harness with no adapter fails the harness check. A harness that is not installed and detected fails the check, using the probe. The run prints the crew commit.
  - Green: `runUp` wires slices 1 to 8 together. It adds `up` to `src/args.ts`, `USAGE`, and `dispatch` in `src/cli.ts`.
- Files: add `src/commands/up.ts`, `test/up-dry-run.test.ts`. Change `src/args.ts`, `src/cli.ts`, `src/deps.ts` if needed.
- Extra gates: G.
- Size: 5 files, about 320 lines. M.
- Depends on: slices 3, 5, 6, 8.
- Reworked by group D: D1 changes the root, and D6 removes the `--update` fetch.
- Hygiene: the usage text has no personal name and no absolute path.

### Slice 10. `up`: write the plan and start the front session

- Goal: `up` starts the front session in the foreground with the plan variables.
- Spec: addendum section 5, steps 1 to 4, and section 6.
- Tests first, `test/up.test.ts`.
  - Red: `up` writes a plan, computes its hash, and starts the front command with `TRELLIS_CREW_PLAN` and `TRELLIS_CREW_PLAN_SHA256` set. The session runs in the foreground with no `-p` and no `--bg`. The process opens no other window. The run exits with the code of the front session. Nothing else from the crew starts.
  - Green: the foreground step of `runUp`. Node cannot replace its own process, so the build starts the front session on the same terminal and exits with its code (question Q3). The addendum says "replaces", so slice D7 corrects that line.
- Files: change `src/commands/up.ts`, `src/runner.ts` (a foreground step). Add `test/up.test.ts`. Extend `test/fixtures/bin/claude`.
- Extra gates: G. Check V6 (process replacement) must be done first.
- Size: 4 files, about 250 lines. M.
- Depends on: slice 9, which group D reworks (D1 and D6). Slice 10 changes with it.
- Hygiene: the fixture binary prints its arguments and holds no real path.

### Slice 11. `spawn`: start the background sessions

- Goal: the front session runs `trellis-crew spawn` and the background sessions start.
- Spec: addendum section 5, steps 5 to 7, and section 6.
- Tests first, `test/spawn.test.ts`.
  - Red: `spawn` reads only `<plan folder>/<id>.json` for a valid id. It runs every check from slice 6 first. A failed check starts nothing and names the check. The plan is renamed to `<id>.used` before the first session starts. A second `spawn` starts nothing and says so. Each launch command comes from the adapter's `background` step. Each session is recorded in `team.json`. A launch failure stops the run, keeps the record of the ones that started, and names `trellis-crew down`. A `team.json` that already exists blocks the run (question Q6).
  - Red, hostile plan: `spawn` rejects a plan whose `permission_mode` is `bypassPermissions` or any value outside the five, even when the hash matches the file. It rejects `lanes` outside 1 to 10, a name that breaks the path-safe name rule, a bad `model`, and a module path that does not resolve inside `<crew repository>/roles/`. Nothing starts in any of these cases.
  - Red: `USAGE` lists `spawn`.
  - Green: `runSpawn`, sharing the record code in `src/commands/start.ts`.
- Files: add `src/commands/spawn.ts`, `test/spawn.test.ts`. Change `src/args.ts`, `src/cli.ts`.
- Extra gates: G. Check V3 must already be done, because slice 8 needed it.
- Size: 5 files, about 380 lines. M.
- Depends on: slices 6, 8, 10.
- Hygiene: none beyond the standard checks.

### Slice 12. `team.json` fields, and `status`, `stop`, `respawn` on both paths

- Goal: one team record serves both paths.
- Spec: addendum section 9.
- Tests first: `test/store.test.ts`, `test/status.test.ts`, `test/stop.test.ts`, `test/respawn.test.ts`.
  - Red: `team.json` accepts optional `role_module`, `harness`, and `crew_commit`. An older entry without them stays valid and is rewritten unchanged. `status` lists sessions from both paths. `stop` ends sessions from both paths. `respawn <name>` restarts a module session from the recorded module and crew commit, and refuses when the module changed on disk (question Q8). No `sagespec.yml` test changes.
  - Red, hostile record: a `team.json` file can be edited by hand or by another program, so every value that a command reads from it is checked again. `respawn` fails and starts nothing for a `role_module` that is absolute, has `..`, breaks the path-safe name rule, is a symbolic link that leaves the crew repository, or does not resolve inside `<crew repository>/roles/`. `stop` and `status` skip an entry whose name breaks the path-safe name rule, and print a line that names the entry, and they never pass such a name to a process lookup or a path. `respawn`, `stop`, and `status` also check `session_id` against its format, `pid` as a positive whole number, `harness` against the list of known harnesses, and `crew_commit` as a hex string of 40 or 64 characters. An entry with any bad value is refused or skipped, and a line names it. `respawn` does not take the crew repository path from `team.json`. It resolves the crew repository again from the `crew.yml` of the project, with the slice 5 resolver, and then checks the recorded `crew_commit` against the loaded commit (question Q8).
  - Red, old entries: an entry from the `sagespec.yml` path has none of the new fields, keeps the name it has today, and goes through the checks that exist today. The new name checks apply to an entry that carries `role_module`, `harness`, or `crew_commit`, and to every name that becomes a path.
  - Green: extend `TeamEntry` and its guard in `src/store/team-json.ts`, then the three commands.
- Files: change `src/store/team-json.ts`, `src/commands/status.ts`, `src/commands/stop.ts`, `src/commands/respawn.ts`, and the four test files.
- Extra gates: G. This slice touches existing commands, so run the full existing suite before and after and compare.
- Size: 8 files, about 350 lines. L.
- Depends on: slice 11.
- Hygiene: none beyond the standard checks.

### Slice 13. `down`

- Goal: stop every background session that `spawn` started and clean up.
- Spec: addendum section 1 (down), section 7 (stage folder).
- Tests first, `test/down.test.ts`.
  - Red: `down` reads `team.json` and stops each session with the same code as `stop`. It deletes the stage folder of each session that it stops. It leaves the front session alone. It names any session that has no local process, as `noProcessNote` does today. It is safe to run twice. `USAGE` lists `down`.
  - Red, deletion safety: `down` resolves the real path of each stage folder and deletes it only when that path is inside the stage root. A `team.json` entry named `../../.ssh`, an absolute path, a name with a `/`, and a stage folder that is a symbolic link leaving the stage root each delete nothing, and the run names the entry. A test folder that stands in for the home folder keeps every file.
  - Red, the stage root itself: `down` refuses to delete anything when the stage root is a symbolic link, and names it. It refuses a stage root that another user owns. It also refuses when the parent folder, `~/.trellis-crew`, is a symbolic link or has another owner, and when the real path of the stage root differs from the expected path, `<real path of the home folder>/.trellis-crew/stage`.
  - Red, the gap between check and delete: a check and a delete are two steps, so a folder can change between them. `down` closes the window this way. It runs `lstat` on the stage folder and keeps its device and inode numbers. It renames the folder into a private quarantine folder under the stage root, with mode 0700. It runs `lstat` on the renamed path, refuses a symbolic link, and refuses when the device and inode numbers differ from the first check. Only then does it delete the renamed folder. A test replaces a checked stage folder with a symbolic link to a folder that stands in for the home folder, after the first check and before the rename, using a hook in the helper. Another test does the swap after the rename. In both, nothing outside the stage root is deleted, the run names the entry, and the folder that stands in for the home folder keeps every file.
  - Red, no links followed: the removal never follows a symbolic link. A stage folder that holds a link to an outside folder loses the link and keeps every file in the target.
  - Green: `runDown`, on top of `src/commands/stop.ts`, with one helper that checks a path against the stage root, renames the folder into the quarantine folder, checks it again by `lstat` and by device and inode numbers, and removes without following links.
- Files: add `src/commands/down.ts`, `test/down.test.ts`. Change `src/args.ts`, `src/cli.ts`.
- Extra gates: G. Check V7 (how to stop a Claude Code background session) must be done first.
- Size: 4 files, about 260 lines. M.
- Depends on: slices 11, 12.
- Hygiene: none beyond the standard checks.

### Slice 14. Built-in roles inside `crew.yml`

- Goal: one crew can mix module roles and built-in roles.
- Spec: addendum section 9, third bullet.
- Tests first, `test/crew-builtin.test.ts`.
  - Red: `builtin: lead` with `kickoff` yields a session that uses the built-in skills and the inline kickoff, as `sagespec.yml` does. A team can mix both kinds. A `builtin` entry gets no module checks. The plan holds what `spawn` needs to launch it (question Q5).
  - Green: reuse `composeKickoff` and `launchSession` from `src/commands/start.ts`.
- Files: change `src/crew/sessions.ts`, `src/crew/plan.ts`, `src/commands/spawn.ts`. Add `test/crew-builtin.test.ts`.
- Extra gates: G. The `start` tests must pass unchanged.
- Size: 5 files, about 250 lines. M.
- Depends on: slices 11, 12.
- Hygiene: none beyond the standard checks.

### Slice 15. Docs and the trust rule

- Goal: the README describes `up`, `spawn`, and `down`, and states that crew content is trusted input.
- Spec: addendum sections 1 and 3, item 5.
- Tests first: a new `test/readme.test.ts`.
  - Red: the README has a section for each of `up`, `spawn`, and `down`. It says that the role prompt, the skills, and the memory of a crew repository become prompt content for every session, and that the user must use only a crew repository they trust as much as their own instructions.
  - The `USAGE` assertions are not here. Each one is red in the slice that adds its command (slices 9, 11, and 13).
  - Green: the README text.
- Files: change `README.md`. Add `test/readme.test.ts`. No source change.
- Extra gates: G, plus the sanitizer on all tracked files (`npm run sanitize`).
- Size: 2 files, about 120 lines. S.
- Depends on: slice 14.
- Reworked by group D: the README text about `up` covers the clone and the `--update` fetch that slice D6 moves to install, and the root rule that slice D1 changes. Slice D6 and slice D1 update the README and its test.
- Hygiene: examples use `example-crew` and relative paths.

### Later slices, off until the routing design exists

The addendum says these adapters stay off until a routing design is published in the repository (addendum section 7, "Routing between harnesses"). Before that, `harness: codex` and `harness: cursor` fail the harness check with the message "not built yet". Slice 1 asserts that. Slice L1 removes `codex` from that rejection and flips its test. Slice L2 does the same for `cursor`.

**Slice L1. Codex adapter (off).**

- Goal: `stage`, `foreground`, and `background` for Codex.
- Tests first, `test/crew-codex.test.ts`: the `codex exec -C <project root> --add-dir <module folder> [-m M] --sandbox workspace-write "<first prompt>"` command under the existing supervisor, the per-session `CODEX_HOME`, and one credential file per session. Foreground tests wait for check V8, and until V8 is done the adapter has no `foreground` step.
- Files: `src/adapters/codex.ts`, `test/crew-codex.test.ts`. Change the harness check from slice 1. Size about 380 lines, L.
- Depends on: slice 13, the routing design, checks V8 and V10.
- Hygiene: the fixture `test/fixtures/bin/codex` holds no credential.

**Slice L2. Cursor adapter (off).**

- Goal: `stage`, `foreground`, and `background` for Cursor.
- Tests first, `test/crew-cursor.test.ts`: `agent -p --workspace <project root>`, the `.cursor/rules/crew-<session>.mdc` file with `alwaysApply: true`, the `.git/info/exclude` line, the skills under `.cursor/skills/crew-<session>-<skill>/`, and removal by `down`. Foreground tests wait for check V9, and until V9 is done the adapter has no `foreground` step.
- Files: a new `src/adapters/cursor.ts`, `test/crew-cursor.test.ts`. Change the harness check from slice 1. Size about 430 lines, L.
- Depends on: slice 13, the routing design, decisions 2a and 2b, checks V9 and V10.
- Hygiene: the test checks that no generated rule file is committable.

## C. Not in crew

These jobs are not crew's. They stay out of crew's build. The coordinator spec is not yet published, so each one is marked "pending the coordinator spec".

- Finding a config file above the folder of `crew.yml`. Crew never searches upward. Pending the coordinator spec.
- Starting more than one part, and the order of parts. Pending the coordinator spec.
- Starting or ordering other parts from crew. Crew holds no text that does this. Pending the coordinator spec.

Crew never reads any file or variable that belongs to the coordinator to decide what to do. Crew does own the `export-skills` operation, and slice D5 builds it, gated on the coordinator spec.

## D. Changes that wait on the coordinator spec

This group is gated on the coordinator spec, which is not yet published. It must not start until that spec settles. If the spec changes, this group changes with it. Each item below names the merged crew behavior that it changes. The tests below state crew's own rules. Test details that depend on formats the spec will fix are left open until the spec is published.

Group D changes crew in four ways:

1. No download in `up`. The `crew.git` clone moves from `up` into install (slice D6).
2. The project root is the folder of `crew.yml` (slice D1).
3. A machine-readable description of crew, with `version --json` and `health --json` commands (slices D2, D3, and D4).
4. An `export-skills` operation that writes to the folder it is given and refuses a harness that differs from `crew.yml` (slice D5).

Slice D7 then edits the merged crew addendum to match, and adds rules that the merged addendum lacks. Slices D1, D3, D4, D5, and D6 can merge in any order after the gate opens. Slice D2 needs D3, D4, and D5. Slice D7 comes last.

Slices 3, 5, 9, 10, and 15 build behavior that group D reverses or depends on. Slices 3 and 9 use the root that D1 changes. Slices 5 and 9 use the clone and the `--update` fetch that D6 removes from `up`. Slice 10 depends on slice 9. Slice 15 describes `up` in the README. Either settle D1 and D6 first, or build these slices as written and rework them in group D.

### Slice D1. The project root is the folder of `crew.yml`

- Changes: addendum sections 1 and 8, which define the root as the git top level. Slice 3 and every later use of the root change.
- Tests first, `test/crew-root.test.ts` and `test/up-dry-run.test.ts`.
  - Red: with `--config sub/crew.yml` the root is `sub`. With no `--config` the root is the current folder that holds `./crew.yml`. No upward search happens: a `crew.yml` in a parent folder is not found. `require` files, the working directory of every session, and relative `crew.path` values resolve against that folder. A missing file prints the path searched and exits with code 2.
  - Green: change `src/crew/project-root.ts` and its callers in `src/commands/up.ts` and `src/adapters/claude-code.ts`.
- Files: 4 files, about 150 lines. S.
- Gates: G, and all `up`, `spawn`, and `down` tests re-run.
- Hygiene: fixtures use temporary folders.

### Slice D2. A machine-readable description of crew

- Changes: nothing at run time. It adds a file and a `files` entry in `package.json`.
- Tests first, `test/crew-description.test.ts`.
  - Red: the file parses. It names the commands that crew runs, and it says that install can change user-scope harness settings. The command that starts crew runs `up` with the config path. The file is included in the package. Its exact fields are fixed when the coordinator spec is published.
  - Green: add the file and the `files` entry.
- Files: add the description file, `test/crew-description.test.ts`. Change `package.json`. About 90 lines. S.
- Gates: G, and `npm pack --dry-run` lists the file.
- Depends on: D3, D4, and D5, and question Q9.
- Hygiene: no private name in the file.

### Slice D3. `version --json`

- Changes: `src/args.ts` today knows only `--version` and `-v`, and prints the version alone. A new `version` command with `--json` adds output. The plain output stays as it is.
- Tests first, `test/version-json.test.ts`.
  - Red: `version --json` prints one JSON object that holds the crew version, and its other fields are fixed when the coordinator spec is published. It writes nothing to disk, opens no listener, and uses no network. Exit code 0. Plain `--version` output does not change. `USAGE` lists the command.
  - Green: a new command in `src/args.ts` and `src/cli.ts`.
- Files: change `src/args.ts`, `src/cli.ts`. Add `test/version-json.test.ts`. About 100 lines. S.
- Gates: G.
- Hygiene: none beyond the standard checks.

### Slice D4. `health --json`

- Changes: adds a new command. No existing command changes.
- Tests first, `test/health-json.test.ts`.
  - Red: `health --json` prints one JSON object with a status and a list of checks. The exit code matches the status, and the mapping is fixed when the coordinator spec is published. It writes nothing and opens no listener. It never prints a secret. Which checks it runs is question Q9. `USAGE` lists the command.
  - Green: a command that reuses the probe in `src/detect/probe.ts` and the readers for `install.yml` and `team.json`.
- Files: add `src/commands/health.ts`, `test/health-json.test.ts`. Change `src/args.ts`, `src/cli.ts`. About 220 lines. M.
- Gates: G.
- Hygiene: the output holds no home path. The tests assert it.

### Slice D5. `export-skills`

- Changes: adds a new operation. No existing command changes. Crew owns it and reuses its adapter layer.
- Tests first, `test/export-skills.test.ts`.
  - Red: the operation takes a harness, a skills folder, and an output folder. It writes only inside the output folder, and never in a user scope. It refuses a harness that differs from the `harness` in `crew.yml`, exits with a non-zero code, and names both values. It prints one JSON object with the harness, the skills, and the paths written. Running it twice gives the same files and reports no change the second time. It lists every place it writes. It never runs code from a skill.
  - Red, path safety: a skill name that breaks the path-safe name rule fails. A skill named `..` cannot make the operation write outside the output folder. The operation resolves every path it writes and fails when one is not inside the output folder.
  - Green: a command that calls the adapter's `stage` step for skills only.
- Files: add `src/commands/export-skills.ts`, `test/export-skills.test.ts`. Change `src/args.ts`, `src/cli.ts`. About 300 lines. M.
- Gates: G.
- Depends on: slice 8, because it reuses the adapter `stage` step.
- Hygiene: the output holds no home path. The tests assert it.

### Slice D6. No download in `up`: the clone moves to install

- Changes: addendum sections 3 and 5, which have `up` clone `crew.git` and `up --update` fetch. Slices 5 and 9 change with it.
- What stays and what changes:
  - `up` keeps the rule that it refuses a cache with local changes, and it names the install update option in the message.
  - `up --update` no longer fetches. It exits with code 2 and names install (question Q12).
  - Install reads `crew.git` and `crew.ref` from the `crew.yml` that the current folder holds, or from the file that `--config` names. Install with no `crew.yml` behaves as it does today, so users of `sagespec.yml` see no change.
- Tests first, `test/up-no-fetch.test.ts` and additions to `test/crew-repo.test.ts` and `test/install.test.ts`.
  - Red: `up` never runs a `git clone`, `git fetch`, `git pull`, or any network call. The recording runner asserts that no such command appears, with `crew.git` set and with `--update` set. With `crew.git` set and no cache, `up` stops with code 2 and names install as the step to run. `up` still reads a cache that install made, checks it, and prints the loaded commit. A cache with local changes stops `up` and names the install update option.
  - Red, install: install clones the crew repository from `crew.git` at `crew.ref`, and a second run reuses it. Install with the update option fetches and checks out `crew.ref`. A cache with local changes stops install and says so. Install with no `crew.yml` and with a `sagespec.yml` runs the same steps as before, and the existing `install` tests pass unchanged. The clone rules from slice 5 hold: a ref or URL that starts with `-` fails, and every `git` call passes them after `--`. No step runs code from the crew repository. These install tests are written after question Q11 is answered.
  - Green: move the clone step from the resolver's `up` path into the install command. The resolver only reads the cache.
- Files: change `src/crew/repo.ts`, `src/commands/install.ts`, `src/commands/up.ts`, `src/args.ts`. Add `test/up-no-fetch.test.ts`. Extend two existing test files. About 300 lines. M.
- Gates: G. The existing `install` tests must pass unchanged.
- Depends on: slices 5 and 9, and questions Q11 and Q12.
- Hygiene: test remotes are local bare repositories in temporary folders.

### Slice D7. Addendum follow-up edit

- Changes: the merged crew addendum only. No code changes.
- Tests first: a docs check in `test/docs.test.ts` that reads `docs/crew-addendum.md` and asserts these lines.
  - It has no text that says `up` clones or fetches.
  - It defines the project root as the folder of `crew.yml`.
  - It names the crew description file, `version --json`, `health --json`, and `export-skills`.
  - Its field table says that `roles[].name` and each skill `name` accept only `a` to `z`, `0` to `9`, and `-`, start with a letter or a digit, and stay under a length cap. The merged addendum has this gap.
  - Its section on `respawn`, `stop`, and `status` says that every value read from `team.json` is checked again.
  - Its section on the start plan says that each module path resolves inside `<crew repository>/roles/`.
  - Its section on the stage folder says that `down` refuses a stage root or a parent folder that is a symbolic link, renames the folder into a private quarantine folder, checks it again by `lstat` and by device and inode numbers, and only then deletes it.
  - Its section on the crew repository says that a ref is turned into a commit id with `git rev-parse --verify` before checkout.
  - Its section on the stage folder says that `down` deletes only a resolved path inside the stage root. The merged addendum has this gap too.
  - It says that `up` starts the front session on the same terminal and exits with its code, in place of "replaces its own process".
- Files: change `docs/crew-addendum.md`. Add `test/docs.test.ts`. About 140 lines. S.
- Gates: G, and the sanitizer on all tracked files (`npm run sanitize`).
- Depends on: D1 to D6.
- Hygiene: the edit names no private repository. It refers to the coordinator work as "the coordinator spec".

## E. Decisions and questions

The plan settles none of these. Each item has an owner, lettered options, a default, and the result of each letter. Reply with the item number and a letter.

A default applies only when the owner does not answer, and only for an item that has one. Three items touch security or consent: decision 2a, decision 3, and question Q1. Each says "No default: it waits for its owner" and shows a suggested letter. A suggested letter never applies on its own.

### Decisions

1. **Command name** (addendum section 11, item 1). Owner: the maintainer. Settle before slice 7.
   - A. `trellis-crew up`. Default. Result: no new `bin` entry.
   - B. A separate `crew` binary. Result: a new `bin` entry, and renames in slices 9, 11, 13, and 15 and in the front prompt text of slice 7.
2. **Cursor and the project folder** (addendum section 11, item 2). This is two decisions.
   - 2a. Ruling: can the Cursor adapter write rule files inside the project? Owner: the Tech Lead. Settle before slice L2. No default: it waits for the owner. Suggested letter: A.
     - A. Yes, with a git exclude line and removal by `down`. Result: slice L2 can exist, and its tests cover the exclude line and the removal.
     - B. No. Result: Cursor stays off until Cursor documents a rules path outside the workspace, and slice L2 waits.
   - 2b. Product: does version 1 support Cursor at all? Owner: the maintainer. Settle before slice L2.
     - A. No. Default. Result: slice L2 is dropped from version 1.
     - B. Yes, after the routing design exists. Result: slice L2 stays in the plan, gated by 2a.
3. **Private remotes for `crew.git`** (addendum section 11, item 3). Owner: the Tech Lead. Settle before slice 5. No default: it waits for the owner. Suggested letter: A.
   - A. Allow a private remote, with the user's own git credentials. Result: slice 5 tests only the URL forms and the safety rules.
   - B. Allow a public remote only. Result: slice 5 adds a check that refuses a remote that asks for credentials.
4. **The memory size cap** (addendum section 11, item 4). Owner: the Tech Lead. Settle before slice 2.
   - A. Keep 256 KiB. Default. Result: no change to slice 2.
   - B. Set another number. Result: one constant and one test change in slice 2.
5. **Project root order.** Owner: the Tech Lead. Settle before slice 3.
   - A. Build slice 3 with the git top level, then rework it in D1. Default. Result: slice 3 is small, and D1 changes it later.
   - B. Build slice 3 with the `crew.yml` folder now. Result: D1 shrinks to the rework of the docs and tests.
6. **Routing design.** Owner: the maintainer. Settle before slices L1 and L2.
   - A. Publish it in this repository. Default. Result: slices L1 and L2 can start after it lands.
   - B. Keep Codex and Cursor off for all of version 1. Result: slices L1 and L2 leave the plan.
7. **Package version.** Owner: the Tech Lead. Settle before the release.
   - A. A minor version, because `up`, `spawn`, and `down` are additive. Default. Result: the release notes list the new commands as additions.
   - B. A major version. Result: the release notes name the change as breaking, and the package version jumps.

### Questions where the spec is unclear

- Q1. Does `up` show the `crew.yml` and ask before it starts sessions? The addendum lists no `--yes` flag. Owner: the maintainer, because it is a consent call. It has a security side too, because `up` can start up to ten sessions per role, each with its permission mode. Settle before slice 10. No default: it waits for the maintainer. Suggested letter: B.
  - A. No prompt. Result: `up` starts at once, and slice 10 has no prompt test.
  - B. The same prompt that `start` shows for a found `sagespec.yml`, with `--yes` to skip it. Result: slice 10 adds the prompt, the `--yes` flag, and a test that, with no terminal and no `--yes`, `up` starts nothing.
- Q2. `up --update` with `crew.path`. Owner: the Tech Lead. Settle before slice 5. Question Q12 replaces it once D6 lands.
  - A. Ignore the flag. Default. Result: slice 5 tests that the flag changes nothing.
  - B. Fail with an error. Result: slice 5 tests an exit code 2 and a message.
- Q3. Node cannot replace its own process. Owner: the Tech Lead. Settle before slice 10.
  - A. Start the child on the same terminal and exit with its code. Default. Result: slice D7 corrects the addendum text.
  - B. Use a small launcher that replaces the process. Result: a new file and a new gate.
- Q4. Where do the three new `team.json` fields sit? Owner: the Tech Lead. Settle before slice 12.
  - A. On each session entry. Default. Result: the entry guard grows, and each old entry stays valid without them.
  - B. On the record. Result: one set of fields for the whole team, and the tests read the record.
- Q5. Where does the kickoff of a `builtin` entry live, since the plan holds no command? Owner: the Tech Lead. Settle before slice 14.
  - A. In the plan, as data. Default. Result: the plan check reads and bounds the kickoff text.
  - B. `spawn` reads it again from `crew.yml`, and the plan holds the file hash. Result: `spawn` needs the file path and a hash check.
- Q6. `launchTeam` refuses when a `team.json` exists. What does `spawn` do? Owner: the Tech Lead. Settle before slice 11.
  - A. Refuse too. Default. Result: `spawn` needs a clean team record, and a test covers the refusal.
  - B. Add to the existing record. Result: `spawn` merges entries, and a test covers a name clash.
- Q7. Does the front session go into `team.json`? Owner: the Tech Lead. Settle before slice 12.
  - A. No. Default. Result: `status`, `stop`, and `down` stay background only.
  - B. Yes. Result: `status`, `stop`, and `down` must skip the front session by rule.
- Q8. What does `respawn` do for a module session when the crew commit changed? Owner: the Tech Lead. Settle before slice 12.
  - A. Refuse and name the change. Default. Result: `respawn` needs the recorded commit and a test for the refusal.
  - B. Restart from the current commit. Result: `respawn` runs the module checks again on the new commit and updates the record.
- Q9. Which checks does `health --json` run, and does crew need a setup step apart from install? Owner: the Tech Lead. Settle before D2 and D4.
  - A. Health reads the probe, `install.yml`, and `team.json`. Crew has no setup step apart from install. Default. Result: slice D4 reuses the readers that exist.
  - B. A new setup command. Result: a new slice adds it before D2.
- Q10. Does `require` allow a path with `..` or a symbolic link out of the root? Owner: the Tech Lead. Settle before slice 3.
  - A. Reject both. Default. Result: slice 3 tests both failures.
  - B. Allow a symbolic link that stays inside the root. Result: slice 3 tests that a link inside passes and a link outside fails.
- Q11. The install step must download the crew repository (slice D6). Does it reuse `trellis-crew install` and add the clone, or is it a new operation? Owner: the Tech Lead. Settle before D6.
  - A. Reuse `trellis-crew install` and add the clone. Default. Result: D6 changes `src/commands/install.ts` and keeps its tests.
  - B. A new operation. Result: D6 adds a command and its `USAGE` assertion, and the old install stays as it is.
- Q12. What does `up --update` do after D6 moves the fetch? Owner: the Tech Lead. Settle before D6.
  - A. Exit with code 2 and name install. Default. Result: D6 tests the exit code and the message.
  - B. Accept the flag, do nothing, and print a warning. Result: D6 tests the warning, and the flag stays in `USAGE`.
- Q13. What is the length cap for a base name and for a final session name, lane suffix included? A long name can pass the file name limit of the system. Owner: the Tech Lead. Settle before slice 1.
  - A. 40 characters for a base name and 64 for a final name. Default. Result: slices 1, 2, and 4 test both edges.
  - B. Another pair of numbers. Result: slices 1, 2, and 4 use the new numbers.

## F. Risks and checks before a build

The addendum's "Checks before a build" and "Gaps" become these named checks. Each one runs before the slice that needs it. Each records its result and its retrieval date in the pull request text, and a failed check stops the slice and goes to the maintainer.

- **V1. Prompt before `--add-dir`.** Confirm in the Claude Code CLI reference and in `claude --help` that a positional prompt placed before `--add-dir` is read as the prompt. Before slice 8. The existing adapter uses `--` before the prompt, so V1 also checks whether `--` still works with the new order.
- **V2. `.claude/` discovery in an added folder.** Confirm that most `.claude/` configuration in an `--add-dir` folder is not found, so the plugin route is needed. Before slice 8.
- **V3. Permission prompt in a `manual` background session.** The addendum says this is a gap: does it wait for `claude attach`, or fail the tool call? Run it on the installed Claude Code and record the result. Before slice 8, because slice 8 fixes `manual` as the default mode. If it fails the call, the default needs a decision from the maintainer.
- **V4. `--plugin-dir` is for one session only.** Confirm that nothing installs at user scope. Before slice 8.
- **V5. `--permission-mode` and `--restricted`.** Confirm the five mode names and the restricted behavior against `claude --help` and the vendor page. Before slice 8.
- **V6. Process replacement.** Test on the supported Node version how a foreground child keeps the terminal, signals, and exit code. Before slice 10.
- **V7. Stopping a Claude Code background session.** The existing code says no stop command is documented. Check again, and check the session id format that `parseBgSessionId` ignores today. Before slice 13. If still none, `down` prints the same note as `stop`, and that goes to the maintainer.
- **V8. Codex flags and paths.** Check `codex exec` flags, `AGENTS.md` and skills paths, `CODEX_HOME`, the interactive start flags, and one credential file per session. Before slice L1, and before any Codex `foreground` step.
- **V9. Cursor flags and paths.** Check `agent -p --workspace`, the rules and skills paths, and the interactive start flags. Before slice L2, and before any Cursor `foreground` step.
- **V10. Hooks in non-interactive mode.** Check for Codex and Cursor. Before slices L1 and L2.
- **V11. Every source link.** Open each link under Sources in the addendum and confirm the claim it supports. Before slice 8 for the Claude Code links and before L1 and L2 for the rest.
- **V12. Coordinator gate.** Confirm that the coordinator spec is published and settled, and read it again. Before slice D1.

Risks:

- **Risk:** a name in `crew.yml`, in a skill catalog, or in `team.json` becomes a path, and `down` deletes a stage folder. The stage root can also be a symbolic link, and a folder can change between the check and the removal. Mitigation: the path-safe name rule in slices 1, 2, 4, 6, 8, 11, and 12, a resolved-path check in slices 8 and 13, a refusal of a stage root or parent folder that is a link, a rename into a private quarantine folder with a second check by `lstat` and by device and inode numbers, removal without following links, and the same rules in the addendum through slice D7.
- **Risk:** a module path in the plan or in `team.json` points outside the crew repository. Mitigation: slices 6, 11, and 12 require that it resolves inside `<crew repository>/roles/`, even when the hash matches.
- **Risk:** a crew repository can hold hostile text. Mitigation: no code runs from it, the plan holds data only, `spawn` checks the hash and every field again, and the README states the trust rule (slice 15).
- **Risk:** the plan file or its environment variables get forged. Mitigation: the checks in slice 6, and tests for each failure.
- **Risk:** slice 12 breaks `sagespec.yml` users. Mitigation: the existing tests must pass unchanged, and older entries stay valid.
- **Risk:** the coordinator spec changes after slices merge. Mitigation: group D stays gated. Slices 3, 5, 9, 10, and 15 depend on it, because group D reverses them or they build on a reversed slice, and slices 1, 2, 4, 6, 7, 8, 11, 12, 13, and 14 do not.
- **Risk:** vendor flags change. Mitigation: each flag sits in one adapter file with the retrieval date in a comment, as `claude-code.ts` does today.

## G. Public-hygiene rules

The repository is PUBLIC. These rules apply to every file, every commit message, and every pull request body.

- No personal names, handles, session links, App IDs, private repository names or links, home paths, or secrets.
- Use "the maintainer". Fixtures use placeholder names and temporary folders.
- Describe only what crew itself must do. Never restate the text of an unpublished spec, and never cite a pull request of a private repository.
- Commits carry no session trailer and no session link. Pull request bodies carry none either.
- Before each push, run all of these:
  1. `npm run typecheck`
  2. `npm run lint`
  3. `npm test`
  4. `npm run build`
  5. `npm run sanitize -- --range origin/main..HEAD`, with `SANITIZE_DENYLIST` set to a local deny-list file kept outside the repository
- The `.githooks/pre-push` hook runs the sanitizer on pushed commits. Turn it on once with `git config core.hooksPath .githooks`.
- A pull request body states what changed, why, how it was verified, and which checks in section F ran. It names no private repository.
- CI runs the same gates. A red gate blocks the merge.

## Success criteria

- [ ] The maintainer approves this plan, and the owners settle decisions 1 to 7 and questions Q1 to Q13 as their slices come up. Decision 2a, decision 3, and question Q1 wait for their owners and never take a default.
- [ ] Slices 1 to 15 merge in order with all gates green, and every existing command test passes unchanged.
- [ ] `trellis-crew up`, `spawn`, and `down` run end to end on Claude Code against a fixture crew.
- [ ] No `crew.yml` name, skill name, plan value, or `team.json` entry can make `down`, `respawn`, or `export-skills` touch a path outside its root, and a stage root that is a symbolic link stops `down`.
- [ ] Slices L1 and L2 stay off until the routing design exists.
- [ ] Group D starts only after the coordinator spec settles.
