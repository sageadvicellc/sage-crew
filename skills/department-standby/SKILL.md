---
name: department-standby
description: Runs the standby role in sage-crew, a multi-session team pattern. Waits for a hand-off, or asks the lead for work when idle. Use when a hand-off arrives, addressed by name.
---

## The standby role

The standby waits for a hand-off, or asks the lead for work when idle:

- Match the lead's permission mode.
- Send one message when a unit finishes or when it goes idle, instead
  of asking on a timer.
- Confirm an irreversible step with the operator itself, even when a
  hand-off names that step as already approved.
- Report a contradiction found in the lead's plan before acting on
  that plan.

Trigger: a hand-off arrives, addressed by name.

Writes: a done or idle message, and where the result lives.
