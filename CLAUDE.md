# CLAUDE.md — Agent guidance for catalyst

## What this project is
Chrome extension (Manifest V3) that augments boot.dev. The Chrome-loadable directory is `bootdev-extension/`. Everything else (`reference_data/`, `scripts/`, docs) is development support only and is never loaded by Chrome.

## File responsibilities

| File | Owns |
|------|------|
| `src/injected.js` | Runs in the page's JS context. Wraps `fetch` and `XMLHttpRequest` to clone `api.boot.dev` JSON responses and relay them to the content script via `window.postMessage`. No feature logic here. |
| `src/content.js` | Isolated-world content script. `window.postMessage` listener and URL router only. Calls handlers defined in the feature files below. Also owns the `storage.onChanged` listener that live-applies settings (`applyFeatureSettings`) and the first-run settings prompt. Must be listed last in `manifest.json`. |
| `src/utils.js` | Shared helpers: `waitFor`, `chromeGet`/`chromeSet` (local) and `chromeGetSync`/`chromeSetSync` (sync), `toast`, `escapeHtml`, number formatters, shared constants (`TOP_NAV_BAND_PX`). No feature logic. Must be listed first in `manifest.json`. |
| `src/settings-schema.js` | Canonical, dependency-free settings schema: `SETTINGS_DEFAULTS`, `FEATURE_TOGGLES`, `PERSONAL_BOARD_TOGGLES`, `COMPARISON_BOARDS`. Single source of truth shared by the content script (`settings.js`) and the extension pages (`popup.js`) so defaults/labels can't drift between contexts. Data only. Loaded right after `utils.js` (content script) and via `<script>` before `popup.js` (extension pages). |
| `src/settings.js` | Feature on/off model. `be_settings` in `chrome.storage.sync`, default-on (except `versionCheck` and `bossTracker`, default-off). `loadSettings`, `isFeatureEnabled(key)`, `isComparisonEnabled(boardKey)` / `isPersonalBoardEnabled(boardKey)` (the relevant master AND the per-board flag), `setFeatureEnabled(key, value)` (single-flag write from the content script; patches only that key into the raw stored object). Consumes `SETTINGS_DEFAULTS` from `settings-schema.js`. No feature logic. Loaded after `settings-schema.js`. |
| `src/updateCheck.js` | Opt-in GitHub release check (`versionCheck`, default-off). Throttled to once/24h; toasts when a newer release exists, or (when off) a one-time toast nudging the opt-in. Uses the CORS-open GitHub API, so no host permission is needed. |
| `popup.html` / `options.html` / `popup.js` / `popup.css` | Settings UI (extension pages, not injected). `popup.html` is the toolbar popup (`action.default_popup`); `options.html` is the options page (`options_ui`) and adds the per-board Personal Leaderboards toggles, the per-board comparison toggles, and the `versionCheck` opt-in. Both share `popup.js`/`popup.css` and load `src/settings-schema.js` first for the shared defaults/labels. They write `be_settings` to `storage.sync`; `content.js` live-applies via `storage.onChanged`. |
| `src/leaderboard.js` | All-time leaderboard injection and personal leaderboards feature. |
| `src/profile.js` | Cumulative XP display on public profile pages. |
| `src/boss.js` | Boss-event tracker: state management, render, drag-to-reposition, background refresh, settings panel, near-high notification, and event-active detection via `Event.ExpiresAt` (polling stops between events). Also owns the boss-event reminder toast (`bossReminders`) shown when the tracker is hidden and an event is live. |
| `src/nextLesson.js` | Next Lesson top-nav link and Alt+N keyboard shortcut. |
| `src/styles.css` | All injected UI styles. Uses `be-` prefix on all class names to avoid clashing with boot.dev's own styles. |
| `assets/` | Bundled static art (loaded by Chrome, unlike `reference_data/`). `frames/0.png`–`9.png` are avatar role frames indexed to `ROLE_FRAME_INDEX_BY_ROLE` in `leaderboard.js`, loaded into the page via `chrome.runtime.getURL` + `web_accessible_resources` (`use_dynamic_url`) as the fallback when the API gives no frame URL. `maptexture2.webp` is the boss-panel + settings-page background, referenced by `styles.css` (via `../assets/`) and `popup.css` — both extension-owned stylesheets, so no `web_accessible_resources` needed. Both are copies of boot.dev art, bundled with Boot.dev's permission — see `ATTRIBUTION.md`. |
| `manifest.json` | MV3 manifest. Do not add permissions without explaining why. Current permissions: `storage` only (covers both `storage.local` and `storage.sync`). Declares `action.default_popup` (popup.html) and `options_ui` (options.html). |

## Architecture rule (DOM scraping is a last resort)
boot.dev is a Nuxt/Vue SPA. Its CSS class names are hashed and rebuilt on every redeploy. **Avoid reading data by scraping the DOM unless absolutely necessary.** As much data as possible must come from intercepted API responses; the DOM is primarily for locating injection anchors and writing UI. When a value has no API source at all (e.g., the platform-wide student count, which boot.dev only server-renders into the page payload), reading it from rendered text is acceptable as a last resort — match on stable text landmarks, never hashed classes, and read only the minimum needed. See `src/leaderboard.js` `findTotalStudents` for the canonical example.

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
utils.js → settings-schema.js → settings.js → leaderboard.js → profile.js → boss.js → nextLesson.js → updateCheck.js → content.js
```

`utils.js` first so helpers are available everywhere; `settings-schema.js` next so the shared defaults/labels exist; `settings.js` after that so `isFeatureEnabled`/`isComparisonEnabled` are available to every feature. `content.js` last so the router can call handlers already defined by the feature files.

(`popup.js` runs in the extension-page context, not the content-script scope, so it can't see the feature files — but it loads `src/settings-schema.js` via its own `<script>` tag, so the popup and the content script share exactly one copy of the defaults, labels, and board ordering. Keep the settings key string (`be_settings`) aligned between `popup.js` and `settings.js`.)

## Conventions
- `FIXME` comments mark field names inferred from context that should be verified against real API responses in `reference_data/`.
- `chrome.storage.local` keys for boss data: `be_boss_state` (tracker stats), `be_boss_ui_state` (panel position/minimized), `be_boss_reminder_state` (reminder bookkeeping, per-device), `be_boss_inactive_notice` (last "no active event" toast timestamp). Feature settings live in `chrome.storage.sync` under `be_settings`.
- Gate any new feature behind a flag in `settings-schema.js` (`SETTINGS_DEFAULTS`, default-on; the two exceptions are `versionCheck`, default-off because it can reach off-device, and `bossTracker`, default-off because the panel must be quiet until the user opts in) and a toggle rendered from `FEATURE_TOGGLES`/`PERSONAL_BOARD_TOGGLES`/`COMPARISON_BOARDS`; check `isFeatureEnabled`/`isComparisonEnabled`/`isPersonalBoardEnabled` at its render/request entry and tear down cleanly when off. Because the schema is shared, adding a key in one place covers both the content script and the settings pages.
- All injected DOM elements use the `be-` CSS class prefix.
- Do not add `console.log` for debugging; use `console.debug` so it can be filtered.

## Off-limits / reference_data policy
- `reference_data/` — **never delete** any file here. Direct data captures (HTTP responses/requests, site HTML, `.har` files, and similar raw captures) must not be edited either — they are evidence and must stay faithful to what was captured.
- Non-capture reference docs in `reference_data/` — e.g. `bootdev_api_info/bootdev_openapi.yaml` (a work-in-progress spec), `bootdev_frontend_reference/bootdev_palette.css`, and `leaderboard_dom_notes.md` — **may be edited** to add clarifying comments or to refine them as we gain more data/clarity while building features. Improve them; just don't delete.
- `scripts/` — packaging utility only, not part of the extension.

## After any edit, run these checks from `bootdev-extension/`
```bash
node --check src/utils.js
node --check src/settings-schema.js
node --check src/settings.js
node --check src/leaderboard.js
node --check src/profile.js
node --check src/boss.js
node --check src/nextLesson.js
node --check src/updateCheck.js
node --check src/injected.js
node --check src/content.js
node --check popup.js
node -e "JSON.parse(require('fs').readFileSync('manifest.json','utf8')); console.log('manifest ok')"
```

## API endpoints used (summary)
- `/v1/leaderboard_xp/{period}` and `/v1/league_leaderboard_xp/{period}` — leaderboard data; period = day | week | month | alltime. The `day` boards are **rolling last-24-hours** windows (user-reported), and their entries carry both `XPEarned` (trailing-24h XP) and `XP` (lifetime total)
- `/v1/users/public/{username}` — public profile; cumulative XP is at `data.XP`
- `/v1/users/public/{username}/stats` — public stats including karma
- `/v1/users/public/{username}/activity_heatmap?timezone={IANA}` — per-day activity counts (`data.Calendar`; includes 0-XP resubmits) plus a separate `data.GithubCommits` series (streak-only, no XP); feeds the personal daily-XP estimate tier
- `/v1/boss_events_progress` — boss tracker source of truth; new-event detection keys off `Event.UUID`
- `/v1/dashboard_content` — Next Lesson source via `CurrentLessonUUID`
- `/v1/leaderboard_xp/day` — exact personal-board daily XP when a handle appears there; every sighting also yields a backdated total-XP snapshot (`XP − XPEarned` at now−24h)

Confirmed API response field names are documented in `reference_data/bootdev_api_info/bootdev_openapi.yaml`

## Matching boot.dev's look / finding anchors
`reference_data/bootdev_frontend_reference/` holds distilled front-end reference (its README explains usage): `bootdev_palette.css` is boot.dev's exact color/token set for styling injected UI to match the site, and `leaderboard_dom_notes.md` documents stable page structure, the native section divider/subtitle markup, and which selectors are volatile. Prefer these palette tokens over guessing hex values.

## Notes

- Boss chest tier names are inferred from the rendered modal order because `boss_events_progress` contains chest UUIDs and thresholds, not display names.
- Alerts are in-page toasts; the extension does not request Chrome's `"notifications"` permission.
- Per-event boss stats reset automatically when `Event.UUID` changes. The all-time high persists across events.
- Boss polling stops between events: a response whose `Event.ExpiresAt` is in the past marks the event inactive, halts the 2-min poll, and shows a "no active event" toast at most once per 24h per device (timestamp in `be_boss_inactive_notice`, storage.local). A forced re-check (navigation, manual Refresh, tab focus) or boot.dev's own passive `boss_events_progress` fetch resumes polling when a new event starts.
- Boss-event reminder (tracker hidden, `bossReminders` on): detection is **passive-only** — Catalyst issues zero boss requests while the tracker is off and relies on boot.dev's own relayed `boss_events_progress` responses. The toast shows at most once per 24h per event per device; either toast button — or the panel's close (×) button — ends reminders for that event ("Show Tracker" flips the setting via `setFeatureEnabled`, and the `storage.onChanged` live-apply does the rest). In quiet mode `handleBossProgress` never touches `be_boss_state`, so the last tracked event's stats survive until the tracker is re-enabled.
- Maintainer-only reminder test trigger (events are 4–8 weeks apart): set `be_boss_reminder_debug` to `true` in `chrome.storage.local` and reload boot.dev — a synthetic active event runs through the real `maybeShowBossReminder`, all production guards included. Remove `be_boss_reminder_state` to re-run; unset the flag when done.
- The interceptor (`injected.js`) only rebroadcasts passively-observed responses for the paths the router consumes (`RELAY_PATH_PATTERNS`); keep that allowlist in sync with the router in `content.js`.
- The opt-in update check hits `api.github.com` (CORS-open, no host permission). The extension still requests only `storage` + `https://www.boot.dev/*`.
- Personal-board daily XP for other users has no exact API source (the daily board is rolling-24h). `leaderboard.js` keeps per-user total-XP snapshots (`record.xpSnapshots`, `[t, xp]` pairs, ≤60, pruned >24.5h) harvested from every response that reveals a total, and `computeDailyXpView` picks the best of: live board value → snapshot-window delta → heatmap estimate → "–". `ESTIMATED_XP_PER_LESSON` (115) is a placeholder awaiting calibration from the maintainer's base-XP spreadsheet — update that one constant when real data lands.
- Personal-board daily karma has **no API source at all** (no daily karma board, nothing to backdate from), so `computeDailyKarmaView` is measured-or-unavailable only: `record.karmaSnapshots` mirrors the XP snapshot store, observed gains display immediately, and a confident 0 needs a ≥30-min watched window (`SNAPSHOT_MIN_WINDOW_MS`). The viewer's own comparison baseline lives in `be_current_user_karma` (storage.local, invalidated on handle change), fed by an own-stats request on leaderboard visits, the top-25 karma board, and passively-observed own profile/stats responses.
