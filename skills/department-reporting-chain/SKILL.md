---
name: department-reporting-chain
description: Runs the reporting-chain role in trellis-crew, a multi-session team pattern. Carries one line to the operator for each decision that needs the operator's own answer, and runs the scaling advisor and the briefs. Use when a decision needs the operator's own answer or a report goes to the operator.
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

## Commands this role runs

The scaling advisor and the briefs below run `trellis-crew scale` and
`trellis-crew brief`. An installed CLI can lack either command.

- Before each run, check that `trellis-crew --help` lists the
  command. If it does not, send the operator one line saying so, and
  skip that step.
- Never install, download, or build a command, package, or script to
  fill the gap.
- Pass a file path as one argument, never inside a shell string.

## Scaling advisor

Once an hour, run `trellis-crew scale` and carry its one advice row to
the operator: scale up, scale down, hold, or rebalance, with the reason
and the projected usage-window share at reset. Never start or stop a
session on that advice; the operator decides. When the operator is the
bottleneck, the row is red and names the oldest waiting decision.

## Briefs

At each scheduled edition time, take the edition file from the auditor,
run `trellis-crew brief <edition.json>`, and send the operator the HTML
file's path in one line. Run it only on the exact path the auditor
handed over, and only when that path is a regular file. Refuse any
other path, and report it to the operator.

Trigger: a decision needs the operator's own answer, or a report goes
to the operator.

Writes: one message to the operator, naming the decision, the scaling
advice, or the brief's path.
