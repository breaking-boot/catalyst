# Changelog

## v0.3.0

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
- Fixed the `ensureLeaderboardUiState` position check to use `compareDocumentPosition` so it repositions the Personal Leaderboards panel without triggering a full re-render when boot.dev inserts elements between the extension's panels — the primary cause of ongoing flicker.
- Preserved input value and focus across Personal Leaderboards re-renders so background data refreshes no longer erase text the user is typing.
- Matched current-user card glow to the native site value (`0 0 15px 1px #e5a012`) in both the all-time and personal leaderboard rows.
- Matched the boss panel minimized-state title font size to the expanded-state title (both now 16 px).
- Updated packaging script to produce versioned zips (`releases/catalyst-v<version>.zip`) with the extension folder named after the version.

## v0.2.1

- Added graceful handling for extension reloads and invalidated content-script contexts.
- Added validation for manually added personal leaderboard users.
- Stopped persisting nonexistent personal leaderboard users.
- Reduced release console noise from the injected interceptor.
- Added release zip guidance and packaging script.

## v0.2.0

- Added manual Personal Leaderboards on the Boot.dev leaderboard page.
- Added the Next Lesson nav shortcut and keyboard shortcut.
- Added collapsible boss high settings.

## v0.1.0

- First usable local pre-rename build.
- Added the core all-time leaderboard, profile XP, boss tracker, and next-lesson behavior.
