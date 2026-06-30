// popup.js
// Drives both the toolbar popup (popup.html) and the options page (options.html).
// It reads/writes the same be_settings object in chrome.storage.sync that the
// content script's settings.js consumes; the content script live-applies changes
// via storage.onChanged. Renders whichever containers the host page provides:
// #be-features (always) and #be-comparison-boards (options page only).
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
  comparisons: true,
  comparisonsAllTime: true,
  comparisonsPersonal: true,
  comparisonsLeagueDaily: true,
  comparisonsLeagueStanding: true,
  comparisonsGlobalDaily: true,
  comparisonsGlobalKarma: true,
};

const FEATURES = [
  { key: "bossTracker", label: "Boss event tracker", desc: "Floating panel: boss aura, damage, and chest progress." },
  { key: "allTimeLeaderboard", label: "Top All-Time Learners Leaderboard", desc: "Cumulative-XP standings boot.dev doesn't show natively." },
  { key: "personalLeaderboards", label: "Personal Leaderboards", desc: "Your hand-picked learners to compare against." },
  { key: "profileXp", label: "Profile cumulative XP", desc: "Total XP and level progress on public profiles." },
  { key: "nextLesson", label: "Next Lesson shortcut", desc: "Top-nav link and Alt+N to jump to your next lesson." },
  { key: "comparisons", label: "Leaderboard comparisons", desc: "Show how far ahead/behind you are on XP and karma." },
];

// Ordered top-to-bottom to match how the boards appear on the leaderboard page.
const COMPARISON_BOARDS = [
  { key: "comparisonsPersonal", label: "Personal Leaderboards (Catalyst added)" },
  { key: "comparisonsLeagueDaily", label: "League · Top Daily Learners" },
  { key: "comparisonsLeagueStanding", label: "League · Top League Learners" },
  { key: "comparisonsGlobalDaily", label: "Global · Top Daily Learners" },
  { key: "comparisonsAllTime", label: "Global · Top All-Time Learners (Catalyst added)" },
  { key: "comparisonsGlobalKarma", label: "Global · Top Community Members" },
];

let settings = { ...DEFAULTS };

function normalize(raw) {
  const out = { ...DEFAULTS };
  if (raw && typeof raw === "object") {
    for (const key of Object.keys(DEFAULTS)) {
      if (typeof raw[key] === "boolean") {
        out[key] = raw[key];
      } else if (key.startsWith("comparisons")) {
        // Migrate 0.5.0's diffs* keys to the renamed comparisons* keys.
        const legacy = key.replace(/^comparisons/, "diffs");
        if (typeof raw[legacy] === "boolean") out[key] = raw[legacy];
      }
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
    if (key === "comparisons") updateComparisonDisabledState();
  });

  row.append(text, input, knob);
  return row;
}

function updateComparisonDisabledState() {
  const masterOn = settings.comparisons !== false;
  const section = document.getElementById("be-comparison-boards");
  if (!section) return;
  section.classList.toggle("be-disabled", !masterOn);
  section.querySelectorAll('input[type="checkbox"]').forEach((cb) => {
    cb.disabled = !masterOn;
  });
}

function render() {
  const features = document.getElementById("be-features");
  if (features) features.replaceChildren(...FEATURES.map(makeToggle));

  const boards = document.getElementById("be-comparison-boards");
  if (boards) boards.replaceChildren(...COMPARISON_BOARDS.map(makeToggle));

  updateComparisonDisabledState();

  const openOptions = document.getElementById("be-open-options");
  if (openOptions) {
    openOptions.addEventListener("click", () => chrome.runtime.openOptionsPage());
  }
}

chrome.storage.sync.get(SETTINGS_KEY, (o) => {
  settings = normalize(o?.[SETTINGS_KEY]);
  render();
});
