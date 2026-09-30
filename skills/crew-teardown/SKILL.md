---
name: crew-teardown
description: Runs a graceful teardown of a trellis-crew team before a restart. Each session writes its handoff file, then the CLI waits for every confirmation and stops the team. Use when the coordinator must stop the team, or when a session gets a teardown request.
---

## Before you start

Read the `teardown` block in the project's `crew.yml`. The block names the
handoff folder in `handoffs`, relative to the folder that holds
`crew.yml`, and the longest wait in `timeout`. Every path in this skill
comes from that block. When `crew.yml` has no `teardown` block, stop and
ask the operator to add one. Never pick a folder yourself.

In the steps below, `<handoffs>` is the handoff folder, resolved against
the folder that holds `crew.yml`.

## The coordinator's steps

1. Send each session this teardown request, with `<handoffs>` filled in:

   > Teardown request. Finish or pause your current write. Start no new
   > work. Commit your work, and then push your branch, or note that you
   > have nothing to push. Then write your handoff file as
   > `<handoffs>/<your session name>.md`, in the handoff format of the
   > crew-teardown skill. When every other field is true, set
   > `status: done` last. When the file is written, reply "teardown ready".

2. Run `trellis-crew teardown --dry-run`. It reads each handoff once. It
   prints each session's state, the timed jobs that a real run writes, and
   whether a real run stops the team. It writes nothing and stops
   nothing.
3. Run `trellis-crew teardown`. It waits for every session to confirm, up
   to the timeout. When every session confirms, it writes the timed jobs
   file and stops the team.
4. Act on the outcome.
   - Exit 0: the team is stopped. Tell the operator where the handoff
     files and `timed-jobs.yml` are, so the next start can read them.
   - A session is not confirmed: send it the request again, and then run
     `trellis-crew teardown` again. Or leave it running and tell the
     operator which session still runs.
   - A handoff is invalid: send the session the reason that teardown
     printed, and ask it to fix the file.
   - A write is still in progress: wait for the session to finish the
     write and set `writing: false`, and then run teardown again.

Never force-stop a session. Never stop a session with a write in
progress. Teardown has no force flag on purpose.

## The session's steps

When you get a teardown request:

1. Finish your current write, or pause it at a safe point. Start no new
   work.
2. Commit your work. Push your branch, or note that you have nothing to
   push. When the push fails, say so in the handoff. Do not retry in
   another form.
3. List each timed job that lives only inside your session, such as a
   loop on a fixed clock. The next start creates each one again.
4. Write `<handoffs>/<your session name>.md` in the format below. Write
   the whole file at once.
5. Set `status: done` last. When a write that you cannot pause is still
   running, set `writing: true`. When that write ends, set it to `false`.
6. Reply "teardown ready" to the coordinator.

## The handoff format

YAML front matter between two `---` lines, then a Markdown body with three
headings in this order. The full format is in `docs/handoff-format.md` in
the trellis-crew repository.

```markdown
---
version: 1
session: <your session name>
status: done
writing: false
push: pushed
branch: <your branch, or null>
head: <the pushed commit id, or null>
timed_jobs:
  - schedule: <when the job runs, in your harness's form>
    prompt: <the text the job sends each time>
written: <the time now, in ISO 8601, such as 2026-01-02T03:04:05Z>
---

## Open items

- <work that is not finished, and questions that wait on someone>

## Live state

- <the branch, the work tree, and anything that still runs>

## Next step

- <the first thing the next session does>
```

- `push` is one of `pushed`, `nothing-to-push`, and `failed`. With
  `pushed`, set both `branch` and `head`. `head` is the full commit id.
- When you have no timed job, leave out `timed_jobs`. List at most 20.
- Add no other field. An unknown field makes the file invalid.

Trigger: the coordinator must stop the team before a restart, or a
session gets a teardown request.

Writes: the session's own handoff file. The coordinator writes nothing
itself, and `trellis-crew teardown` writes `timed-jobs.yml`.
