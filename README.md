# Boot.dev Enhancer

A Manifest V3 Chrome extension that augments boot.dev with a few quality-of-life additions:

1. **All-time XP leaderboard** — shows the all-time league XP leaders that boot.dev already fetches but does not display as a dedicated section.
2. **Cumulative profile XP** — adds lifetime XP to public user profile pages.
3. **Boss-event tracker** — tracks current/event-high/all-time-high Boots Aura, boss damage, chest progress, and shows an in-page toast when the current aura is near the event high.

## Project Layout

```text
catalyst/
  bootdev-extension/       Chrome "Load unpacked" target
    manifest.json
    src/
      content.js
      injected.js
      styles.css
  reference_data/          API captures, rendered HTML, and OpenAPI docs
  README.md
```

Only `bootdev-extension/` is needed by Chrome. The `reference_data/` directory is for development and documentation only.

## Install

1. Open `chrome://extensions`.
2. Enable **Developer mode**.
3. Click **Load unpacked**.
4. Select `/home/aaron/boot.dev/breaking_boot/catalyst/bootdev-extension`.
5. Visit `https://www.boot.dev`.

To pick up local code changes, return to `chrome://extensions` and click the reload button on **Boot.dev Enhancer**, then refresh any open boot.dev tabs.

## Usage

The extension runs automatically on `www.boot.dev`.

- On `https://www.boot.dev/leaderboard`, it injects an all-time league XP section near the leaderboard content.
- On public profile pages like `https://www.boot.dev/u/<username>`, it adds `Total XP` near the profile header.
- When boot.dev fetches `/v1/boss_events_progress`, it shows a fixed boss tracker panel in the bottom-right corner.
- Use the boss tracker **reset** button to clear the current event stats while keeping the all-time aura high.

No extra sign-in flow is required. The extension only reads JSON responses that the boot.dev page already fetches.

## How It Works

boot.dev is a Nuxt/Vue single-page app with rebuilt CSS class names, so the extension does not scrape data from the DOM. Instead:

```text
page fetch/XHR -> injected.js clone -> window.postMessage -> content.js router -> UI/storage
```

`injected.js` runs in the page context and wraps `fetch` plus `XMLHttpRequest`. It clones JSON responses from `api.boot.dev` and relays them to `content.js`. `content.js` runs as the content script, routes each response by URL, injects UI, and stores boss-event state in `chrome.storage.local`.

## Development

Useful checks from the loadable extension directory:

```bash
cd bootdev-extension
node --check src/content.js
node --check src/injected.js
node -e "JSON.parse(require('fs').readFileSync('manifest.json', 'utf8')); console.log('manifest.json ok')"
```

The reference captures and API docs live outside the Chrome load target:

- `reference_data/http_responses_from_api_endpoints/`
- `reference_data/webpage_raw_html/`
- `reference_data/bootdev_api_info/bootdev_openapi.yaml`
- `reference_data/bootdev_api_info/old_openapi.yaml`

## Completed

- Replaced placeholder response-field guesses with fields from captured JSON.
- Confirmed all-time league XP arrives via `/v1/league_leaderboard_xp/alltime`.
- Kept support for `/v1/leaderboard_xp/alltime` in the router.
- Switched cumulative profile XP to the public profile response, where `data.XP` is present.
- Confirmed boss new-event detection can key off `Event.UUID`.
- Mapped boss progress fields: `XPBonus`, `XPTotal`, `XPUser`, `Event.HealthPoints`, and `Rewards`.
- Added semantic/text-landmark injection anchors instead of relying on hashed CSS classes.
- Updated `bootdev_openapi.yaml` with response schemas from the captured data and useful challenge schema details from `old_openapi.yaml`.
- Moved reference data out of the Chrome extension load directory.

## Notes

- Boss chest tier names are inferred from the rendered modal order because `boss_events_progress` contains chest UUIDs and thresholds, not display names.
- Alerts are in-page toasts; the extension does not request Chrome's `"notifications"` permission.
- Per-event boss stats reset automatically when `Event.UUID` changes. The all-time high persists across events.
