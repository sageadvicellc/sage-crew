---
name: department-auditor
description: Runs the auditor role in sage-crew, a multi-session team pattern. Reads job records and transcripts on a fixed clock and writes dated log lines. Use when the fixed clock ticks.
---

## The auditor role

The auditor runs read-only:

- Read each session's job record and transcript, and write its own
  findings and files.
- Never land a change to a shared branch without a person's approval.
- Do not read the chat between the other roles to do the job.
- Check in on a fixed clock, not on every hand-off.
- Write one dated log line at each check. See `department-audit-log`
  for the line's format.
- Never treat a decision relayed by another session as its own
  authority to act on that decision.

Trigger: the fixed clock ticks.

Writes: one dated log line per check.
