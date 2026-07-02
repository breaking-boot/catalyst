// settings.js
// Feature on/off model for the whole extension. Loaded after settings-schema.js
// (which owns the canonical SETTINGS_DEFAULTS) so every feature module can call
// isFeatureEnabled/isComparisonEnabled. The popup and options page write this
// same object to chrome.storage.sync; content.js listens for changes and
// live-applies them. No feature logic here.

const SETTINGS_KEY = "be_settings";

// Canonical defaults live in settings-schema.js (shared with popup.js) so the
// two contexts can never drift.
const DEFAULT_SETTINGS = SETTINGS_DEFAULTS;

let settings = { ...DEFAULT_SETTINGS };

// Coerce stored data to a clean boolean map: only known keys, only booleans,
// everything else falls back to its default. Guards against storage poisoning.
function normalizeSettings(raw) {
  const out = { ...DEFAULT_SETTINGS };
  if (!raw || typeof raw !== "object") return out;
  for (const key of Object.keys(DEFAULT_SETTINGS)) {
    if (typeof raw[key] === "boolean") out[key] = raw[key];
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
