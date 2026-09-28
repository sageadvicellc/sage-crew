---
name: department-handoff-contract
description: Writes the three-part block of the hand-off contract for sage-crew, a multi-session team pattern. Use before any role sends a hand-off.
---

## The hand-off contract

Every hand-off message states three things, in this order:

1. The unit of work.
2. The done signal, the exact fact that proves the unit finished.
3. Where the finished result will live.

Never send a hand-off without all three parts.

Trigger: any role about to send a hand-off.

Writes: the three-part contract block itself.
