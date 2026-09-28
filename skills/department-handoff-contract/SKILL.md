---
name: department-handoff-contract
description: Writes the hand-off contract block for trellis-crew, a multi-session team pattern: three required parts and an optional task profile. Use before any role sends a hand-off.
---

## The hand-off contract

Every hand-off message states three things, in this order:

1. The unit of work.
2. The done signal, the exact fact that proves the unit finished.
3. Where the finished result will live.

A fourth part is optional:

4. The task profile, by its name in `task_profiles` of the team's
   roles file: `./sagespec.yml`, or the file given with `--roles`.
   The worker runs the unit through subagents with that profile's model
   and effort. Without a profile, the unit runs on the worker's own
   model and effort.

The lead picks the profile. Never send a hand-off without the first
three parts, and never name a profile the roles file does not define.
A worker that gets an undefined profile runs on its own model and
effort, and reports the mismatch to the lead.

Trigger: any role about to send a hand-off.

Writes: the contract block itself.
