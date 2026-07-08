// settings-schema.js
// Canonical, dependency-free settings schema shared by the content script
// (settings.js) and the extension pages (popup.js). Loaded before both so the
// defaults, feature labels, and per-board ordering live in exactly one place and
// can never drift between the two contexts. No logic here — data only.

// Every flag except versionCheck and bossTracker defaults to true: a missing or
// corrupt value means "feature on" so the extension fails open (full
// functionality) rather than silently dark. normalizeSettings seeds every key
// from this map. The two default-OFF exceptions are deliberate: versionCheck
// because it can reach off-device, bossTracker because the floating panel
// should be quiet by default — users who want it opt in via the popup or the
// boss-event reminder toast (see boss.js). An explicit stored boolean always
// wins over these defaults.
const SETTINGS_DEFAULTS = {
  // Top-level features (shown in the popup and options page).
  bossTracker: false, // default-OFF: panel must not auto-appear on install
  bossReminders: true, // toast when an event is live and the tracker is hidden
  allTimeLeaderboard: true,
  personalLeaderboards: true,
  profileXp: true,
  nextLesson: true,
  comparisons: true, // master gate for all XP/karma comparisons

  // Per-board comparison toggles (options page only); each is ANDed with `comparisons`.
  comparisonsAllTime: true, // extension's All-Time Learners panel
  comparisonsPersonal: true, // extension's Personal Leaderboards (all columns)
  comparisonsLeagueDaily: true, // native League -> Top Daily Learners
  comparisonsLeagueStanding: true, // native League -> Top League Learners
  comparisonsGlobalDaily: true, // native Global -> Top Daily Learners
  comparisonsGlobalKarma: true, // native Global -> Top Community Members

  // Per-board Personal Leaderboards toggles (options page only); each is ANDed
  // with `personalLeaderboards`. All four off hides the whole section.
  personalBoardDailyXp: true,
  personalBoardAllTimeXp: true,
  personalBoardDailyKarma: true,
  personalBoardAllTimeKarma: true,

  // The one default-OFF setting: opt-in GitHub release check (options page only).
  // Default-off works within the default-on framework because normalizeSettings
  // seeds this key from here, so a missing value resolves to false and stays off
  // until the user explicitly enables it. See updateCheck.js.
  versionCheck: false,
};

// Top-level feature toggles, in display order, rendered on both pages.
const FEATURE_TOGGLES = [
  { key: "bossTracker", label: "Boss event tracker", desc: "Floating panel: boss aura, damage, and chest progress." },
  { key: "bossReminders", label: "Boss event reminders", desc: "When the tracker is hidden and a boss event is live, show a small toast (at most once a day per event)." },
  { key: "allTimeLeaderboard", label: "Top All-Time Learners Leaderboard", desc: "Cumulative-XP standings boot.dev doesn't show natively." },
  { key: "personalLeaderboards", label: "Personal Leaderboards", desc: "Your hand-picked learners to compare against." },
  { key: "profileXp", label: "Profile cumulative XP", desc: "Total XP and level progress on public profiles." },
  { key: "nextLesson", label: "Next Lesson shortcut", desc: "Top-nav link and Alt+N to jump to your next lesson." },
  { key: "comparisons", label: "Leaderboard comparisons", desc: "Show how far ahead/behind you are on XP and karma." },
];

// Per-board Personal Leaderboards toggles (options page only). Ordered
// left-to-right to match the boards in the panel.
const PERSONAL_BOARD_TOGGLES = [
  { key: "personalBoardDailyXp", label: "Daily XP" },
  { key: "personalBoardAllTimeXp", label: "All-Time XP" },
  { key: "personalBoardDailyKarma", label: "Daily Karma" },
  { key: "personalBoardAllTimeKarma", label: "All-Time Karma" },
];

// Per-board comparison toggles (options page only). Ordered top-to-bottom to
// match how the boards appear on the leaderboard page.
const COMPARISON_BOARDS = [
  { key: "comparisonsPersonal", label: "Personal Leaderboards (Catalyst added)" },
  { key: "comparisonsLeagueDaily", label: "League · Top Daily Learners" },
  { key: "comparisonsLeagueStanding", label: "League · Top League Learners" },
  { key: "comparisonsGlobalDaily", label: "Global · Top Daily Learners" },
  { key: "comparisonsAllTime", label: "Global · Top All-Time Learners (Catalyst added)" },
  { key: "comparisonsGlobalKarma", label: "Global · Top Community Members" },
];
