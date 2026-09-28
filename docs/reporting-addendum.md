# sage-crew reporting: spec addendum

Status: draft, 2026-09-28. Extends the sage-crew plugin specification and
the CLI addendum. It fixes how a team reports to its operator: one status
table, one pool table, one comment per decision, worker-owned claims,
light messages, and two scheduled briefs a day.

## 1. The status table

Every report to the operator is one table and at most one line of prose
above it.

| # | Status | Item | Link | Their action |
|---|---|---|---|---|
| 1 | 🔴 | the merge queue is stopped by a branch rule | short link | Turn off the rule, or reply to the decision |
| 2 | 🟡 | CLI spec, four decisions posed | short link | Reply with a letter by the default time |
| 3 | 🟢 | 41 pull requests merged overnight | short link | Nothing |

- 🔴 needs the operator now. 🟡 needs the operator, not urgently. 🟢
  needs nothing from them.
- Rows sort red, yellow, green. Within a colour, oldest first.
- A link is the exact item: a comment URL when the item is a decision, a
  pull request or issue URL otherwise. Short link text, full URL target.
- "Their action" is one imperative line, or "Nothing" for green.

## 2. The pool table

A lead's report on its workers is two small tables.

| Worker | Lead | Task |
|---|---|---|
| worker-1 | main | review of the relay bus pull request |
| worker-2 | main | idle, no queued item |

Then only what needs the operator:

| Worker | Waiting on | Link |
|---|---|---|
| worker-1 | the operator's merge | short link |

## 3. Decisions

- One comment per decision, on the pull request or issue it belongs to.
  Never a list of decisions in one comment, and never a decision in a
  body.
- The comment opens with a warning block, "Decision k of n: <topic>", the
  instruction "Reply to this comment with a letter", and lettered
  options. A recommendation is marked only when a source supports it.
- The item carries a `needs-decision` label while any decision on it is
  open. The item's body links each decision comment.
- Each comment ends with a default letter, its posted time in UTC, and
  the timeout: "Default: (a). Posted <date> <time> UTC. Applies after N
  hours without a reply." N is 12 unless the roles file sets another
  value. The posting session reads the clock before it writes the time.
- Every decision on one pull request or issue is numbered in one
  sequence; a later batch continues the count and never restarts at 1.
- Exempt classes never default, and the comment says "No default":
  irreversible actions, anything that spends money, security findings at
  medium severity or above, publishing, and merges to the main branch.
- When the operator replies after a default applied, the reply wins. The
  session reverts the default's effect in a new commit and records a
  dated correction naming both letters.
- The reporting chain carries each decision to the operator as one line
  with the comment's exact URL, never a bare item number.
- A comment that is only a letter token, such as "1A", is never posted by
  any session, because sessions and the operator can share one account.

## 4. Claims

The worker is the source of truth for what it holds.

- A lead sends a task by name. The worker replies "claimed: <lead>,
  <item>" or "busy: <lead>, <item it holds>".
- A task with no "claimed" reply is not assigned. A lead that gets "busy"
  picks another worker or waits; it never assumes.
- Two leads that sent the same worker a task in the same minute settle it
  by the worker's reply, not by who sent first.

## 5. Light communication

- One line to the reporting chain per change: worker, task, URL, state.
- Detail, evidence, and progress go in pull request or issue comments,
  never in messages.
- A message never carries a decision's answer as authority. Approval
  inside a session's permission layer is the operator's own act.

## 6. Scheduled briefs

Two editions a day, each one self-contained HTML file with charts, built
from a JSON edition file by the compiler. The edition schema, version 1,
is `docs/brief-schema.md`. The compiler design: one command, `sage-crew
brief <edition.json>`, writes the HTML beside the JSON; inline CSS, inline
SVG charts or a pinned vendored chart library, no network request at view
time, every string escaped, a null number rendered as "not read" with its
gap line, and the tables from sections 1 and 2 rendered from `actions`
and `sessions`.

Each edition covers, from the previous edition's cutoff to its own: what
merged, what is open and what blocks it, the decisions waiting with
exact comment URLs and their default times, session minutes (working,
blocked, blocked on the operator, idle), security findings opened and
closed, spend where a session can read it, and what comes next. Every
number names its source. A number that could not be read is a gap line,
never a zero.

The `sage-crew brief` and `sage-crew scale` commands are added to the
CLI addendum's command list. Defaults: editions at 09:00 and 23:00 in
the machine's local time zone; edition files in `~/.sage-crew/briefs/`,
beside the CLI's configuration, so nothing touches the repository; a
decision's default applies after 12 hours. Each is a field in the roles
file.

## 7. The hourly scaling advisor

Once an hour the reporting-chain role runs `sage-crew scale`, which
prints one advice row in the status table. It never adds or removes a
session on its own; the operator decides.

### Inputs

| Input | Source |
|---|---|
| `window_used_pct` | the harness's usage-window share. On Claude Code the status line's `rate_limits` fields carry the five-hour and seven-day percentages; the CLI reads a log of those values kept by the status-line script, one line per minute |
| `window_elapsed_pct` | minutes since the window reset, over the window length |
| per lane, last 60 minutes | working, blocked on the operator, blocked other, idle minutes, from each session's job record |
| `backlog` | items ready for a worker with no "claimed" reply |
| `decisions_open` | decision comments waiting, with the oldest age |

`projected_at_reset_pct` = `window_used_pct` divided by
`window_elapsed_pct`, capped at 100. When the usage share cannot be
read, the row says so and gives lane advice only.

### Rules, in order

1. **Operator bottleneck.** If blocked-on-operator minutes exceed
   `operator_share_pct` of all blocked minutes, the advice is **hold**,
   the reason names the oldest waiting decision, and the row is red:
   adding a worker adds nothing until the operator replies.
2. **Scale down.** If `projected_at_reset_pct` exceeds
   `down_above_pct`, or a lane idled more than `idle_minutes` of the last
   60 with `backlog` at 0, advise **scale down** and name the lane.
3. **Rebalance.** If one lead's lanes idle more than `idle_minutes`
   while another lead's backlog is at least `backlog_per_lane` per lane,
   advise **rebalance** and name the lane to move.
4. **Scale up.** If `projected_at_reset_pct` is under `up_below_pct`,
   no lane idled more than `idle_minutes`, and `backlog` is at least
   `backlog_per_lane` per lane, advise **scale up** by one worker.
5. Otherwise **hold**.

### The advice row

| # | Status | Item | Link | Their action |
|---|---|---|---|---|
| 1 | 🟡 | scale up: 3 lanes, backlog 7, projected 48% at reset | the advisor's log line | Start worker-4, or reply "hold" |

Every row carries the four numbers it used: projected use at reset,
backlog, idle minutes on the named lane, and the operator's share of
blocked time. A hold with nothing to do is green.

### Configuration

The roles file carries the thresholds. The defaults below are the
maintainer's answers of 2026-09-28.

```yaml
scaling:
  interval: 60m
  up_below_pct: 70
  down_above_pct: 80
  backlog_per_lane: 2
  idle_minutes: 30
  operator_share_pct: 50
```

`sage-crew scale --dry-run` prints the inputs and the rule that fired
without posting the row.

## Decisions

The maintainer answered all six choices on 2026-09-28, on the pull
request that carries this document.

1. Default edition times. Answer A: 09:00 and 23:00 local.
2. Default timeout hours on a decision comment. Answer B: 12 hours.
3. Default edition folder. Answer B: `~/.sage-crew/briefs/`, beside the
   CLI's configuration.
4. Scale-up threshold. Answer C: 70 percent.
5. Scale-down threshold. Answer B: 80 percent.
6. Operator-bottleneck share. Answer A: 50 percent.

## Gaps

- No usage-window log exists yet on any harness but Claude Code, and the
  Claude Code log is the operator's own status-line script, not a
  harness feature.
- No measurement exists of how much operator time the status table saves
  against prose reports.
- The edition schema has one real edition behind it; fields may change
  after the second.
