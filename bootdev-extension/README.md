# Boot.dev Enhancer

A Manifest V3 Chrome extension that augments boot.dev:

1. **All-time XP leaderboard** — surfaces the `/v1/league_leaderboard_xp/alltime`
   data the page fetches on load but doesn't fully display.
2. **Cumulative profile XP** — shows total lifetime XP on user profiles.
3. **Boss-event tracker** — a persistent panel tracking current/high Boots Aura
   bonus %, boss damage, chest progress, and a toast when you're near the
   event high (a good time to submit).

## How it works

The site is a Nuxt/Vue SPA with hashed CSS classes, so scraping the DOM is
fragile. Instead, `injected.js` runs in the page context and wraps `fetch`
and `XMLHttpRequest` to clone every `api.boot.dev` JSON response, relaying it
to `content.js` (via `window.postMessage`). `content.js` routes each response
to a handler that injects UI or updates boss state in `chrome.storage`.

```
page fetch -> wrapped -> postMessage -> content router -> DOM / storage
```

## Load it (unpacked)

1. Go to `chrome://extensions`
2. Toggle **Developer mode** (top right)
3. Click **Load unpacked**
4. Select this `bootdev-extension/` folder
5. Open https://www.boot.dev and check the DevTools console for
   `[Boot.dev Enhancer] interceptor installed`

## The one thing you must tune: field names

The OpenAPI spec was built from request data; response *bodies* weren't
captured. So everywhere the code reads a field off a response, the name is a
best guess marked `FIXME`. To fix:

1. Open DevTools -> Network -> filter to the endpoint (e.g. `alltime`,
   `boss_events_progress`, or a profile `stats` call).
2. Click it, look at the **Response** tab, note the real field names.
3. Update the matching `FIXME` lines in `src/content.js`.

The three response shapes to confirm:

| Handler | Endpoint | Fields to confirm |
| --- | --- | --- |
| `handleAllTimeLeaderboard` | `league_leaderboard_xp/alltime` | array vs `.entries`; `handle`/`username`, `xp` |
| `handleProfileStats` | `users/public/{username}/stats` | where cumulative XP lives |
| `handleBossProgress` | `boss_events_progress` | `eventId`, `bonusPct`, `damage`, `nextChestAt`, `bossMaxHp`, chest tiers |

Once those names are right, everything else (injection, persistence,
new-event detection, the near-high toast) already works.

## Notes / next steps

- New-event detection keys off a changing `eventId`. If the boss endpoint has
  no stable event id, switch the reset logic to compare a start timestamp or
  boss name instead.
- The near-high toast fires once per distinct event-high value
  (`NEAR_HIGH_THRESHOLD = 0.95`). Tune that constant to taste.
- No `notifications` permission is used — alerts are in-page toasts. If you
  want OS-level notifications even when the tab is backgrounded, add a
  background service worker and the `"notifications"` permission.
- All-time high persists across events; per-event stats reset (auto or via the
  reset button).
