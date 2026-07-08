// popup.js
// Drives both the toolbar popup (popup.html) and the options page (options.html).
// It reads/writes the same be_settings object in chrome.storage.sync that the
// content script's settings.js consumes; the content script live-applies changes
// via storage.onChanged. Renders whichever containers the host page provides:
// #be-features (always), #be-comparison-boards + #be-update-settings (options only).
//
// No inline script/handlers (popup runs under the default MV3 CSP). Defaults,
// feature labels, and board ordering come from settings-schema.js, the single
// source of truth shared with the content script.

const SETTINGS_KEY = "be_settings";

const DEFAULTS = SETTINGS_DEFAULTS;
const FEATURES = FEATURE_TOGGLES;

// Options-page-only opt-in. Default OFF; the only setting that reaches off-device.
const UPDATE_SETTINGS = [
  {
    key: "versionCheck",
    label: "Automatic update checks",
    desc: "Once a day, ask GitHub if a newer Catalyst release exists and notify you. Off by default; makes one request to github.com and nothing else.",
  },
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
  input.checked = settings[key] === true;
  input.dataset.key = key;

  const knob = document.createElement("span");
  knob.className = "be-switch";

  input.addEventListener("change", () => {
    settings[key] = input.checked;
    persist();
    if (key in DEPENDENT_SECTIONS) updateDependentSectionStates();
  });

  row.append(text, input, knob);
  return row;
}

// Options-page sections whose toggles only apply while a master feature toggle
// is on; the section is grayed out and disabled when its master is off.
const DEPENDENT_SECTIONS = {
  comparisons: "be-comparison-boards",
  personalLeaderboards: "be-personal-boards",
};

function updateDependentSectionStates() {
  for (const [masterKey, sectionId] of Object.entries(DEPENDENT_SECTIONS)) {
    const section = document.getElementById(sectionId);
    if (!section) continue;
    const masterOn = settings[masterKey] !== false;
    section.classList.toggle("be-disabled", !masterOn);
    section.setAttribute("aria-disabled", masterOn ? "false" : "true");
    section.querySelectorAll('input[type="checkbox"]').forEach((cb) => {
      cb.disabled = !masterOn;
    });
  }
}

function renderVersionBanner() {
  const el = document.getElementById("be-version");
  if (!el) return;
  let version = "";
  try {
    version = chrome.runtime.getManifest().version;
  } catch (_) {}
  el.textContent = version ? `Version ${version}` : "";
}

function render() {
  const features = document.getElementById("be-features");
  if (features) features.replaceChildren(...FEATURES.map(makeToggle));

  const personalBoards = document.getElementById("be-personal-boards");
  if (personalBoards) personalBoards.replaceChildren(...PERSONAL_BOARD_TOGGLES.map(makeToggle));

  const boards = document.getElementById("be-comparison-boards");
  if (boards) boards.replaceChildren(...COMPARISON_BOARDS.map(makeToggle));

  const updates = document.getElementById("be-update-settings");
  if (updates) updates.replaceChildren(...UPDATE_SETTINGS.map(makeToggle));

  updateDependentSectionStates();
  renderVersionBanner();

  const openOptions = document.getElementById("be-open-options");
  if (openOptions) {
    openOptions.addEventListener("click", () => chrome.runtime.openOptionsPage());
  }
}

chrome.storage.sync.get(SETTINGS_KEY, (o) => {
  settings = normalize(o?.[SETTINGS_KEY]);
  render();
});
