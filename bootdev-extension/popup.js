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
const NATIVE_ART_FLAG_KEY = "be_use_bundled_native_art";

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
  section.setAttribute("aria-disabled", masterOn ? "false" : "true");
  section.querySelectorAll('input[type="checkbox"]').forEach((cb) => {
    cb.disabled = !masterOn;
  });
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

  const boards = document.getElementById("be-comparison-boards");
  if (boards) boards.replaceChildren(...COMPARISON_BOARDS.map(makeToggle));

  const updates = document.getElementById("be-update-settings");
  if (updates) updates.replaceChildren(...UPDATE_SETTINGS.map(makeToggle));

  updateComparisonDisabledState();
  renderVersionBanner();

  const openOptions = document.getElementById("be-open-options");
  if (openOptions) {
    openOptions.addEventListener("click", () => chrome.runtime.openOptionsPage());
  }
}

// Maintainer-only preview of the "boot.dev declined asset bundling" fallback:
// set be_use_bundled_native_art=false in chrome.storage.local to drop the
// bundled map texture from the settings pages (mirrors the in-page behavior).
chrome.storage.local.get(NATIVE_ART_FLAG_KEY, (o) => {
  if (o?.[NATIVE_ART_FLAG_KEY] === false) document.body.classList.add("be-native-art-off");
});

chrome.storage.sync.get(SETTINGS_KEY, (o) => {
  settings = normalize(o?.[SETTINGS_KEY]);
  render();
});
