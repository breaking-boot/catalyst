# Changelog

## Unreleased

- Bundled the ten avatar role frames into `assets/frames` and resolved them with `chrome.runtime.getURL` instead of pointing at boot.dev's build-hashed Nuxt asset URLs, which are regenerated on every redeploy and would eventually 404. The frames now load from the extension and can no longer break on a boot.dev deploy.
- Added an opt-in, maintainer-only detector (`checkFrameAssetsForRot`) that probes the original boot.dev frame URLs and warns (console + toast) when one stops resolving, signaling that the art changed upstream and the bundled copies should be refreshed. It does nothing unless `be_frame_debug` is set to `true` in `chrome.storage.local`, so ordinary users never see it.

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

## v0.4.0 - XP and karma delta display on all leaderboards, stability fixes

- Added XP and karma delta to every leaderboard entry — each card other than your own shows how far ahead (green) or behind (red) you are. Shown on the extension's Top All-Time Learners panel, all three Personal Leaderboards boards (daily XP, all-time XP, karma), and all four native boot.dev boards: League Top Daily Learners, League Top League Learners, Global Top Daily Learners, and Global Top Community Members. (Recent Archmages is left untouched — it lists no XP or karma.)
- Each delta is aligned with the value it compares against: native deltas are appended into the card's text column directly beneath the native value, and the extension panels' deltas sit with their own value. Dropped the redundant " today" suffix from daily deltas.
- Intercepted `/v1/leaderboard_karma/alltime` and `/v1/league_leaderboard_xp/{day,alltime}`. Each board is matched to the API response that feeds it, and the current user's own value is read from that same response (XPEarned for league/daily, Karma for community, XP for all-time), so deltas always match the displayed numbers; `getMyValue` prefers these responses and falls back to the saved personal record only when absent.
- Scoped native cards by document position between known section titles, so the dynamic "You are in position N…" subtitle (an `<h3>` in the Global boards) no longer truncates a section's card range and blanks its deltas.
- Eliminated leaderboard flicker: each panel is rendered once and then reconciled in place keyed by handle instead of replacing `innerHTML`, so the current-user card and its gold glow are never destroyed and recreated, unchanged rows are untouched, and only changed values patch a single text node (native deltas included). Supporting changes: a 50 ms debounced render scheduler, a fast-path and version-guarded `waitFor` so stale resolutions can't overwrite a newer render, a persistent Personal Leaderboards skeleton that keeps the input's value and focus, and a `compareDocumentPosition` check that repositions the personal panel without re-rendering.
- Stabilized current-user identity, the deeper cause of the residual glow flicker and intermittently wrong deltas. boot.dev's leaderboard cards are not inside `<main>`, so the nav-link heuristic could match a scrolled-past profile card and overwrite the stored handle mid-scroll. The handle is now sticky once known and taken authoritatively from the native gold-glow highlight (which only ever marks your own cards); the nav heuristic can no longer overwrite a known handle.
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
- Fixed the `ensureLeaderboardUiState` position check to use `compareDocumentPosition` so it repositions the Personal Leaderboards panel without triggering a full re-render when boot.dev inserts elements between the extension's panels - the primary cause of ongoing flicker.
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
