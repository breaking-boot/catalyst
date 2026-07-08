# Changelog

## v0.8.0 - Daily Karma board, per-board toggles, Brave support

### Personal Leaderboards
- **New Daily Karma board.** Boot.dev has no daily karma leaderboard and no per-day karma API, so the value is **measured**: Catalyst records karma snapshots for each tracked user from every karma source it already sees (stats/profile fetches, passively observed responses, the top-25 karma board) and shows the delta inside the rolling 24h window with a `past Nhr` note and explanatory tooltip, like daily XP. An observed karma gain displays immediately; a confident **0** requires a watched window of at least ~30 minutes; before that the cell shows `–` (unavailable). There is no exact or estimated tier for karma.
- Daily Karma **comparisons** work like the other boards: Catalyst also keeps a persisted karma series for you (fed by one extra own-stats request on leaderboard visits, the top-25 karma board, and your own passively observed profile/stats responses), and compares its 24h delta against each tracked user's.
- The four boards now render **side by side** (wrapping on narrow windows), ordered **Daily XP → All-Time XP → Daily Karma → All-Time Karma**, and were renamed from "Top Daily Learners" / "Top All-Time Learners" / "Top Community Members" — those titles fit the native global boards, not a hand-picked list.
- **Per-board toggles** (options page): each of the four boards can be switched off individually (ANDed with the Personal Leaderboards master, same pattern as the comparison toggles). A hidden board frees its column so the rest stretch; switching **all four off hides the entire section** — divider included — and stops its data requests until a board is re-enabled.
- Sub-hour measured windows are now labeled honestly (`past <1hr` and "less than an hour" in the tooltip) instead of rounding up to 1 hour, for both XP and karma.

### Browser support
- **Brave is now officially supported.** No code changes were needed — Brave runs MV3 Chrome extensions natively; the README gains Brave install instructions (`brave://extensions`) and notes the one caveat: Brave doesn't sync extension data, so settings stay on-device there.
- Docs now describe Catalyst as a **browser extension** for Chromium-based browsers rather than a Chrome extension. Firefox support is planned.

### Docs
- Capitalization pass: "boot.dev" → "Boot.dev" everywhere outside URLs/hostnames (source comments, UI strings, README, CHANGELOG, CLAUDE.md).

## v0.7.0 - Quiet-by-default boss tracker with event reminders

### Boss tracker
- **The boss tracker is now hidden by default.** The floating panel no longer auto-appears just because Catalyst is installed — it must be switched on in the settings popup, or via the new reminder toast. Anyone who previously flipped the Boss event tracker toggle keeps their explicit choice; users who were seeing the panel purely through the old default will need to opt back in.
- **New boss-event reminder.** When a boss event is live and the tracker is hidden, Catalyst shows a small in-page toast — "Boss event is live. Show Boss Tracker?" — with **Show Tracker** (enables the tracker on the spot) and **Don't remind me for this event** (silences reminders for that event only). It appears at most once per day per event, per device, and never again for an event after either button is clicked. A new **Boss event reminders** toggle (popup + options page, on by default) disables reminders entirely; the tracker can still be used manually either way.
- While the tracker is hidden, Catalyst makes **zero boss-event requests of its own** — event detection rides on the `boss_events_progress` responses the Boot.dev page already fetches. The last tracked event's stats (`be_boss_state`) are left untouched in quiet mode, so re-enabling the tracker later still shows them until newer event data replaces them.
- **New close (×) button on the panel header** (next to the gear and minimize buttons): hides the tracker and switches its setting off in one click, instead of a trip to the settings popup. Closing also counts as "don't remind me" for the current event, so the reminder toast doesn't immediately offer to reopen it.
- The **"No active boss event right now" toast is now shown at most once per 24h** per device. It used to reappear on every page refresh between events while the tracker was on.
- Reminders are in-page toasts like every other Catalyst alert — no `notifications` permission, no new permissions of any kind.
- Toasts can now carry action buttons (used by the reminder); plain toasts are unchanged.
- Added a maintainer-only `be_boss_reminder_debug` flag (`chrome.storage.local`) that feeds a synthetic active event through the real reminder path, so the toast and its buttons can be exercised between events (which are 4–8 weeks apart).

### Assets
- Added license/attribution clarification for bundled Boot.dev visual assets.
- Removed the maintainer-only `be_use_bundled_native_art` preview flag now that Boot.dev has given permission to bundle the assets; the no-art fallback path is no longer needed.

## v0.6.1 - Honest daily XP for tracked users

### Personal Leaderboards
- **Fixed Top Daily Learners showing 0 xp for everyone but yourself.** The old logic set a total-XP baseline at your *first sighting* of each tracked user each day, so anything they earned before you opened the leaderboard was invisible — every browser showed its own owner correct and all friends at 0. Daily XP for others is now derived from a rolling store of total-XP snapshots (Boot.dev's daily board is a rolling last-24-hours window), and every value carries an XP source label:
  - **exact** (plain) when the user is on the live global **or league** daily board;
  - **measured** (`past Nhr` note) — the XP delta between Catalyst's oldest and newest observations inside the 24h window. A single daily-board sighting seeds a full window: the board reports both `XPEarned` and total `XP`, so their total from exactly 24h ago is `XP − XPEarned` (recorded as a backdated snapshot);
  - **estimated** (`est.` note) from the user's public **activity heatmap** (`/v1/users/public/{u}/activity_heatmap`, a new consumed endpoint): completions today × an average XP per lesson (placeholder `ESTIMATED_XP_PER_LESSON = 115`, pending calibration) with the daily first-clear bonus and streak multiplier. Resubmits count as activity but grant no XP, so estimates can run high — hence the label;
  - **unavailable** (`–`) when Catalyst does not have enough data to show a value. Tooltips on every value explain the number. Source labels render on the same line as the value, to its left, so the three personal boards keep matching row heights.
- Snapshots are harvested from every XP source Catalyst already sees (profile fetches, global/league daily boards, all-time boards), capped at 60 per user, and pruned past ~24h; worst-case storage cost is a few KB per tracked user in `chrome.storage.local`. Adding a handle immediately re-harvests boards already received this session, so a league-mate shows their exact daily value on add instead of an estimate until the next reload. The latest daily-board values also persist for a few minutes, so exact values survive a page refresh instead of briefly showing the measured label while the boards re-fetch.
- A measured window shorter than 18h defers to a larger heatmap estimate (a short window understates the day); at 18h+ the measurement wins.
- The interceptor relay/request-bridge allowlist and router gained the activity-heatmap path (public endpoint, same class as the profile/stats calls; no new permissions).
- README now documents the accuracy ladder in plain language.

## v0.6.0 - Boss downtime, update checks, privacy/security hardening

### Boss tracker
- The tracker now detects **when no event is running** (via the event's `ExpiresAt`) and **stops polling between events**, showing a one-time "no active boss event" toast and keeping the last event's stats visible with an "ended" note. Polling resumes automatically when a new event starts — on navigation, a manual Refresh, tab focus, or Boot.dev's own fetch. Standing API load between events is now effectively zero.
- Boss data now also refreshes when you return to a backgrounded tab, instead of waiting up to two minutes for the next poll.

### Updates
- Added an **opt-in automatic update check** (options page, off by default). When enabled it asks GitHub once a day whether a newer Catalyst release exists and toasts a link if so. It uses GitHub's public API over standard CORS, so **no new permission** was added. When it's off, a one-time tip points to the opt-in, and both settings pages now show the installed version.
- Renamed the popup's link to the options page from "Per-board comparison options" to **"Additional options"**.

### Fixes
- **Learners with no profile image now show a default silhouette** (matching the native site) instead of an initial-letter tile. It is an inline SVG, so unlike the native site it adds no third-party image request.
- **Leaderboard avatars are now sized per rank tier.** Boot.dev keeps every rank badge the same overall size by varying ring thickness; Catalyst was scaling all frames uniformly, so lower-tier learners (below Archmage) rendered noticeably smaller than their neighbors. Each frame and its inner avatar are now sized to that tier's ring geometry, and an avatar with no frame (unrecognized tier, or the no-art preview) fills the box at the combo's size instead of the small ring-hole size.

### Security & privacy
- The page interceptor now **only rebroadcasts the API responses Catalyst actually uses**, instead of every `api.boot.dev` response, shrinking what any other extension on the page could observe. The page-context request bridge is likewise **restricted to those same endpoints**, so it can't be used by another script on the page as a proxy to arbitrary authenticated Boot.dev API paths.
- The bundled avatar frames are now served via a **dynamic resource URL** (`use_dynamic_url`), so the extension ID no longer leaks into Boot.dev's DOM through frame image URLs.
- The **boss panel's background texture is now bundled locally** instead of hot-linked from Boot.dev — the last remote dependency is gone.
- Added a plain-language **Privacy** section to the README, an "unofficial / not affiliated" note, an art-attribution note, and an MIT `LICENSE`.

### Maintainability
- Settings **defaults, labels, and board ordering now live in one shared `settings-schema.js`** used by both the content script and the settings pages, removing the two-copies drift risk. Dropped the now-unneeded `diffs*`→`comparisons*` migration.
- Skipped the redundant **initial-load double-fetch** of native leaderboards (a board Boot.dev just fetched is no longer re-requested within 10s).
- The Alt+N key listener is now torn down on context invalidation; added `FRAGILE`/resilience comments to the native-card and personal-panel DOM anchors; extracted magic numbers into named constants; added `:focus-visible` outlines and `aria-disabled` to the settings UI.
- Added a maintainer-only `be_use_bundled_native_art` flag (chrome.storage.local) to preview the no-bundled-art fallback (gradient boss panel, no rank frames) — the path taken if Boot.dev declines asset bundling.

## v0.5.1 - Leaderboard layout, settings polish, and fixes

### Layout
- Moved **Personal Leaderboards** to the top of the leaderboard page, above the native League Leaderboards section, with a divider matching the native sections (it previously sat between the Global sections).
- Added a **"You are in position N of M total students"** subtitle to the Top All-Time Learners section, matching the native boards (italic). The position comes from the all-time response; the student count has no API source, so it's read from the native board's rendered subtitle (falling back to position-only when unavailable).
- Restyled Personal Leaderboards and the section/board titles to match the native leaderboards: bigger bold section heading, semibold board titles, native username sizing, and transparent cell/section backgrounds (they were noticeably darker than Boot.dev's).

### Settings
- Renamed the master XP/karma toggle to **"Leaderboard comparisons"** and the **"All-Time Learners"** feature toggle to **"Top All-Time Learners Leaderboard"** (the underlying setting keys were renamed too, with the previous values migrated so existing choices are preserved).
- Clarified the Catalyst-added per-board labels and reordered the per-board comparison toggles top-to-bottom to match how the boards appear on the page.
- Bundled Boot.dev's map texture behind the settings popup and options page for visual consistency with the in-app panels (kept local, no remote dependency).

### Fixes
- Toasts now stack instead of covering one another, so the first-run settings prompt is no longer immediately hidden by the boss near-high notification.
- Fixed the **Profile cumulative XP** toggle not re-rendering the badge when switched back on; it no longer requires navigating away and back.
- Fixed **removing people from Personal Leaderboards** — the chip's × did nothing because its click handler was bound before the chips existed; it's now a delegated listener on the persistent container.
- Stopped a burst of **redundant API calls** on every settings change (two per saved handle, even for unrelated toggles). Settings now re-render from cache and only fetch when a feature turns on and its data isn't already in memory.
- League-board comparisons now show even when you're **not yet listed** (e.g. no XP earned today, or freshly assigned to a league): your value is treated as 0 for those small pools. Global boards are unaffected, where being absent means "outside the top 25," not zero.
- The total-students count now actually appears — it lives in an `<h3>` on the Global boards, which the reader previously skipped.

### Refactor
- Unified the terminology for the XP/karma comparison feature: every "diff" and "delta" reference (settings keys, functions, CSS classes, comments, and docs) is now "comparison". Older changelog entries were rewritten retroactively to match, for readability. The boss panel's unrelated "below event high" value was renamed for clarity too. No behavior change.

## v0.5.0 - Per-feature settings, local avatar frames

### Settings
- Added a settings system to toggle every Catalyst feature on or off: the boss tracker, the All-Time Learners panel, Personal Leaderboards, profile cumulative XP, the Next Lesson shortcut, and XP/karma comparisons. Click the toolbar icon for the popup, or open the options page for finer control.
- XP/karma comparisons use a master toggle plus a per-board toggle for each of the six boards (the two Catalyst panels and the four native boards), so comparisons can be enabled on, say, just the league boards. The master acts as a global gate: turning it off hides all comparisons and turning it back on restores each board's own setting.
- Settings are stored in `chrome.storage.sync` (so they roam across a user's devices) and apply live, with no page reload. Turning a feature off also stops its background work — the boss poll halts and the native comparison requests are skipped — so disabled features place no load on Boot.dev.
- A one-time prompt on first run points users to the toolbar icon (which Chrome hides until pinned) so the settings are discoverable. The popup and options page match the in-app boss-modal styling.
- No new permissions were added; the existing `storage` permission covers `storage.sync`.

### Avatar frames
- Bundled the ten avatar role frames into `assets/frames` and resolved them with `chrome.runtime.getURL` instead of pointing at Boot.dev's build-hashed Nuxt asset URLs, which are regenerated on every redeploy and would eventually 404. The frames now load from the extension and can no longer break on a Boot.dev deploy.
- Added an opt-in, maintainer-only detector (`checkFrameAssetsForRot`) that probes the original Boot.dev frame URLs and warns (console + toast) when one stops resolving, signaling that the art changed upstream and the bundled copies should be refreshed. It does nothing unless `be_frame_debug` is set to `true` in `chrome.storage.local`, so ordinary users never see it.

## v0.4.1 - Code-audit fixes: message-bridge hardening, boss reliability, cleanup

### Security
- Validated `event.origin` on both `window.postMessage` listeners (the content-script router and the page-context interceptor) so only same-origin messages are processed.
- Marked the injected.js web-accessible resource with `use_dynamic_url` to prevent extension fingerprinting from a stable resource URL.

### Quality
- Made the in-memory boss state authoritative and treated `chrome.storage` as a write-through cache, removing the read-modify-write race between the refresh interval, the manual Refresh button, and the near-high notification.
- Slowed boss polling from 30 sec to 2 min and skipped fetches while the tab is hidden, reducing standing API load.
- Memoized `findCurrentUserProfileLink` per synchronous render burst to stop repeated forced-layout `getBoundingClientRect` loops on every leaderboard render.
- Guarded the message-dispatch path so a single malformed payload can no longer abort sibling handlers.

### Maintainability
- Moved all boss auth-state and refresh-timer mutation into boss.js (`markBossAuthUnavailable`) so content.js no longer reaches into boss globals.
- Marked the hashed-class injection anchors with `FRAGILE` comments per project convention and documented the build-hashed frame asset list as expected to rot.
- Removed dead code (`normalizeImageUrl`, `ARCHMAGE_FRAME_URL`), dropped a duplicate daily-leaderboard request, documented `waitFor`'s null-on-timeout contract, and annotated inline threshold constants.

## v0.4.0 - XP and karma comparison display on all leaderboards, stability fixes

- Added XP and karma comparison to every leaderboard entry — each card other than your own shows how far ahead (green) or behind (red) you are. Shown on the extension's Top All-Time Learners panel, all three Personal Leaderboards boards (daily XP, all-time XP, karma), and all four native Boot.dev boards: League Top Daily Learners, League Top League Learners, Global Top Daily Learners, and Global Top Community Members. (Recent Archmages is left untouched — it lists no XP or karma.)
- Each comparison is aligned with the value it compares against: native comparisons are appended into the card's text column directly beneath the native value, and the extension panels' comparisons sit with their own value. Dropped the redundant " today" suffix from daily comparisons.
- Intercepted `/v1/leaderboard_karma/alltime` and `/v1/league_leaderboard_xp/{day,alltime}`. Each board is matched to the API response that feeds it, and the current user's own value is read from that same response (XPEarned for league/daily, Karma for community, XP for all-time), so comparisons always match the displayed numbers; `getMyValue` prefers these responses and falls back to the saved personal record only when absent.
- Scoped native cards by document position between known section titles, so the dynamic "You are in position N…" subtitle (an `<h3>` in the Global boards) no longer truncates a section's card range and blanks its comparisons.
- Eliminated leaderboard flicker: each panel is rendered once and then reconciled in place keyed by handle instead of replacing `innerHTML`, so the current-user card and its gold glow are never destroyed and recreated, unchanged rows are untouched, and only changed values patch a single text node (native comparisons included). Supporting changes: a 50 ms debounced render scheduler, a fast-path and version-guarded `waitFor` so stale resolutions can't overwrite a newer render, a persistent Personal Leaderboards skeleton that keeps the input's value and focus, and a `compareDocumentPosition` check that repositions the personal panel without re-rendering.
- Stabilized current-user identity, the deeper cause of the residual glow flicker and intermittently wrong comparisons. Boot.dev's leaderboard cards are not inside `<main>`, so the nav-link heuristic could match a scrolled-past profile card and overwrite the stored handle mid-scroll. The handle is now sticky once known and taken authoritatively from the native gold-glow highlight (which only ever marks your own cards); the nav heuristic can no longer overwrite a known handle.
- Corrected the avatar role-frame tier map using confirmed API data: added the missing Mage tier (level 90–99), restored the Archmage index (level 100+), and shifted the level formula down one step so all tiers render the correct frame; entries with no recognized role and a level below 10 (or no level) show no frame.
- Matched the current-user card glow to the native site value (`0 0 15px 1px #e5a012`) on both the all-time and personal rows.
- Matched the boss panel minimized-state title font size to the expanded title (both 16 px) and widened the panel to prevent title truncation at maximum aura length.

### Infrastructure
- Split `src/content.js` (2059 lines) into feature modules: `utils.js`, `leaderboard.js`, `profile.js`, `boss.js`, `nextLesson.js`, and a slim router-only `content.js`.
- Created `CLAUDE.md` with agent guidance, file responsibilities, architecture rules, and quick-check commands.

## v0.3.0 - Catalyst rename, leaderboard and avatar polish, boss widget improvements

- Renamed the public extension metadata to catalyst for Boot.dev.
- Stabilized current-user leaderboard highlighting across responsive layouts by avoiding leaderboard-card identity matches.
- Corrected current-user leaderboard glow so the card keeps its gray border until hover.
- Kept Personal Leaderboards anchored below Top All-Time Learners.
- Fixed Personal Leaderboards current-user highlighting and glow consistency.
- Added one retry for personal user checks that fail with an auth status.
- Polished the Boss Event widget controls, labels, progress bars, refresh, hidden reset placement, and text readability.
- Added a profile-page button for saving users to Personal Leaderboards.
- Fixed current-user identity falling back to stored handle on the leaderboard page, stopping a 2-second re-render loop caused by missing `.be-current-user` highlighting.
- Removed the unconditional Personal Leaderboards re-render that was appended to every Top All-Time Learners render, eliminating a redundant double-redraw on each API refresh.
- Switched `waitFor` polling loops to use tracked timeouts so they are cancelled cleanly when the extension context is invalidated.
- Corrected the complete avatar role-frame tier map using confirmed API data: added the missing Mage tier (level 90–99), restored the Archmage index (level 100+), and shifted the level formula down by one step so all tiers render the correct frame.
- Normalized role strings before frame lookup.
- Changed the avatar frame fallback to show no frame for entries with no recognized role and a level below 10 (or no level).
- Fixed the `ensureLeaderboardUiState` position check to use `compareDocumentPosition` so it repositions the Personal Leaderboards panel without triggering a full re-render when Boot.dev inserts elements between the extension's panels - the primary cause of ongoing flicker.
- Preserved input value and focus across Personal Leaderboards re-renders so background data refreshes no longer erase text the user is typing.
- Matched current-user card glow to the native site value (`0 0 15px 1px #e5a012`) in both the all-time and personal leaderboard rows.
- Matched the boss panel minimized-state title font size to the expanded-state title (both now 16 px).
- Updated packaging script to produce versioned zips (`releases/catalyst-v<version>.zip`) with the extension folder named after the version.

## v0.2.1 - Graceful error handling, invalid username validation, console-noise reduction, and release docs.

- Added graceful handling for extension reloads and invalidated content-script contexts.
- Added validation for manually added personal leaderboard users.
- Stopped persisting nonexistent personal leaderboard users.
- Reduced release console noise from the injected interceptor.
- Added release zip guidance and packaging script.

## v0.2.0 - Personal leaderboard build with manually added usernames.

- Added manual Personal Leaderboards on the Boot.dev leaderboard page.
- Added the Next Lesson nav shortcut and `Alt+N` keyboard shortcut.
- Added collapsible boss high settings.
- Added boss tracker drag-to-reposition with persistent position, and minimize/expand toggle.

## v0.1.0 - First usable local pre-rename build with core enhancement behavior.

- First usable local pre-rename build.
- Added the core all-time leaderboard, profile XP, boss tracker, and next-lesson behavior.
