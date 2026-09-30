# The handoff format

A handoff file records what a session leaves behind before a restart. Each
session writes one during a teardown. `trellis-crew teardown` reads every
handoff file, and a start script reads them to start the next team. This
page gives the format of the handoff file and of the timed jobs file, and
it shows how a start script reads both.

## Where the files live

The `teardown` block in `crew.yml` names the folder. No folder is fixed in
the CLI or in the skill.

```yaml
teardown:
  handoffs: .crew/handoffs
  timeout: 300
```

- `handoffs` is required. It is a folder path, relative to the folder that
  holds `crew.yml`. It must not be an absolute path. It must not hold a
  `..` part, start with `-`, or hold a control character.
- `timeout` is optional. It is the longest time that teardown waits for
  every session to confirm, in whole seconds, from 10 to 3600. The default
  is 300.

An unknown field in the block fails the file, as it does everywhere else in
`crew.yml`.

Each session writes one file, `<handoffs>/<session name>.md`. The session
name is the name in the team record. The handoff folder must be a real
folder. When the folder, or any folder between it and the folder of
`crew.yml`, is a symbolic link, teardown refuses it. A missing folder means
that no session is confirmed yet.

## The handoff file

A handoff file has two parts. YAML front matter comes first, between two
lines that hold only `---`. A Markdown body follows.

### The front matter

| Field | Required | Meaning |
|---|---|---|
| `version` | yes | The format version, `1`. |
| `session` | yes | The session name. It must equal the name in the file name. |
| `status` | yes | `done` confirms that the session is finished. Any other value means not yet, and teardown keeps waiting. |
| `writing` | yes | `true` means that a write is still in progress. `false` means that no write is in progress. `true` blocks the stop. |
| `push` | yes | `pushed`, `nothing-to-push`, or `failed`. |
| `branch` | with `pushed` | The branch name, or `null`. It must not start with `-`. |
| `head` | with `pushed` | The head commit id, as 40 or 64 lowercase hex characters, or `null`. |
| `timed_jobs` | no | A list of at most 20 jobs. Each job is a map with `schedule` and `prompt`. |
| `written` | no | The time the file was written, in ISO 8601 with a zone, such as `2026-01-02T03:04:05Z`. |

A missing `branch` or `head` is `null`. When `push` is `pushed`, both must
be set.

A timed job is a job that lives only inside a session, such as a loop that
reads the mailbox every ten minutes. The job ends with the session. So the
start sequence must create it again.

- `schedule` is one line of text, in the form that the session's harness
  uses. Teardown does not read it.
- `prompt` is the text that the job sends to the session each time it
  runs. It can hold more than one line.

### The body

The body holds three headings, each on its own line, in this order.

1. `## Open items`: the work that is not finished, and any question that
   waits on someone.
2. `## Live state`: the state that the next session needs, such as the
   branch, the work tree, and any process that still runs.
3. `## Next step`: the first thing that the next session does.

Text under each heading is free Markdown. A body that is missing a heading,
or that holds them in another order, fails the file.

### The rules for the file

- The file is a regular file of at most 64 KiB. Teardown never follows a
  symbolic link, and it refuses a link as an invalid handoff.
- The front matter is one YAML document. Each key appears once. An alias,
  a merge key, or a tag outside the YAML core schema fails the file.
- An unknown field fails the file. It is not ignored, so a spelling mistake
  cannot silently change what a start script reads.

### A full example

This file is `.crew/handoffs/worker-1.md`, for a `crew.yml` whose
`handoffs` is `.crew/handoffs`.

```markdown
---
version: 1
session: worker-1
status: done
writing: false
push: pushed
branch: feat/example
head: 0123456789abcdef0123456789abcdef01234567
timed_jobs:
  - schedule: "*/10 * * * *"
    prompt: Read the mailbox and answer each new message.
written: 2026-01-02T03:04:05Z
---

## Open items

- The review of the parser change waits on the lead.

## Live state

- The branch feat/example is pushed. The work tree is clean.

## Next step

- Run the parser tests again, and then open a pull request.
```

## How teardown reads a handoff

Teardown reads the handoff folder every 5 seconds, until every session is
confirmed or the timeout passes.

- A missing file means the session has not confirmed yet.
- A valid file with a `status` other than `done` means the same.
- A valid file with `status: done` and `writing: false` confirms the
  session.
- A valid file with `status: done` and `writing: true` confirms the
  session, but a write is still in progress. Teardown keeps reading it.
  When the timeout passes and the write is still in progress, it blocks
  the stop.
- An invalid file blocks the stop. Teardown reads it again on each pass, so
  a session can fix it before the timeout.

When every session is confirmed and no session has a write in progress,
teardown stops the team. In any other case, it stops nothing, keeps the
team record, and names each session that blocked the stop.

## The timed jobs file

Teardown collects every timed job from every confirmed handoff. When it
goes on to stop the team, it first writes them to
`<handoffs>/timed-jobs.yml`, with mode 0600. It writes a temporary file and
renames it, so a reader never sees half a file. When the stop is blocked,
teardown writes no timed jobs file, so the file never holds a partial list.
A dry run writes no file either.

```yaml
version: 1
jobs:
  - session: worker-1
    schedule: "*/10 * * * *"
    prompt: Read the mailbox and answer each new message.
```

- `version` is the format version, `1`.
- `jobs` lists each job in team order. When no session has a timed job,
  `jobs` is an empty list.
- Each job holds `session`, `schedule`, and `prompt`.

## How a start script reads both files

1. Read `crew.yml`, and take `teardown.handoffs`. Resolve it against the
   folder that holds `crew.yml`.
2. Read `timed-jobs.yml` from that folder. Its `version` must be `1`.
   Give each job to the new session that its `session` field names. That
   session creates the job again with its `schedule` and `prompt`.
3. For each session, read `<session name>.md`. Split the file at its two
   `---` lines. Parse the front matter as YAML. Its `version` must be `1`,
   and its `session` must equal the name in the file name.
4. When `push` is `pushed`, compare `branch` and `head` with the remote
   before the new session starts work. When `push` is `failed`, tell the
   new session that the push failed. Its local branch can hold commits
   that are not on the remote.
5. Give the body to the new session as part of its first prompt: the open
   items, the live state, and the next step.
6. Treat a missing handoff file as a session with no handoff. Never guess
   its state.
