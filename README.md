# task-meter

A Claude Code plugin that pins one compact status line under the prompt: live
turn progress, token usage, context-window fill, cache hit rate, an ETA until
the window fills, and what the session has cost.

```
⚡ 1m05s · turn 3 │ ↑186.0k ↓1.2k │ cache 97% │ ctx 45% · 90.0k/200.0k │ ≈2m20s to full │ $0.42
```

No panes, no popups, no polling processes — one pinned line that stays out of
the way. Segments whose figures aren't known yet are simply omitted.

## What each segment means

| Segment | Meaning | Source |
| --- | --- | --- |
| `⚡ 1m05s · turn 3` | The current turn has been running 1m05s, it's the session's 3rd turn; `✓ idle` between turns | `turn.start`, a 1s ticker |
| `↑186.0k ↓1.2k` | Cumulative session tokens: input side (uncached + cache-read + cache-written) ↑, generated ↓ | `turn.complete` usage, summed |
| `cache 97%` | Cache hit rate: cache-read ÷ total input tokens | same |
| `ctx 45% · 90.0k/200.0k` | Live context-window fill | `session.measure` |
| `≈2m20s to full` | At the current fill rate, the window fills in this long (compaction then kicks in) | fill-rate samples |
| `$0.42` | Session cost, the engine's ledger (the `/cost` figure) — or your own rates, see below | `session.measure` |

One honest caveat: nobody can know when a *task* will finish — not even Claude.
The `≈… to full` figure is the computable proxy: how long until the context
window fills at the rate the session is burning it.

## Install

```
/plugin install task-meter --marketplace YUANYINGLONG-91/claude-task-meter
```

(`y` to add the marketplace, then pick a scope.)

## Cost that matches your account

The default `$` figure is the engine's own ledger — exact for Anthropic API
keys at public prices. If your key is billed differently (a relay, Bedrock,
Vertex, a negotiated rate), set your own prices; tokens are tallied **per
model**, so switching models mid-session still prices right.

In `~/.claude/settings.json`:

```json
"pluginConfigs": {
  "task-meter": {
    "options": {
      "pricing": "{\"default\":[3,15,0.3,3.75],\"claude-opus-4-7\":[15,75,1.5,18.75]}"
    }
  }
}
```

Rates are USD per 1M tokens, in the order **[input, output, cacheRead,
cacheWrite]**, keyed by model id with `default` as the fallback. A
custom-priced figure is drawn as `≈$1.50` to tell it from the ledger. Both
fields are also rows in `/config` (paste the JSON there unescaped).

On a fixed-price subscription where a dollar figure means nothing, set
**Show cost** (`showCost`) to `false` in `/config` and the segment disappears.

## Develop

```
claude plugin validate <folder>   # manifest + hooks, as the engine reads them
claude plugin test <folder>       # the *.test.ts suite
tsc -p <folder>                   # types, once the engine has laid .claude-plugin/types
```

`hooks/format.ts` holds the pure display math (unit-tested); `hooks/register.ts`
wires the events. Session totals live in `$.state`, so hot reloads don't zero
them.
