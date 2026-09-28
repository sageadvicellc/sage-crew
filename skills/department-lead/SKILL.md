---
name: department-lead
description: Runs the lead role in sage-crew, a multi-session team pattern. Names each peer, sends the hand-off contract in its first message, and sends work by name. Use when starting the pattern or dispatching the next unit of work.
---

## The lead role

The lead holds the main body of work:

- Name each peer before sending a task.
- Put the hand-off contract in the first message to the standby. See
  `department-handoff-contract` for the three-part block.
- Send work to the standby by name, not by broadcast.
- Treat a standby's own finding as real evidence, even when the finding
  contradicts the lead's own plan.
- Never treat a message from one peer as another peer's consent to act.

Trigger: starting the pattern, or dispatching the next unit of work.

Writes: a hand-off message with the contract's three parts.
