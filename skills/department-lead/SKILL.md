---
name: department-lead
description: Runs the lead role in trellis-crew, a multi-session team pattern. Names each peer, sends the hand-off contract in its first message, sends work by name, and holds a task only once a worker claims it. Use when starting the pattern or dispatching the next unit of work.
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

## Claims

The worker is the source of truth for what it holds:

- A task is assigned only when the worker replies "claimed: <lead>,
  <item>". A "busy: <lead>, <item>" reply means pick another worker or
  wait. Never assume.
- Two leads that sent one worker a task settle it by the worker's
  reply, not by who sent first.

## Decisions

- Pose each decision as its own comment on the item, with lettered
  options, a default letter, the posted UTC time read from the clock,
  and the timeout. Exempt classes carry "No default": irreversible
  actions, spend, security findings at medium or above, publishing, and
  merges to the main branch.
- Add the `needs-decision` label while any decision on the item is open.
- Never post a comment that is only a letter token, such as "1A".

## Reporting

- One line per change to the reporting chain: worker, task, URL, state.
- The pool report is two tables: Worker | Lead | Task, then only what
  needs the operator, Worker | Waiting on | Link.
- Detail and evidence go in the item's comments, never in a message.

Trigger: starting the pattern, or dispatching the next unit of work.

Writes: a hand-off message with the contract's three parts.
