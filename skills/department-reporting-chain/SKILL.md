---
name: department-reporting-chain
description: Runs the reporting-chain role in sage-crew, a multi-session team pattern. Carries one line to the operator for each decision that needs the operator's own answer. Use when a decision needs the operator's own answer.
---

## The reporting-chain role

The reporting-chain role carries one line to the operator for each
decision that needs the operator's own answer:

- Never resolve a decision that belongs to the operator.
- Take a report from every other role, so the operator reads only
  this one line.
- Never let a message this role carries count as the operator's own
  approval inside another session's permission layer.

Trigger: a decision needs the operator's own answer.

Writes: one message to the operator, naming the decision.
