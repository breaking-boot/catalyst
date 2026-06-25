# Boot.dev Enhancer

A Manifest V3 Chrome extension that augments boot.dev with a few quality-of-life additions:

1. **All-time XP leaderboard** - adds a global all-time XP section to the leaderboard page.
2. **Cumulative profile XP** - adds lifetime XP and current-level XP progress to public user profile pages.
3. **Boss-event tracker** - tracks current, event-high, and all-time-high Boots Aura, boss damage, and chest progress.
4. **Next Lesson nav button** - adds a top-nav shortcut to the current next lesson when the extension can infer it.
5. **Personal leaderboards** - lets you save boot.dev handles and compare them in custom daily XP, all-time XP, and all-time karma boards.

## Project Layout

```text
catalyst/
  bootdev-extension/       Chrome "Load unpacked" target
    manifest.json
    src/
      content.js
      injected.js
      styles.css
  scripts/
    package-extension.sh   Creates bootdev-extension.zip
  reference_data/          API captures, rendered HTML, and OpenAPI docs
  CHANGELOG.md
  README.md
```

Only `bootdev-extension/` is needed by Chrome. The `reference_data/` directory is for development and documentation only.

## TL;DR

1. Download `bootdev-extension.zip`.
2. Unzip it.
3. In Chrome, open `chrome://extensions`, enable **Developer mode**, click **Load unpacked**, and select the unzipped `bootdev-extension` folder.
4. Visit `https://www.boot.dev`.

## Install From Zip

Chrome loads unpacked extension folders, not zip files directly. Unzip first, then load the folder.

1. Unzip `bootdev-extension.zip`.
   - macOS/Windows: double-click the zip file or use the built-in Extract option.
   - Terminal:

```bash
unzip bootdev-extension.zip
```

2. Open Chrome and go to:

```text
chrome://extensions
```

3. Turn on **Developer mode**.
4. Click **Load unpacked**.
5. Select the unzipped `bootdev-extension` folder.
6. Open or refresh `https://www.boot.dev`.

## Updating

1. Remove or replace the old unzipped `bootdev-extension` folder.
2. Unzip the new `bootdev-extension.zip`.
3. Go to `chrome://extensions`.
4. Click the reload button on **Boot.dev Enhancer**.
5. Refresh any open Boot.dev tabs.

## Usage

The extension runs automatically on `www.boot.dev`.

- On `https://www.boot.dev/leaderboard`, it adds **Top All-Time Learners** below the native **Top Daily Learners** section using `/v1/leaderboard_xp/alltime`.
- The all-time leaderboard uses the native Archmage role frame around avatars, highlights the logged-in user's row when present, and caches the latest response so repeat visits render faster while fresh data loads.
- On public profile pages like `https://www.boot.dev/u/<username>`, it adds `Total XP`, current-level XP progress, and remaining XP below the native level line in the profile header.
- On boot.dev pages, it shows the boss tracker once boss-event data has been loaded.
- Drag the boss tracker header to reposition it. The position persists across pages.
- Use the `-` / `+` boss tracker button to minimize or expand it. The minimized view still shows `Boss event - Current Aura: <aura>%`.
- In the expanded boss tracker, use the gear button to open or close high settings. Manually edit event high and all-time high percentages there if you learn about a missed high while the extension was not watching the page. Saving an event high above the all-time high also raises the all-time high.
- Use the boss tracker **reset** button to clear the current event stats while keeping the all-time aura high.
- Boss-event data refreshes in the background about every 30 seconds. Navigating within boot.dev resets that 30-second timer and triggers a fresh fetch.
- The **Next Lesson** top-nav link is learned from `/v1/dashboard_content`, specifically `CurrentLessonUUID`. Lesson progress responses trigger a delayed dashboard refresh so the link updates after completions. The dashboard **Continue Learning** button is also used as a same-page fallback.
- Press `Alt+N` to open the saved **Next Lesson** link from any boot.dev page. The shortcut is ignored while typing in inputs or editors.
- On `https://www.boot.dev/leaderboard`, the **Personal Leaderboards** section lets you add and remove handles. Handles are stored in `chrome.storage.local`.
- Personal **Top Daily Learners** uses `/v1/leaderboard_xp/day` when a saved handle appears there. Otherwise it shows observed XP gained today from the saved public profile snapshots. **Top All-Time Learners** uses public profile XP, and **Top Community Members** uses public stats karma.

No extra sign-in flow is required. The extension reads JSON responses that the boot.dev page fetches, and it can ask the page context to refresh selected endpoints with the existing boot.dev session.

## Troubleshooting

- If the extension does not appear, confirm that Chrome loaded the unzipped `bootdev-extension` folder, not the zip file.
- If changes do not show up after an update, click reload on the extension in `chrome://extensions`, then refresh Boot.dev.
- If a feature says a user is unavailable, try refreshing the leaderboard page. Invalid usernames are rejected and are not saved.
- Some console messages are normal page or browser noise, such as blocked ad/analytics requests or Boot.dev hydration warnings.
- If the extension was reloaded while Boot.dev was already open, refresh the Boot.dev tab to make sure the newest content script is active.

## How It Works

boot.dev is a Nuxt/Vue single-page app with rebuilt CSS class names, so the extension does not scrape data from the DOM. Instead:

```text
page fetch/XHR -> injected.js clone -> window.postMessage -> content.js router -> UI/storage
```

`injected.js` runs in the page context and wraps `fetch` plus `XMLHttpRequest`. It clones JSON responses from `api.boot.dev` and relays them to `content.js`. `content.js` runs as the content script, routes each response by URL, injects UI, stores boss-event state in `chrome.storage.local`, and requests route-specific refreshes through the page-context script when needed.

For Next Lesson, `/v1/dashboard_content` is treated as the authoritative source because its `CurrentLessonUUID` matches the dashboard Continue Learning target. Lesson-page APIs such as `/v1/users/lessons/{lessonId}` and `/v1/course_progress_by_lesson/{lessonId}` are used only as signals to refresh dashboard content.

## Development

Useful checks from the loadable extension directory:

```bash
cd bootdev-extension
node --check src/content.js
node --check src/injected.js
node -e "JSON.parse(require('fs').readFileSync('manifest.json', 'utf8')); console.log('manifest.json ok')"
```

## Release Zip

From the repo root, create a shareable zip with:

```bash
bash scripts/package-extension.sh
```

This creates `bootdev-extension.zip` containing the loadable `bootdev-extension/` folder. It does not include `.git`, `reference_data/`, `node_modules`, debug artifacts, or unrelated local files because only the extension directory is packaged.

You can also run the command manually:

```bash
zip -r bootdev-extension.zip bootdev-extension -x "*/.git/*" "*/node_modules/*" "*/.DS_Store" "*.log"
```

Recipients should unzip `bootdev-extension.zip` and select the unzipped `bootdev-extension` folder in Chrome's **Load unpacked** dialog.

## Versioning

This project uses semantic versioning:

- `MAJOR`: breaking changes or major rewrites.
- `MINOR`: backwards-compatible features.
- `PATCH`: bug fixes, graceful handling, docs, packaging, and polish.

Current version: `v0.2.1`.

Version map:

- `v0.1.0`: first usable local Boot.dev Enhancer build with core enhancement behavior.
- `v0.2.0`: personal leaderboard build with manually added usernames.
- `v0.2.1`: graceful error handling, invalid username validation, 401 handling, console-noise reduction, and release docs.

The reference captures and API docs live outside the Chrome load target:

- `reference_data/http_responses_from_api_endpoints/`
- `reference_data/har_files/`
- `reference_data/webpage_raw_html/`
- `reference_data/bootdev_api_info/bootdev_openapi.yaml`
- `reference_data/bootdev_api_info/old_openapi.yaml`

## Completed

- Replaced placeholder response-field guesses with fields from captured JSON.
- Moved the custom leaderboard section to global `/v1/leaderboard_xp/alltime`.
- Scoped the all-time leaderboard UI to `/leaderboard` only and cached the last response for faster repeat rendering.
- Added Archmage role frames, current-user glow, and native hover behavior to the all-time leaderboard rows.
- Switched cumulative profile XP to the public profile response, where `data.XP` is present.
- Moved cumulative profile XP into the native-looking profile header area below the level line.
- Added `XPForLevel / XPTotalForLevel` and remaining XP under the profile Total XP line.
- Confirmed boss new-event detection can key off `Event.UUID`.
- Mapped boss progress fields: `XPBonus`, `XPTotal`, `XPUser`, `Event.HealthPoints`, and `Rewards`.
- Added boss tracker background refresh, SPA route refresh resets, minimization, and drag-position persistence.
- Added manual boss event-high and all-time-high editing.
- Added a collapsible boss high-settings section.
- Added the top-nav Next Lesson shortcut and `Alt+N` keyboard shortcut.
- Added manual Personal Leaderboards for saved handles on the leaderboard page.
- Added semantic/text-landmark injection anchors instead of relying on hashed CSS classes.
- Updated `bootdev_openapi.yaml` with response schemas from the captured data and useful challenge schema details from `old_openapi.yaml`.
- Documented `/v1/dashboard_content` as the Next Lesson source and corrected karma leaderboard periods to `alltime`.
- Moved reference data out of the Chrome extension load directory.

## Notes

- Boss chest tier names are inferred from the rendered modal order because `boss_events_progress` contains chest UUIDs and thresholds, not display names.
- Alerts are in-page toasts; the extension does not request Chrome's `"notifications"` permission.
- Per-event boss stats reset automatically when `Event.UUID` changes. The all-time high persists across events.
