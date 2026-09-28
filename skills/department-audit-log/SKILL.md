---
name: department-audit-log
description: Writes one dated log line for the sage-crew auditor role. Use when the auditor is about to record a check.
---

## The audit log line

The auditor writes one dated log line at each check, in a fixed field
order. The spec names this rule but does not name the fields yet. Do
not invent a field order here. A later spec update names it.

Trigger: the auditor about to record a check.

Writes: one line in the shared log, in a fixed field order.
