# trellis-crew build plan: role modules and `crew.yml`

Status: draft for the founder's review, 2026-09-29. This is a plan only. It holds no code, and no build starts until the founder approves it.

## A. Purpose and scope

This plan turns `docs/crew-addendum.md` into small pull requests. Each one adds a thin piece that a test or a user can run. The plan covers `trellis-crew up`, `spawn`, `down`, the `crew.yml` file, role modules, the start plan, and the Claude Code adapter. The Codex and Cursor adapters come last and stay off. The group "Coordinator asks, pending trellis#1" comes after that and stays blocked.

Sources for the plan: the crew addendum (cited as "addendum section N"), `docs/cli-addendum.md`, the code in `src` and `test`, and the draft coordinator spec (cited as "coordinator section N"). The existing code already provides a `Runner` (`src/runner.ts`), an `Adapter` interface (`src/adapters/types.ts`), `team.json` (`src/store/team-json.ts`), `install.yml`, a probe (`src/detect/probe.ts`), and a sanitizer (`src/sanitize`). The plan reuses them and extends them without breaking them.

## Working rules for every slice

- Tests come first. Write the red tests, watch them fail, then write the smallest change that passes.
- One slice is one pull request. A slice must merge with all earlier gates green.
- Standard gates, called "G" below: `npm run typecheck`, `npm run lint`, `npm test`, `npm run build`, and `npm run sanitize -- --range origin/main..HEAD` with `SANITIZE_DENYLIST` set to a local file.
- Every test uses the existing home guard (`test/setup/home-guard.ts`) and temporary folders. No test touches the real home folder.
- Slices 1 to 8 must not change the output of `install`, `start`, `status`, `stop`, `respawn`, or `update`. The existing test files for those commands must pass unchanged.
- A term is defined at first use. A "start plan" is a data file that `up` writes and `spawn` reads. A "lane" is one background session of a role. A "front role" is the role that runs in the foreground.

## B. Vertical slices, in build order

### Slice 1. The `crew.yml` parser and its checks

- Goal: read a `crew.yml` text and return a checked config or a list of errors, with no file access beyond the one file and no change to any command.
- Spec: addendum section 2, checks that need no other file.
- Tests first, `test/crew-yml.test.ts`.
  - Red: a valid file parses. A missing `version` or `harness` fails. An unknown field fails, including `harness` on a role entry. Setting both or neither of `crew.path` and `crew.git` fails. `crew.git` accepts only `https://`, `ssh://`, and `git@host:` forms. `front` must name exactly one entry, and that entry cannot have `lanes` above 1. Each role entry sets exactly one of `role` and `builtin`. A `builtin` entry needs `kickoff` and a `role` entry cannot set it. `role` names allow only lowercase letters, digits, and hyphens. `lanes` accepts 1 to 10. `permission_mode` accepts the five listed values and rejects `bypassPermissions`. `harness: codex` and `harness: cursor` fail with the message "not built yet". Two sessions with one name fail (this test starts as a skipped test and turns on in slice 4). Each error names file, line, field, and reason.
  - Green: a schema module and a loader that use the `yaml` package already in `package.json`, with line numbers from its line counter.
- Files: add `src/crew/schema.ts`, `src/crew/load.ts`, `test/crew-yml.test.ts`, `test/helpers/crew.ts`. Change nothing else.
- Extra gates: G. Coverage of the new files at 80 percent or more.
- Size: 4 files, about 450 lines. M.
- Depends on: none.
- Hygiene: fixture text uses placeholder names such as `example-crew` and `worker`. No URL in a fixture except `https://example.com/owner/my-crew.git`.

### Slice 2. Role module checks

- Goal: check one role module folder and return a checked module or a list of errors.
- Spec: addendum section 4.
- Tests first, `test/crew-module.test.ts`.
  - Red: a valid module loads. A missing `role.md` or `catalog.yml` fails. A non-regular file fails. A catalog `path` that is absolute, has `..`, or is a symbolic link leaving the module fails. A skill `path` that does not name an existing `SKILL.md` fails. A missing `start.prompt` fails and a missing `start.name` passes. A file in `memory/` that is not a regular `.md` file fails. Memory over 256 KiB total fails and exactly 256 KiB passes.
  - Green: a module reader with real-path checks, built on temporary folders.
- Files: add `src/crew/module.ts`, `test/crew-module.test.ts`. Extend `test/helpers/crew.ts`.
- Extra gates: G.
- Size: 3 files, about 350 lines. M.
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
- Hygiene: none beyond the standard checks. Slice D1 changes this rule.

### Slice 4. Sessions, lanes, and naming

- Goal: expand the checked config into the list of sessions, with names and lanes.
- Spec: addendum sections 2 and 6.
- Tests first, `test/crew-sessions.test.ts`.
  - Red: `lanes` of 1 gives the plain `name`. `lanes` of 3 gives `<name>-1` to `<name>-3`. The default `name` is the `role` or `builtin` value. The front role always has one lane. A name clash between two sessions fails, including a clash created by a lane suffix. Then turn on the skipped test in `test/crew-yml.test.ts`.
  - Green: a pure expansion function.
- Files: add `src/crew/sessions.ts`, `test/crew-sessions.test.ts`. Change `src/crew/load.ts` to call it.
- Extra gates: G.
- Size: 3 files, about 200 lines. S.
- Depends on: slice 1.
- Hygiene: none beyond the standard checks.

### Slice 5. Resolving the crew repository

- Goal: find the crew folder from `crew.path`, `crew.git`, or `TRELLIS_CREW_PATH`.
- Spec: addendum section 3.
- Tests first, `test/crew-repo.test.ts`, with the recording runner in `test/helpers/recording-runner.ts`.
  - Red: `TRELLIS_CREW_PATH` overrides both fields. `crew.path` resolves against the project root and `~` expands. The folder must hold `roles/`. `crew.git` uses one cache folder per URL hash. The first `up` clones. A later `up` reuses the clone. `--update` fetches and checks out `crew.ref`. The loaded commit is printed. A cache with local changes stops the run and names `up --update`. No step runs code from the crew repository. Each role in `crew.yml` must name a folder under `roles/`, and each module passes slice 2.
  - Green: a resolver that calls `git` only through the `Runner`.
- Files: add `src/crew/repo.ts`, `test/crew-repo.test.ts`. Extend `src/env.ts` for the cache path. Change `src/crew/load.ts`.
- Note, pending trellis#1: the coordinator spec allows only install to download, so the clone and the `--update` fetch move out of `up` (slice D6). Build the clone step as its own function that the resolver calls, so slice D6 can move it to install without a rewrite.
- Extra gates: G. Decision 3 in section E is settled, or the slice keeps the `git` path to what the runner does with the user's own credentials.
- Size: 4 files, about 400 lines. L.
- Depends on: slices 1, 2.
- Hygiene: test remotes are local bare repositories in temporary folders. No real remote URL appears.

### Slice 6. The start plan: write, check, and single use

- Goal: write a plan file and check it before use.
- Spec: addendum section 5, steps 1, 2, 3 (hash), 5, and 7.
- Tests first, `test/crew-plan.test.ts`.
  - Red: the plan folder has mode 0700 and the file has mode 0600. The id is 32 hex characters from a random source. The plan holds data only: role, lane, name, module path, model, permission mode, and never a command line. The SHA-256 matches the file. Checks fail for a bad id, a path in the id, a symbolic link, a wrong owner, a wrong mode, a wrong hash, and a module that fails the slice 2 checks again. Reading renames the file to `<id>.used` before the first launch. A second read finds nothing and says so.
  - Green: a plan module using `src/fs-private.ts` and `src/fs-atomic.ts`.
- Files: add `src/crew/plan.ts`, `test/crew-plan.test.ts`. Change nothing else.
- Extra gates: G. Add tests on the failure order so a failed check never renames the file.
- Size: 3 files, about 400 lines. L.
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
  - Green: extend `Adapter` in `src/adapters/types.ts` with optional `stage`, `foreground`, and `background` steps, and implement them in `src/adapters/claude-code.ts`. Every other adapter leaves them unset.
- Files: change `src/adapters/types.ts`, `src/adapters/claude-code.ts`. Add `src/crew/stage.ts`, `test/crew-claude.test.ts`.
- Extra gates: G. Checks V1, V2, V4, and V5 must be done first. The existing `test/plugin-claude.test.ts` and `test/start.test.ts` must pass unchanged.
- Size: 5 files, about 450 lines. L.
- Depends on: slices 4, 7.
- Hygiene: fixture module names are placeholders. The stage folder in tests is a temporary folder.

### Slice 9. `up --dry-run`

- Goal: a user can run `trellis-crew up --dry-run` and see the whole plan, with nothing started.
- Spec: addendum sections 1 and 8.
- Tests first, `test/up-dry-run.test.ts` and additions to `test/args.test.ts` and `test/cli.test.ts`.
  - Red: the `up` command parses `--config`, `--update`, and `--dry-run`. With `--dry-run` the output shows the front command, each background command, and each generated file. No process starts, no plan file is written, and no `team.json` changes. Any failed check exits with code 2 and names file, line, field, and reason. A harness with no adapter fails the harness check. The run prints the crew commit.
  - Green: `runUp` wires slices 1 to 8 together. It adds `up` to `src/args.ts`, `USAGE`, and `dispatch` in `src/cli.ts`.
- Files: add `src/commands/up.ts`, `test/up-dry-run.test.ts`. Change `src/args.ts`, `src/cli.ts`, `src/deps.ts` if needed.
- Extra gates: G.
- Size: 5 files, about 300 lines. M.
- Depends on: slices 3, 5, 6, 8.
- Hygiene: the usage text has no personal name and no absolute path.

### Slice 10. `up`: write the plan and start the front session

- Goal: `up` starts the front session in the foreground with the plan variables.
- Spec: addendum section 5, steps 1 to 4, and section 6.
- Tests first, `test/up.test.ts`.
  - Red: `up` writes a plan, computes its hash, and starts the front command with `TRELLIS_CREW_PLAN` and `TRELLIS_CREW_PLAN_SHA256` set. The session runs in the foreground with no `-p` and no `--bg`. The process opens no other window. The run exits with the code of the front session. Nothing else from the crew starts.
  - Green: the foreground step of `runUp`. Question Q3 says how to replace the process in Node.
- Files: change `src/commands/up.ts`, `src/runner.ts` (a foreground step). Add `test/up.test.ts`. Extend `test/fixtures/bin/claude`.
- Extra gates: G. Check V6 (process replacement) must be done first.
- Size: 4 files, about 250 lines. M.
- Depends on: slice 9.
- Hygiene: the fixture binary prints its arguments and holds no real path.

### Slice 11. `spawn`: start the background sessions

- Goal: the front session runs `trellis-crew spawn` and the background sessions start.
- Spec: addendum section 5, steps 5 to 7, and section 6.
- Tests first, `test/spawn.test.ts`.
  - Red: `spawn` reads only `<plan folder>/<id>.json` for a valid id. It runs every check from slice 6 first. A failed check starts nothing and names the check. The plan is renamed to `<id>.used` before the first session starts. A second `spawn` starts nothing and says so. Each launch command comes from the adapter's `background` step. Each session is recorded in `team.json`. A launch failure stops the run, keeps the record of the ones that started, and names `trellis-crew down`. A `team.json` that already exists blocks the run (see Q6).
  - Green: `runSpawn`, sharing the record code in `src/commands/start.ts`.
- Files: add `src/commands/spawn.ts`, `test/spawn.test.ts`. Change `src/args.ts`, `src/cli.ts`.
- Extra gates: G. Check V3 (permission prompt in `manual` mode) must be done first.
- Size: 5 files, about 350 lines. M.
- Depends on: slices 6, 8, 10.
- Hygiene: none beyond the standard checks.

### Slice 12. `team.json` fields, and `status`, `stop`, `respawn` on both paths

- Goal: one team record serves both paths.
- Spec: addendum section 9.
- Tests first: `test/store.test.ts`, `test/status.test.ts`, `test/stop.test.ts`, `test/respawn.test.ts`.
  - Red: `team.json` accepts optional `role_module`, `harness`, and `crew_commit`. An older entry without them stays valid and is rewritten unchanged. `status` lists sessions from both paths. `stop` ends sessions from both paths. `respawn <name>` restarts a module session from the recorded module and crew commit, and refuses when the module changed on disk (see Q8). No `sagespec.yml` test changes.
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
  - Red: `down` reads `team.json` and stops each session with the same code as `stop`. It deletes the stage folder of each session that it stops. It leaves the front session alone. It names any session that has no local process, as `noProcessNote` does today. It is safe to run twice.
  - Green: `runDown`, on top of `src/commands/stop.ts`.
- Files: add `src/commands/down.ts`, `test/down.test.ts`. Change `src/args.ts`, `src/cli.ts`.
- Extra gates: G. Check V7 (how to stop a Claude Code background session) must be done first.
- Size: 4 files, about 200 lines. M.
- Depends on: slices 11, 12.
- Hygiene: none beyond the standard checks.

### Slice 14. Built-in roles inside `crew.yml`

- Goal: one crew can mix module roles and built-in roles.
- Spec: addendum section 9, third bullet.
- Tests first, `test/crew-builtin.test.ts`.
  - Red: `builtin: lead` with `kickoff` yields a session that uses the built-in skills and the inline kickoff, as `sagespec.yml` does. A team can mix both kinds. A `builtin` entry gets no module checks. The plan holds what `spawn` needs to launch it (see Q5).
  - Green: reuse `composeKickoff` and `launchSession` from `src/commands/start.ts`.
- Files: change `src/crew/sessions.ts`, `src/crew/plan.ts`, `src/commands/spawn.ts`. Add `test/crew-builtin.test.ts`.
- Extra gates: G. The `start` tests must pass unchanged.
- Size: 5 files, about 250 lines. M.
- Depends on: slices 11, 12.
- Hygiene: none beyond the standard checks.

### Slice 15. Docs

- Goal: the README and `USAGE` describe `up`, `spawn`, and `down`, and state the trust rule for crew content.
- Spec: addendum sections 1 and 3, item 5.
- Tests first: `test/cli.test.ts` asserts that `USAGE` lists the three commands.
- Files: change `README.md`, `src/args.ts`. No new file.
- Extra gates: G, plus the sanitizer on all tracked files (`npm run sanitize`).
- Size: 2 files, about 120 lines. S.
- Depends on: slice 14.
- Hygiene: examples use `example-crew` and relative paths.

### Later slices, off until the routing design exists

The addendum says these adapters stay off until a routing design is published in the repository (addendum section 7, "Routing between harnesses"). Before that, `harness: codex` and `harness: cursor` fail the harness check with the message "not built yet". A test in slice 1 already asserts that.

**Slice L1. Codex adapter (off).**

- Goal: `stage`, `foreground`, and `background` for Codex.
- Tests first, `test/crew-codex.test.ts`: the `codex exec -C <project root> --add-dir <module folder> [-m M] --sandbox workspace-write "<first prompt>"` command under the existing supervisor, the per-session `CODEX_HOME`, and one credential file per session.
- Files: `src/adapters/codex.ts`, `test/crew-codex.test.ts`. Size about 350 lines, L.
- Depends on: slice 13, the routing design, checks V8 and V10.
- Hygiene: the fixture `test/fixtures/bin/codex` holds no credential.

**Slice L2. Cursor adapter (off).**

- Goal: `stage`, `foreground`, and `background` for Cursor.
- Tests first, `test/crew-cursor.test.ts`: `agent -p --workspace <project root>`, the `.cursor/rules/crew-<session>.mdc` file with `alwaysApply: true`, the `.git/info/exclude` line, the skills under `.cursor/skills/crew-<session>-<skill>/`, and removal by `down`.
- Files: a new `src/adapters/cursor.ts`, `test/crew-cursor.test.ts`. Size about 400 lines, L.
- Depends on: slice 13, the routing design, decision 2, checks V9 and V10.
- Hygiene: the test checks that no generated rule file is committable.

## C. Not in crew

These topics belong to the coordinator, per the owner table in coordinator section 1. They stay out of crew's build. Each one that depends on the coordinator spec is marked "pending trellis#1".

- Finding a config file above the folder of `crew.yml` (coordinator section 4). Crew never searches upward. Pending trellis#1.
- Starting more than one part, and the order of parts (coordinator section 6). Pending trellis#1.
- Starting or ordering other parts from crew. Crew drops any such text. Pending trellis#1.
- `trellis.yml`, the list of parts, and their order (coordinator sections 3 and 6). Crew never reads it and never reads `TRELLIS_*` variables to decide what to do. Pending trellis#1.
- The part contract as the coordinator defines it (coordinator section 5): the manifest schema, the four operations, and health states. Crew only implements what group D lists. Pending trellis#1.
- The marketplace file, the `trellis` plugin, and the skills conversion command `export-skills` (coordinator section 10). Pending trellis#1.
- `trellis init`, `trellis up`, `trellis doctor`, and the trust record in `.trellis/`. Pending trellis#1.

## D. Coordinator asks, pending trellis#1

This group is gated on trellis#1. It must not start until that pull request settles. If it changes, this group changes with it. Each item below names the merged crew behavior that it changes.

The coordinator spec asks crew for four changes:

1. No download in `up`. Only install can download, so the `crew.git` clone moves from `up` into install (slice D6).
2. The project root is the folder of `crew.yml` (slice D1).
3. A `trellis-part.yml` file, with `version --json` and `health --json` (slices D2, D3, and D4).
4. An `export-skills` operation that writes to the folder it is given and refuses a harness that differs from `crew.yml` (slice D5).

Slice D7 then edits the merged crew addendum to match. Slices D1, D3, D4, D5, and D6 can merge in any order after the gate opens. Slice D2 needs D3, D4, and D5 for its manifest to be true. Slice D7 comes last.

### Slice D1. The project root is the folder of `crew.yml`

- Changes: addendum sections 1 and 8, which define the root as the git top level. Slice 3 and every later use of the root change.
- Tests first, `test/crew-root.test.ts` and `test/up-dry-run.test.ts`.
  - Red: with `--config sub/crew.yml` the root is `sub`. With no `--config` the root is the current folder that holds `./crew.yml`. No upward search happens: a `crew.yml` in a parent folder is not found. `require` files, the working directory of every session, and relative `crew.path` values resolve against that folder. A missing file prints the path searched and exits with code 2.
  - Green: change `src/crew/project-root.ts` and its callers in `src/commands/up.ts` and `src/adapters/claude-code.ts`.
- Files: 4 files, about 150 lines. S.
- Gates: G, and all `up`, `spawn`, and `down` tests re-run.
- Hygiene: fixtures use temporary folders.

### Slice D2. `trellis-part.yml` in the crew repository

- Changes: nothing at run time. It adds a file and a `files` entry in `package.json`.
- Tests first, `test/part-manifest.test.ts`.
  - Red: the file parses and has `contract`, `name`, `requires`, `effects`, and the `operations` that coordinator section 5.1 requires. `effects` lists that `install` can change user-scope harness settings (coordinator section 9). Every operation is an array of strings. The `up` operation is foreground and runs `up` with the config path placeholder. The file is included in the package.
  - Green: add the file and the `files` entry.
- Files: add `trellis-part.yml`, `test/part-manifest.test.ts`. Change `package.json`. About 90 lines. S.
- Gates: G, and `npm pack --dry-run` lists the file.
- Depends on: D3, D4, and D5, and question Q9.
- Hygiene: no private name in the file.

### Slice D3. `version --json`

- Changes: `src/args.ts` today knows only `--version` and `-v`, and prints the version alone. A new `version` command with `--json` adds output. The plain output stays as it is.
- Tests first, `test/version-json.test.ts`.
  - Red: `version --json` prints one JSON object with `contract`, `part`, and `version`, as coordinator section 5.2 lists. It writes nothing to disk, opens no listener, and uses no network. Exit code 0. Plain `--version` output does not change.
  - Green: a new command in `src/args.ts` and `src/cli.ts`.
- Files: change `src/args.ts`, `src/cli.ts`. Add `test/version-json.test.ts`. About 100 lines. S.
- Gates: G.
- Hygiene: none beyond the standard checks.

### Slice D4. `health --json`

- Changes: adds a new command. No existing command changes. Coordinator section 5.2 says `health` and `version` change nothing on disk.
- Tests first, `test/health-json.test.ts`.
  - Red: `health --json` prints one JSON object with `status` and `checks`. The exit code matches the status: 0 for `ok`, 1 for `degraded`, 2 for `down`, 3 for `unconfigured`. It writes nothing and opens no listener. It never prints a secret. Which checks it runs is question Q9.
  - Green: a command that reuses the probe in `src/detect/probe.ts` and the readers for `install.yml` and `team.json`.
- Files: add `src/commands/health.ts`, `test/health-json.test.ts`. Change `src/args.ts`, `src/cli.ts`. About 220 lines. M.
- Gates: G.
- Hygiene: the output holds no home path. The tests assert it.

### Slice D5. `export-skills`

- Changes: adds a new operation. No existing command changes. Coordinator section 10.4 gives the operation to crew, and it reuses crew's adapter layer.
- Tests first, `test/export-skills.test.ts`.
  - Red: the operation takes `--harness`, `--skills`, and `--out`. It writes only inside the folder that `--out` names, and never in a user scope. It refuses a harness that differs from the `harness` in `crew.yml`, exits with a non-zero code, and names both values. It prints one JSON object with `harness`, `skills`, and `written`. Running it twice gives the same files and reports no change the second time. It lists every place it writes so the manifest `effects` line can name them. It never runs code from a skill.
  - Green: a command that calls the adapter's `stage` step for skills only.
- Files: add `src/commands/export-skills.ts`, `test/export-skills.test.ts`. Change `src/args.ts`, `src/cli.ts`. About 250 lines. M.
- Gates: G.
- Depends on: slice 8, because it reuses the adapter `stage` step.
- Hygiene: the output holds no home path. The tests assert it.

### Slice D6. No download in `up`: the clone moves to install

- Changes: addendum sections 3 and 5, which have `up` clone `crew.git` and `up --update` fetch. Slices 5 and 9 change with it.
- Tests first, `test/up-no-fetch.test.ts` and additions to `test/crew-repo.test.ts` and `test/install.test.ts`.
  - Red: `up` never runs a `git clone`, `git fetch`, `git pull`, or any network call. The recording runner asserts that no such command appears, with `crew.git` set and with `--update` set. With `crew.git` set and no cache, `up` stops with code 2 and names install as the step to run. `up` still reads a cache that install made, checks it, and prints the loaded commit. Install clones the crew repository, and a second run reuses it. Install with the update option fetches and checks out `crew.ref`. A cache with local changes stops install and says so. No step runs code from the crew repository.
  - Green: move the clone step from the resolver's `up` path into the install command. The resolver only reads the cache.
- Files: change `src/crew/repo.ts`, `src/commands/install.ts`, `src/commands/up.ts`, `src/args.ts`. Add `test/up-no-fetch.test.ts`. Extend two existing test files. About 250 lines. M.
- Gates: G. The existing `install` tests must pass unchanged, except the ones that this slice extends.
- Depends on: slices 5 and 9, and question Q11.
- Hygiene: test remotes are local bare repositories in temporary folders.

### Slice D7. Addendum follow-up edit

- Changes: the merged crew addendum only. No code changes.
- Tests first: a docs check in `test/docs.test.ts` that reads `docs/crew-addendum.md` and asserts these lines. It has no text that says `up` clones or fetches. It defines the project root as the folder of `crew.yml`. It lists `trellis-part.yml`, `version --json`, `health --json`, and `export-skills`.
- Files: change `docs/crew-addendum.md`. Add `test/docs.test.ts`. About 120 lines. S.
- Gates: G, and the sanitizer on all tracked files (`npm run sanitize`).
- Depends on: D1 to D6.
- Hygiene: the edit names no private repository. It refers to the coordinator work as "trellis#1".

## E. Open decisions for the founder

The plan settles none of these.

1. **Command name** (addendum section 11, item 1). Options: `trellis-crew up`, or a separate `crew` binary.
   - Effect: a second binary adds a `bin` entry and a rename in slices 9, 11, 13, and 15, and in the front prompt text of slice 7.
   - Settle before slice 7, because the front prompt names the command.
2. **The Cursor adapter writes inside the project** (addendum section 11, item 2). Options: accept it, or leave Cursor out until Cursor documents a rules path outside the workspace.
   - Effect: it decides whether slice L2 exists.
   - Settle before slice L2. It does not block slices 1 to 15.
3. **Private remotes for `crew.git`** (addendum section 11, item 3). Options: allow a private remote with the user's own git credentials, or allow only a public one.
   - Effect: the tests and errors in slice 5.
   - Settle before slice 5.
4. **The 256 KiB memory cap** (addendum section 11, item 4). Options: keep it, or set another number.
   - Effect: one constant and one test in slice 2.
   - Settle before slice 2.
5. **Project root order.** The merged addendum uses the git top level. The coordinator asks for the folder of `crew.yml`. Options: build slice 3 with the git top level, then change it in D1, or build slice 3 with the `crew.yml` folder now and skip D1.
   - Effect: slice 3 and D1.
   - Settle before slice 3.
6. **Routing design.** Options: publish it in this repository, or keep Codex and Cursor off for good in version 1.
   - Effect: slices L1 and L2.
   - Settle before L1 and L2.
7. **Package version.** The next release could be a minor version, since `up`, `spawn`, and `down` are additive. Options: minor version, or a new major version.
   - Effect: release notes only.
   - Settle before the release.

Questions where the spec is unclear:

- Q1. Does `up` show the `crew.yml` and ask before it starts, as `start` does for a found `sagespec.yml` (`confirmFoundRoles`)? The addendum lists no `--yes` flag for `up`. Options: no prompt, or the same prompt with `--yes`. Settle before slice 10.
- Q2. `up --update` with `crew.path`: is it an error, or ignored? Settle before slice 5.
- Q3. Node cannot replace its own process. Options: start the child with inherited terminal and exit with its code, or use a small launcher. The addendum says "replaces its own process". Settle before slice 10.
- Q4. Where do the three new `team.json` fields sit: on each session entry, or on the record? Addendum section 6 says each session records them, and the record already holds `harness`. Settle before slice 12.
- Q5. The plan holds "role, lane, name, module path, model, permission mode". A built-in entry has a `kickoff` and no module. Where does its kickoff live, given the plan holds no commands? Settle before slice 14.
- Q6. `launchTeam` refuses when a `team.json` exists. Does `spawn` refuse too, or add to it? Settle before slice 11.
- Q7. Does the front session go into `team.json`? `status`, `stop`, and `down` work only on background sessions today. Settle before slice 12.
- Q8. What does `respawn` do for a module session if the crew commit changed since it started? Settle before slice 12.
- Q9. Which checks does `health --json` run, and what does `configure` mean for crew, which has none today? Coordinator section 5.1 requires `install` and `configure` operations. Settle before D2 and D4.
- Q10. Does `require` allow a path with `..` or a symbolic link out of the root? The addendum states the module rules only. Settle before slice 3.
- Q11. The crew part's install operation must download the crew repository (slice D6). Today `trellis-crew install` sets up the harness on the user's machine. Does the part's install operation reuse that command and add the clone, or is it a new operation? Settle before D6.

## F. Risks and checks before a build

The addendum's "Checks before a build" and "Gaps" become these named checks. Each one runs before the slice that needs it. Each records its result and its retrieval date in the pull request text, and a failed check stops the slice and goes to the founder.

- **V1. Prompt before `--add-dir`.** Confirm in the Claude Code CLI reference and in `claude --help` that a positional prompt placed before `--add-dir` is read as the prompt. Before slice 8. The existing adapter uses `--` before the prompt, so V1 also checks whether `--` still works with the new order.
- **V2. `.claude/` discovery in an added folder.** Confirm that most `.claude/` configuration in an `--add-dir` folder is not found, so the plugin route is needed. Before slice 8.
- **V3. Permission prompt in a `manual` background session.** The addendum says this is a gap: does it wait for `claude attach`, or fail the tool call? Run it on the installed Claude Code and record the result. Before slice 11. If it fails the call, the default `manual` may need a decision from the founder.
- **V4. `--plugin-dir` is for one session only.** Confirm that nothing installs at user scope. Before slice 8.
- **V5. `--permission-mode` and `--restricted`.** Confirm the five mode names and the restricted behavior against `claude --help` and the vendor page. Before slice 8.
- **V6. Process replacement.** Test on the supported Node version how a foreground child keeps the terminal, signals, and exit code. Before slice 10.
- **V7. Stopping a Claude Code background session.** The existing code says no stop command is documented. Check again, and check the session id format that `parseBgSessionId` ignores today. Before slice 13. If still none, `down` prints the same note as `stop`, and that goes to the founder.
- **V8. Codex flags and paths.** Check `codex exec` flags, `AGENTS.md` and skills paths, `CODEX_HOME`, the interactive start flags, and one credential file per session. Before slice L1.
- **V9. Cursor flags and paths.** Check `agent -p --workspace`, the rules and skills paths, and the interactive start flags. Before slice L2.
- **V10. Hooks in non-interactive mode.** Check for Codex and Cursor. Before slices L1 and L2.
- **V11. Every source link.** Open each link under Sources in the addendum and confirm the claim it supports. Before slice 8 for the Claude Code links and before L1 and L2 for the rest.
- **V12. Coordinator gate.** Confirm trellis#1 has settled and re-read coordinator sections 1, 5, 7, and 9. Before slice D1.

Risks:

- **Risk:** a crew repository can hold hostile text. Mitigation: no code runs from it, the plan holds data only, `spawn` checks the hash, and the README states the trust rule (slice 15).
- **Risk:** the plan file or its environment variables get forged. Mitigation: the checks in slice 6, and tests for each failure.
- **Risk:** slice 12 breaks `sagespec.yml` users. Mitigation: the existing tests must pass unchanged, and older entries stay valid.
- **Risk:** the coordinator spec changes after slices merge. Mitigation: group D stays gated, and slices 1 to 15 do not depend on it, except decision 5.
- **Risk:** vendor flags change. Mitigation: each flag sits in one adapter file with the retrieval date in a comment, as `claude-code.ts` does today.

## G. Public-hygiene rules

The repository is PUBLIC. These rules apply to every file, every commit message, and every pull request body.

- No personal names, handles, session links, App IDs, private repository names or links, home paths, or secrets.
- Use "the founder" and "the maintainer". Fixtures use placeholder names and temporary folders.
- Commits carry no session trailer and no session link. Pull request bodies carry none either.
- Before each push, run all of these:
  1. `npm run typecheck`
  2. `npm run lint`
  3. `npm test`
  4. `npm run build`
  5. `npm run sanitize -- --range origin/main..HEAD`, with `SANITIZE_DENYLIST` set to a local deny-list file kept outside the repository
- The `.githooks/pre-push` hook runs the sanitizer on pushed commits. Turn it on once with `git config core.hooksPath .githooks`.
- A pull request body states what changed, why, how it was verified, and which checks in section F ran. It names no private repository. Refer to the coordinator work as "trellis#1".
- CI runs the same gates. A red gate blocks the merge.

## Success criteria

- [ ] The founder approves this plan and settles decisions 1 to 5 and questions Q1 to Q10 as their slices come up.
- [ ] Slices 1 to 15 merge in order with all gates green, and every existing command test passes unchanged.
- [ ] `trellis-crew up`, `spawn`, and `down` run end to end on Claude Code against a fixture crew.
- [ ] Slices L1 and L2 stay off until the routing design exists.
- [ ] Group D starts only after trellis#1 settles.
