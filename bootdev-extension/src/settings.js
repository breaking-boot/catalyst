// settings.js
// Feature on/off model for the whole extension. Loaded second (right after
// utils.js) so every feature module can call isFeatureEnabled/isComparisonEnabled.
// The popup and options page write this same object to chrome.storage.sync;
// content.js listens for changes and live-applies them. No feature logic here.
//
// CANONICAL FLAG LIST: keep popup.js / options.html in sync with DEFAULT_SETTINGS.

const SETTINGS_KEY = "be_settings";

// Every flag defaults to true: a missing or corrupt value means "feature on",
// so the extension fails open (full functionality) rather than silently dark.
const DEFAULT_SETTINGS = {
  // Top-level features (shown in the popup and options page).
  bossTracker: true,
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
};

let settings = { ...DEFAULT_SETTINGS };

// Coerce stored data to a clean boolean map: only known keys, only booleans,
// everything else falls back to its default. Guards against storage poisoning.
function normalizeSettings(raw) {
  const out = { ...DEFAULT_SETTINGS };
  if (!raw || typeof raw !== "object") return out;
  for (const key of Object.keys(DEFAULT_SETTINGS)) {
    if (typeof raw[key] === "boolean") {
      out[key] = raw[key];
    } else if (key.startsWith("comparisons")) {
      // Migrate 0.5.0's diffs* keys to the renamed comparisons* keys so users
      // who customized their per-board toggles keep those choices on upgrade.
      const legacy = key.replace(/^comparisons/, "diffs");
      if (typeof raw[legacy] === "boolean") out[key] = raw[legacy];
    }
  }
  return out;
}

async function loadSettings() {
  settings = normalizeSettings(await chromeGetSync(SETTINGS_KEY));
  return settings;
}

// Replace the in-memory cache from a storage.onChanged payload.
function applyStoredSettings(raw) {
  settings = normalizeSettings(raw);
  return settings;
}

function getSettings() {
  return { ...settings };
}

function isFeatureEnabled(key) {
  return settings[key] !== false; // default-on semantics
}

// Effective per-board comparison state: the master toggle AND the board's own.
function isComparisonEnabled(boardKey) {
  return isFeatureEnabled("comparisons") && isFeatureEnabled(boardKey);
}
