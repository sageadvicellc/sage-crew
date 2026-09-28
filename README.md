# trellis-crew

👷🏻‍♀️🌱 Build anything, grow smarter

trellis-crew sets up a small team of agent sessions that split work, hand
off tasks, and report status. It sits on Trellis, an open framework,
and ships free under the MIT licence. Peer messaging runs on three
tiers. Tier one is native: Claude Code and Qwen Code ship a peer list,
an addressed send, and a delivery outcome per message today. Tier two
is a general path: a harness that speaks the Agent2Agent protocol
moves a task to another agent, as Hermes Agent does now. Tier three is
a shared mailbox, for every other harness checked. A shared local MCP
mailbox is the tier-three default path. A shared file is the fallback
for a reader who runs no server. This folder holds draft skills and a
manifest, not yet an installed plugin. The code's permanent home is a
decision still open on the build issue.

## Your config: the tree and the prompts

A trellis-crew config has two halves. The roles file, `sagespec.yml`,
sets the team layout: which sessions run, who reports to whom, and how
each one starts. The agent definitions are the other half. They are the
prompts that tell each session how to do its role. The two halves form
one config, and you change either one to change how your team works.

## The agent definitions

The agent definitions ship as skills in `skills/`. Hanna Sage wrote
them, and Sage Advice LLC publishes them as open source under the MIT
licence.

| Skill | What it defines |
|---|---|
| `department-lead` | The lead, who names each peer and sends work |
| `department-standby` | A worker, who waits for a hand-off and claims it |
| `department-auditor` | The auditor, who checks the team on a fixed clock |
| `department-reporting-chain` | The reporting chain, which carries decisions to the operator |
| `department-researcher` | The researcher, who answers one question at a time from cited sources |
| `department-handoff-contract` | The hand-off block that a lead sends with each task |
| `department-audit-log` | The log line that the auditor writes for each check |

## Build your own config

1. Copy `sagespec.example.yml` to `sagespec.yml`, and change the team to
   fit your work.
2. Start from the shipped agent definitions. Run your team on them first.
3. Write your own agent definitions. Change a shipped prompt in
   `skills/`, or write your own skill and name it in the `kickoff`
   message of the session that uses it.
