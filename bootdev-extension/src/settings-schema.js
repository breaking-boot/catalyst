// settings-schema.js
// Canonical, dependency-free settings schema shared by the content script
// (settings.js) and the extension pages (popup.js). Loaded before both so the
// defaults, feature labels, and per-board ordering live in exactly one place and
// can never drift between the two contexts. No logic here — data only.

// Every flag except versionCheck, bossTracker, submitConfirm, and
// assignmentShortcuts defaults to true: a missing or corrupt value means
// "feature on" so the extension fails open (full functionality) rather than
// silently dark. normalizeSettings seeds every key from this map. The four
// default-OFF exceptions are deliberate: versionCheck because it can reach
// off-device, bossTracker because the floating panel should be quiet by default
// (users opt in via the popup or the boss-event reminder toast, see boss.js),
// submitConfirm because it puts a step in front of a native Boot.dev action —
// nobody should meet a confirmation dialog they didn't ask for — and
// assignmentShortcuts because it claims ten Alt+digit combinations inside the
// code editor, which is character entry on some Mac layouts. An explicit stored
// boolean always wins over these defaults.
const SETTINGS_DEFAULTS = {
  // Top-level features (shown in the popup and options page).
  bossTracker: false, // default-OFF: panel must not auto-appear on install
  bossReminders: true, // toast when an event is live and the tracker is hidden
  allTimeLeaderboard: true,
  personalLeaderboards: true,
  profileXp: true,
  nextLesson: true,
  challengeDifficulty: true, // Training Grounds difficulty filter (inert until tiers are picked)
  cliShortcuts: true, // Alt+C / Alt+Shift+C copy the lesson's bootdev commands
  assignmentShortcuts: false, // default-OFF: claims Alt+0-9 even while typing
  submitConfirm: false, // default-OFF: never interrupt a native action uninvited
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
//
// `desc` is the full explanation and is what the options page shows. The popup
// is a glance-sized list, so it prefers `shortDesc` when a toggle has one —
// add it only when the full text is too long to skim (one sentence, no
// caveats, no "off by default"; the switch already says that).
const FEATURE_TOGGLES = [
  { key: "bossTracker", label: "Boss event tracker", desc: "Floating panel: boss aura, damage, and chest progress." },
  { key: "bossReminders", label: "Boss event reminders", desc: "When the tracker is hidden and a boss event is live, show a small toast (at most once a day per event)." },
  { key: "allTimeLeaderboard", label: "Top All-Time Learners Leaderboard", desc: "Cumulative-XP standings Boot.dev doesn't show natively." },
  { key: "personalLeaderboards", label: "Personal Leaderboards", desc: "Your hand-picked learners to compare against." },
  { key: "profileXp", label: "Profile cumulative XP", desc: "Total XP and level progress on public profiles." },
  { key: "nextLesson", label: "Next Lesson shortcut", desc: "Top-nav link and Alt+N to jump to your next lesson." },
  { key: "challengeDifficulty", label: "Training Grounds difficulty filter", desc: "Easy/Medium/Hard pills in the Challenge Catalog's filter popover." },
  { key: "cliShortcuts", label: "CLI command shortcuts", desc: "On lessons that show bootdev commands, Alt+C copies the run command and Alt+Shift+C the submit command." },
  { key: "assignmentShortcuts", label: "Assignment step shortcuts", shortDesc: "Keyboard shortcuts to tick checklist steps and jump back to your code.", desc: "On lessons and challenges, Alt+1-Alt+9 tick the matching top-level checklist step, Alt+0 ticks the next unfinished box, and Alt+` (left of the 1 key) sends you back to the code editor or answer box — all of it while you're typing in the editor, a terminal, or an answer box. Off by default: on some Mac layouts Alt+digit types characters such as #." },
  { key: "submitConfirm", label: "Confirm code submissions", shortDesc: "Ask before submitting when you click Submit on a code lesson.", desc: "Ask before submitting when you click Submit on a code lesson, so a stray click can't cost your streak. Boot.dev's Ctrl+Shift+Enter still submits immediately." },
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
