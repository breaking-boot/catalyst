// settings.js
// Feature on/off model for the whole extension. Loaded second (right after
// utils.js) so every feature module can call isFeatureEnabled/isDiffEnabled.
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
  diffs: true, // master gate for all XP/karma deltas

  // Per-board delta toggles (options page only); each is ANDed with `diffs`.
  diffsAllTime: true, // extension's All-Time Learners panel
  diffsPersonal: true, // extension's Personal Leaderboards (all columns)
  diffsLeagueDaily: true, // native League -> Top Daily Learners
  diffsLeagueStanding: true, // native League -> Top League Learners
  diffsGlobalDaily: true, // native Global -> Top Daily Learners
  diffsGlobalKarma: true, // native Global -> Top Community Members
};

let settings = { ...DEFAULT_SETTINGS };

// Coerce stored data to a clean boolean map: only known keys, only booleans,
// everything else falls back to its default. Guards against storage poisoning.
function normalizeSettings(raw) {
  const out = { ...DEFAULT_SETTINGS };
  if (raw && typeof raw === "object") {
    for (const key of Object.keys(DEFAULT_SETTINGS)) {
      if (typeof raw[key] === "boolean") out[key] = raw[key];
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

// Effective per-board delta state: the master diff toggle AND the board's own.
function isDiffEnabled(boardKey) {
  return isFeatureEnabled("diffs") && isFeatureEnabled(boardKey);
}
