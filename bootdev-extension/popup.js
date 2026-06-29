// popup.js
// Drives both the toolbar popup (popup.html) and the options page (options.html).
// It reads/writes the same be_settings object in chrome.storage.sync that the
// content script's settings.js consumes; the content script live-applies changes
// via storage.onChanged. Renders whichever containers the host page provides:
// #be-features (always) and #be-diff-boards (options page only).
//
// No inline script/handlers (popup runs under the default MV3 CSP). Keep the key
// and defaults below in sync with src/settings.js.

const SETTINGS_KEY = "be_settings";

const DEFAULTS = {
  bossTracker: true,
  allTimeLeaderboard: true,
  personalLeaderboards: true,
  profileXp: true,
  nextLesson: true,
  diffs: true,
  diffsAllTime: true,
  diffsPersonal: true,
  diffsLeagueDaily: true,
  diffsLeagueStanding: true,
  diffsGlobalDaily: true,
  diffsGlobalKarma: true,
};

const FEATURES = [
  { key: "bossTracker", label: "Boss event tracker", desc: "Floating panel: boss aura, damage, and chest progress." },
  { key: "allTimeLeaderboard", label: "All-Time Learners", desc: "Cumulative-XP standings boot.dev doesn't show natively." },
  { key: "personalLeaderboards", label: "Personal Leaderboards", desc: "Your hand-picked learners to compare against." },
  { key: "profileXp", label: "Profile cumulative XP", desc: "Total XP and level progress on public profiles." },
  { key: "nextLesson", label: "Next Lesson shortcut", desc: "Top-nav link and Alt+N to jump to your next lesson." },
  { key: "diffs", label: "Leaderboard diffs", desc: "Show how far ahead/behind you are on XP and karma." },
];

const DIFF_BOARDS = [
  { key: "diffsAllTime", label: "All-Time Learners (Catalyst panel)" },
  { key: "diffsPersonal", label: "Personal Leaderboards (Catalyst panel)" },
  { key: "diffsLeagueDaily", label: "League · Top Daily Learners" },
  { key: "diffsLeagueStanding", label: "League · Top League Learners" },
  { key: "diffsGlobalDaily", label: "Global · Top Daily Learners" },
  { key: "diffsGlobalKarma", label: "Global · Top Community Members" },
];

let settings = { ...DEFAULTS };

function normalize(raw) {
  const out = { ...DEFAULTS };
  if (raw && typeof raw === "object") {
    for (const key of Object.keys(DEFAULTS)) {
      if (typeof raw[key] === "boolean") out[key] = raw[key];
    }
  }
  return out;
}

function persist() {
  chrome.storage.sync.set({ [SETTINGS_KEY]: settings });
}

function makeToggle({ key, label, desc }) {
  const row = document.createElement("label");
  row.className = "be-toggle";

  const text = document.createElement("span");
  text.className = "be-toggle-text";

  const title = document.createElement("span");
  title.className = "be-toggle-title";
  title.textContent = label;
  text.appendChild(title);

  if (desc) {
    const sub = document.createElement("span");
    sub.className = "be-toggle-desc";
    sub.textContent = desc;
    text.appendChild(sub);
  }

  const input = document.createElement("input");
  input.type = "checkbox";
  input.checked = settings[key] !== false;
  input.dataset.key = key;

  const knob = document.createElement("span");
  knob.className = "be-switch";

  input.addEventListener("change", () => {
    settings[key] = input.checked;
    persist();
    if (key === "diffs") updateDiffDisabledState();
  });

  row.append(text, input, knob);
  return row;
}

function updateDiffDisabledState() {
  const masterOn = settings.diffs !== false;
  const section = document.getElementById("be-diff-boards");
  if (!section) return;
  section.classList.toggle("be-disabled", !masterOn);
  section.querySelectorAll('input[type="checkbox"]').forEach((cb) => {
    cb.disabled = !masterOn;
  });
}

function render() {
  const features = document.getElementById("be-features");
  if (features) features.replaceChildren(...FEATURES.map(makeToggle));

  const boards = document.getElementById("be-diff-boards");
  if (boards) boards.replaceChildren(...DIFF_BOARDS.map(makeToggle));

  updateDiffDisabledState();

  const openOptions = document.getElementById("be-open-options");
  if (openOptions) {
    openOptions.addEventListener("click", () => chrome.runtime.openOptionsPage());
  }
}

chrome.storage.sync.get(SETTINGS_KEY, (o) => {
  settings = normalize(o?.[SETTINGS_KEY]);
  render();
});
