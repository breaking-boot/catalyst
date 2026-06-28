# CLAUDE.md — Agent guidance for catalyst

## What this project is
Chrome extension (Manifest V3) that augments boot.dev. The Chrome-loadable directory is `bootdev-extension/`. Everything else (`reference_data/`, `scripts/`, docs) is development support only and is never loaded by Chrome.

## File responsibilities

| File | Owns |
|------|------|
| `src/injected.js` | Runs in the page's JS context. Wraps `fetch` and `XMLHttpRequest` to clone `api.boot.dev` JSON responses and relay them to the content script via `window.postMessage`. No feature logic here. |
| `src/content.js` | Isolated-world content script. `window.postMessage` listener and URL router only. Calls handlers defined in the feature files below. Must be listed last in `manifest.json`. |
| `src/utils.js` | Shared helpers: `waitFor`, `chromeGet`, `chromeSet`, `toast`, `escapeHtml`, number formatters. No feature logic. Must be listed first in `manifest.json`. |
| `src/leaderboard.js` | All-time leaderboard injection and personal leaderboards feature. |
| `src/profile.js` | Cumulative XP display on public profile pages. |
| `src/boss.js` | Boss-event tracker: state management, render, drag-to-reposition, background refresh, settings panel, near-high notification. |
| `src/nextLesson.js` | Next Lesson top-nav link and Alt+N keyboard shortcut. |
| `src/styles.css` | All injected UI styles. Uses `be-` prefix on all class names to avoid clashing with boot.dev's own styles. |
| `manifest.json` | MV3 manifest. Do not add permissions without explaining why. Current permissions: `storage` only. |

## Hard architecture rule
boot.dev is a Nuxt/Vue SPA. Its CSS class names are hashed and rebuilt on every redeploy. **Never read data by scraping the DOM.** All data comes from intercepted API responses. The DOM is used only for locating injection anchors and writing UI.

Interception flow:
```
page fetch/XHR → injected.js (page context) → window.postMessage → content.js router → feature handlers
```

## Injection anchor priority
When finding where to inject UI elements, prefer stable hooks in this order:
1. Element `id`
2. `data-*` attributes
3. `aria-*` attributes
4. Semantic HTML tags
5. Visible text content landmarks
6. CSS class names — if used, add a `// FRAGILE: hashed class, may break on redeploy` comment

## Content script load order
Files share a single global scope — no ES module syntax (`import`/`export`), no build step, no bundler. `manifest.json` loads them in order:

```
utils.js → leaderboard.js → profile.js → boss.js → nextLesson.js → content.js
```

`utils.js` first so helpers are available everywhere. `content.js` last so the router can call handlers already defined by the feature files.

## Conventions
- `FIXME` comments mark field names inferred from context that should be verified against real API responses in `reference_data/`.
- `chrome.storage.local` key for boss state: `be_boss_state`.
- All injected DOM elements use the `be-` CSS class prefix.
- Do not add `console.log` for debugging; use `console.debug` so it can be filtered.

## Off-limits
- `reference_data/` — read-only API captures and reference docs. Never edit or delete any file here.
- `scripts/` — packaging utility only, not part of the extension.

## After any edit, run these checks from `bootdev-extension/`
```bash
node --check src/utils.js
node --check src/leaderboard.js
node --check src/profile.js
node --check src/boss.js
node --check src/nextLesson.js
node --check src/injected.js
node --check src/content.js
node -e "JSON.parse(require('fs').readFileSync('manifest.json','utf8')); console.log('manifest ok')"
```

## API endpoints used (summary)
- `/v1/leaderboard_xp/{period}` and `/v1/league_leaderboard_xp/{period}` — leaderboard data; period = day | week | month | alltime
- `/v1/users/public/{username}` — public profile; cumulative XP is at `data.XP`
- `/v1/users/public/{username}/stats` — public stats including karma
- `/v1/boss_events_progress` — boss tracker source of truth; new-event detection keys off `Event.UUID`
- `/v1/dashboard_content` — Next Lesson source via `CurrentLessonUUID`
- `/v1/leaderboard_xp/day` — used for personal leaderboard daily XP when a handle appears there

Confirmed API response field names are documented in `reference_data/bootdev_api_info/bootdev_openapi.yaml`

## Notes

- Boss chest tier names are inferred from the rendered modal order because `boss_events_progress` contains chest UUIDs and thresholds, not display names.
- Alerts are in-page toasts; the extension does not request Chrome's `"notifications"` permission.
- Per-event boss stats reset automatically when `Event.UUID` changes. The all-time high persists across events.
