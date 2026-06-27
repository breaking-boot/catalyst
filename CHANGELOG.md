# Changelog

## v0.4.0 - XP and karma delta display on all leaderboards, stability fixes

- Added XP and karma delta to every leaderboard entry: each card (other than your own) now shows how far ahead or behind you are, in green when you lead and red when you trail.
- Deltas now appear on all leaderboards: the extension's Top All-Time Learners panel, all three Personal Leaderboards boards (daily XP, all-time XP, karma), and every native boot.dev board — League Top Daily Learners, League Top League Learners, Global Top Daily Learners, and Global Top Community Members.
- Native section deltas are appended into each card's text column, directly beneath the native value and sharing its left edge, so the delta lines up with the value it compares against (instead of floating at the card's bottom-right).
- Intercepted `/v1/leaderboard_karma/alltime` and `/v1/league_leaderboard_xp/{day,alltime}` to power the native karma and League deltas. Each native board is matched to the API response that feeds it, and the current user's own value is read from that same response, so the comparison is always self-consistent.
- Extended the daily XP cache to hold all leaderboard entries, and added the league-daily response as a fallback for the current user's own daily XP when they rank outside the global daily top 25.
- Removed the redundant " today" suffix from daily deltas; the board already implies the period.
- Fixed leaderboard flicker by rendering each panel once and then reconciling in place (keyed by handle) instead of replacing `innerHTML` on every update. The current-user card is never destroyed and recreated, so its gold glow no longer drops frames; unchanged rows are not touched at all, and only genuine value changes patch the affected text node. Native deltas are likewise patched in place.
- Added fast-path rendering: both `renderAllTimeLeaderboard` and `renderPersonalLeaderboards` skip the `waitFor` when their panel already exists, eliminating the async race where stale `waitFor` resolutions overwrote good renders.
- Added a version guard to the `waitFor` slow path so only the latest pending render applies; older superseded resolutions are no-ops.
- Debounced all data-triggered calls to the personal leaderboard render into `schedulePersonalLeaderboardRender` (50 ms), collapsing the burst of callbacks from simultaneous handle refreshes into a single render.
- The Personal Leaderboards form, chips, and row containers are now a persistent skeleton, so background refreshes never rebuild the input — input value and focus are preserved without the previous save/restore workaround.
- Corrected the complete avatar role-frame tier map using confirmed API data: added the missing Mage tier (level 90–99), restored the Archmage index (level 100+), and shifted the level formula down by one step so all tiers render the correct frame.
- Changed the avatar frame fallback to show no frame for entries with no recognized role and a level below 10 (or no level).
- Fixed the `ensureLeaderboardUiState` position check to use `compareDocumentPosition` so it repositions the Personal Leaderboards panel without triggering a full re-render when boot.dev inserts elements between the extension's panels.
- Matched current-user card glow to the native site value (`0 0 15px 1px #e5a012`) in both the all-time and personal leaderboard rows.
- Matched the boss panel minimized-state title font size to the expanded-state title (both now 16 px); widened the panel to prevent title truncation at maximum aura length.

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
- Added the Next Lesson nav shortcut and keyboard shortcut.
- Added collapsible boss high settings.

## v0.1.0 - First usable local pre-rename build with core enhancement behavior.

- First usable local pre-rename build.
- Added the core all-time leaderboard, profile XP, boss tracker, and next-lesson behavior.
