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

## The sanitizer

This repository is public. The sanitizer keeps private text out of it.
Run it with `npm run sanitize`. It scans every tracked file, the staged
diff, and the messages of a range of commits. It fails on four classes
of text.

1. Secrets: an API key or token prefix followed by a full key, a
   private-key block, a committed `.env` file, and a password inside a
   URL.
2. Internal names from your deny-list.
3. Private paths: an absolute home path, such as `/Users/<name>/` or
   `/home/<name>/`, and socket paths.
4. Ticket links to any GitHub repository other than
   sageadvicellc/trellis-crew, and links to a private tracker.

A finding names the class, the file, and the line. It never prints the
text it found.

### The deny-list file

The deny-list is never committed. Keep it in a local file and point the
`SANITIZE_DENYLIST` environment variable at it. CI writes the same
content from the `SANITIZE_DENYLIST_CONTENT` repository secret.

- Write one term per line. A term matches in any letter case, and only
  as a whole word. A term may hold spaces.
- A line that starts with `#` is a comment.
- A line `allow <path> <term>` clears one term in one file. The path is
  relative to the repository root. The allowance never applies to a
  commit message.

```
# deny-list
project-codename
allow docs/history.md project-codename
```

When `SANITIZE_DENYLIST` is unset, a local run prints a warning and still
runs the other three checks. With `SANITIZE_REQUIRE_DENYLIST=1`, an unset
deny-list fails the run. CI and `prepublishOnly` set that variable, so CI
stays red until the maintainer adds the secret.

### The committed allowlist

`.sanitize-allow` holds reviewed false positives for the secret,
private-path, and ticket-link classes. Each line is `<path> <class>`. It
never holds a deny-list allowance.

### The commit range

`npm run sanitize -- --range <base>..<head>` scans the messages in that
range. The `SANITIZE_RANGE` variable does the same. With neither, the
range is `origin/main..HEAD` when `origin/main` exists.

### The pre-push hook

`.githooks/pre-push` runs the sanitizer on the commits you push. Turn it
on once per clone with `git config core.hooksPath .githooks`. CI runs the
same checks on every pull request and push.
