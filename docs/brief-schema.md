# Brief edition schema, version 1

One edition is one JSON file, `briefs/YYYY-MM-DD-0900.json` or `-2300.json`, written by the auditor role. The compiler reads it and writes the HTML file beside it. Every string is untrusted text (pull request titles, comment bodies) and is escaped on render. Every number carries its source in `sources`. A value the collector could not read is `null`, and the reason is a line in `gaps`.

## Top level

| Field | Type | Meaning |
|---|---|---|
| `schema_version` | int | `1` |
| `edition` | object | `date` (YYYY-MM-DD, Eastern), `slot` (`0900` or `2300`), `generated_at` (UTC ISO 8601), `cutoff` (UTC ISO 8601, no data after this instant), `window` `{start, end}` (UTC ISO 8601, the period this edition covers, normally since the previous edition) |
| `headline` | string | one sentence |
| `summary` | string[] | three to six lines, each one fact with a number; plain text, never markdown |
| `counts` | object | `prs_merged`, `prs_open`, `issues_opened`, `issues_closed`, `decisions_pending`, `decisions_past_default` (ints; null when not read) |
| `actions` | Action[] | the status table: what needs the operator, sorted red, yellow, green |
| `merged` | Item[] | pull requests merged in the window, all repos in scope |
| `open` | Item[] | open pull requests at `cutoff`, with `state` and `blocked_on` |
| `decisions` | Decision[] | decision comments still waiting on the operator at `cutoff` |
| `sessions` | Session[] | one row per agent session alive in the window |
| `lanes` | object | `working_share_pct`, `blocked_on_operator_pct`, `sessions_alive`, `session_minutes_total` |
| `security` | object | `opened` Finding[], `closed` Finding[] |
| `spend` | object | `platform_usd` (number or null), `subscription_window_pct` (number or null), `source`, `as_of` |
| `next` | string[] | what happens before the next edition, one line each |
| `gaps` | string[] | every value that could not be read, with why |
| `series` | Series[] | trend data for charts, see below |
| `sources` | string[] | the commands and files the numbers came from |

## Action

`status` (`red` = needs the operator now, `yellow` = needs the operator, not urgent, `green` = needs nothing), `item` (short name), `url` (the exact link, a comment URL when one exists), `their_action` (one line, imperative, empty for green).

## Item

`repo` (`owner/name`), `number` (int), `title`, `url`, `author`, `labels` (string[]), `state` (`merged` | `ready` | `draft`), `risk` (`0` | `1` | null), `merged_at` or `opened_at` (UTC ISO 8601), `blocked_on` (string or null: `operator`, `ci`, `ruleset`, `sweeper`, `conflict`, `review`, `in-flight`).

## Decision

`repo`, `item_url`, `comment_url` (the exact `#issuecomment-N` link), `topic`, `posted_at` (UTC ISO 8601), `default` (letter or null), `default_applies_at` (UTC ISO 8601 or null), `exempt` (bool), `age_hours` (number at `cutoff`).

## Session

`name`, `kind` (`lead` | `reporting-chain` | `auditor` | `worker` | `assistant`), `lead` (the session that owns it, or null), `task` (one line), `task_url` (or null), `working_min`, `blocked_min`, `blocked_on_operator_min`, `idle_min`, `tokens_total` (int, from `state.json`), `state_now` (`working` | `blocked` | `idle` | `done`), `current` (one line, from the job record's last detail).

## Finding

`repo`, `item_url`, `comment_url`, `severity` (`low` | `medium` | `high` | `critical`), `title`, `opened_at`, `closed_at` (or null), `status` (`open` | `answered` | `fixed` | `accepted`).

## Series

`id` (string), `title`, `unit`, `kind` (`stacked-bar` | `line` | `bar`), `x` (string[], labels), `groups` (`{name, values: number[]}`[]). First edition ships three: `session-minutes` (stacked bar, one x per session: working, blocked on operator, blocked other, idle), `merged-per-window` (bar, one x per edition so far), `decisions-open` (line, decisions waiting at each edition, with the count over 8 hours as a second group).

## Rendering notes for the compiler

- Order on the page: headline with the cutoff, summary, the actions table (the operator acts here, so it sits above the fold), decisions, merged, open, the pool table (Worker | Lead | Task, from `sessions`) and the session chart, security, spend, next, gaps, sources.
- Authoring is JSON only. No markdown body; every string is escaped as text.
- A decision row links to `comment_url` and shows `default_applies_at` relative to `cutoff`.
- A `null` number renders as "not read" with the matching `gaps` line, never as 0.
- `gaps` and `sources` are always rendered, even when empty ("none").

## Example, abbreviated

```json
{
  "schema_version": 1,
  "edition": {"date": "2026-09-28", "slot": "0900", "generated_at": "2026-09-28T17:50:00Z", "cutoff": "2026-09-28T13:00:00Z",
              "window": {"start": "2026-09-28T03:43:00Z", "end": "2026-09-28T13:00:00Z"}},
  "headline": "One sentence with a number.",
  "summary": ["12 ready pull requests wait; 9 merged in the window.", "4 decisions waiting, oldest 9.2 hours."],
  "merged": [{"repo": "owner/repo", "number": 315, "title": "feat: ...", "url": "https://github.com/owner/repo/pull/315",
              "author": "operator-account", "labels": ["risk:1"], "state": "merged", "risk": 1, "merged_at": "2026-09-28T14:14:10Z", "blocked_on": null}],
  "open": [{"repo": "owner/repo", "number": 245, "title": "docs: ...", "url": "https://github.com/owner/repo/pull/245",
            "author": "operator-account", "labels": ["risk:0"], "state": "ready", "risk": 0, "opened_at": "2026-09-27T20:00:00Z", "blocked_on": "ruleset"}],
  "decisions": [{"repo": "owner/repo", "item_url": "https://github.com/owner/repo/issues/346",
                 "comment_url": "https://github.com/owner/repo/issues/346#issuecomment-1", "topic": "how the sweeper merges when main moved",
                 "posted_at": "2026-09-28T16:04:10Z", "default": null, "default_applies_at": null, "exempt": true, "age_hours": 10.6}],
  "sessions": [{"name": "main", "kind": "lead", "working_min": 152, "blocked_min": 26, "blocked_on_operator_min": 15, "idle_min": 1,
                "tokens_total": 8232493, "state_now": "working", "current": "reviewing a pull request"}],
  "lanes": {"working_share_pct": 49, "blocked_on_operator_pct": 85, "sessions_alive": 8, "session_minutes_total": 1189},
  "security": {"opened": [], "closed": []},
  "spend": {"platform_usd": null, "subscription_window_pct": null, "source": "not read", "as_of": null},
  "next": ["One line per planned step."],
  "gaps": ["Platform spend: no readable source from a session."],
  "series": [{"id": "session-minutes", "title": "Session minutes", "unit": "min", "kind": "stacked-bar",
              "x": ["main", "worker-1"], "groups": [{"name": "working", "values": [152, 118]}, {"name": "blocked on operator", "values": [15, 0]},
              {"name": "blocked other", "values": [11, 15]}, {"name": "idle", "values": [1, 47]}]}],
  "sources": ["gh pr list --state merged --json ... (run 2026-09-28T17:50Z)", "~/.claude/jobs/<id>/timeline.jsonl for 8 sessions"]
}
```
