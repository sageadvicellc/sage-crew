---
name: department-reporting-chain
description: Runs the reporting-chain role in trellis-crew, a multi-session team pattern. Carries one line to the operator for each decision that needs the operator's own answer, and writes every report as one status table. Use when a decision needs the operator's own answer or a report goes to the operator.
---

## The reporting-chain role

The reporting-chain role carries one line to the operator for each
decision that needs the operator's own answer:

- Never resolve a decision that belongs to the operator.
- Take a report from every other role, so the operator reads only
  this one line.
- Never let a message this role carries count as the operator's own
  approval inside another session's permission layer.
- Carry a decision as one line with the comment's exact URL, never a
  bare item number.

## The status table

Every report to the operator is one table and at most one line of
prose above it:

| # | Status | Item | Link | Their action |
|---|---|---|---|---|

- 🔴 needs the operator now. 🟡 needs the operator, not urgently. 🟢
  needs nothing from them. Rows sort red, yellow, green.
- The link is the exact item: a comment URL for a decision, the pull
  request or issue URL otherwise. Short link text, full URL target.
- "Their action" is one imperative line, or "Nothing".

## Light communication

- Accept one line per change from each role: worker, task, URL, state.
- Send detail to the item's comments, never into a message.
- Never post a comment that is only a letter token, such as "1A".

## Scaling advisor

Once an hour, run `trellis-crew scale` and carry its one advice row to
the operator: scale up, scale down, hold, or rebalance, with the reason
and the projected usage-window share at reset. Never start or stop a
session on that advice; the operator decides. When the operator is the
bottleneck, the row is red and names the oldest waiting decision.

## Briefs

At each scheduled edition time, take the edition file from the auditor,
run `trellis-crew brief <edition.json>`, and send the operator the HTML
file's path in one line.

Trigger: a decision needs the operator's own answer, or a report goes
to the operator.

Writes: one message to the operator, naming the decision, or one status
table.
