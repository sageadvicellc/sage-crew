---
name: department-standby
description: Runs the standby role in sage-crew, a multi-session team pattern. Waits for a hand-off, claims it by name, or asks the lead for work when idle. Use when a hand-off arrives, addressed by name.
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

## Claims

The standby is the source of truth for what it holds:

- On a hand-off, reply "claimed: <lead>, <item>" before starting, or
  "busy: <lead>, <item it holds>" when it already holds one.
- Hold one task at a time. The lead that gets the "claimed" reply owns
  the task until the done message.

## Reporting

- One line per change to the lead: task, URL, state.
- Progress, evidence, and review notes go in the item's comments, never
  in a message.
- Never post a comment that is only a letter token, such as "1A".

Trigger: a hand-off arrives, addressed by name.

Writes: a claimed or busy reply, then a done or idle message with where
the result lives.
