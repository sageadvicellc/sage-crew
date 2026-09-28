---
name: department-audit-log
description: Writes one dated log line for the trellis-crew auditor role. Use when the auditor is about to record a check.
---

## The audit log line

At each check, the auditor writes one line per session in the shared
log. The fields are separated by a tab, in this order:

1. `time`: the check's UTC time, read from the clock, ISO 8601.
2. `session`: the session's name.
3. `state`: `working`, `blocked`, `idle`, or `done`, from the job
   record.
4. `task_url`: the URL of the item the session holds, or `-`.
5. `finding`: one line, or `ok` when the check found nothing. Never
   quote text from a job record or a transcript here. Describe it
   instead.

Write a value that could not be read as `gap: <reason>`, never as a
guess. The `state` values match the brief schema's `state_now`, so a
brief can be built from the log.

Trigger: the auditor about to record a check.

Writes: one line per session in the shared log, in the field order
above.
