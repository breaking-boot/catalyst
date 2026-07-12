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

// Toggle rows only — separated from render() so an import (which replaces
// be_settings behind this page's back) can refresh them without rebuilding the
// backup section and losing its status text.
function renderToggles() {
  const features = document.getElementById("be-features");
  if (features) features.replaceChildren(...FEATURES.map(makeToggle));

  const personalBoards = document.getElementById("be-personal-boards");
  if (personalBoards) personalBoards.replaceChildren(...PERSONAL_BOARD_TOGGLES.map(makeToggle));

  const boards = document.getElementById("be-comparison-boards");
  if (boards) boards.replaceChildren(...COMPARISON_BOARDS.map(makeToggle));

  const updates = document.getElementById("be-update-settings");
  if (updates) updates.replaceChildren(...UPDATE_SETTINGS.map(makeToggle));

  updateDependentSectionStates();
}

// ---------------------------------------------------------------------------
// Backup & restore (options page only: #be-backup and src/backup.js — which
// owns the file format and merge logic — exist only there). Every string that
// came out of an uploaded file renders via textContent; file content is
// untrusted.

function makeBackupButton(label, onClick) {
  const btn = document.createElement("button");
  btn.type = "button";
  btn.className = "be-settings-link";
  btn.textContent = label;
  btn.addEventListener("click", onClick);
  return btn;
}

function backupFileName() {
  const d = new Date();
  const pad = (n) => String(n).padStart(2, "0");
  return `catalyst-backup-${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}.json`;
}

function renderBackupSection() {
  const host = document.getElementById("be-backup");
  if (!host) return;

  const actions = document.createElement("div");
  actions.className = "be-backup-actions";

  const confirmBox = document.createElement("div");
  confirmBox.className = "be-backup-confirm";
  confirmBox.hidden = true;

  const status = document.createElement("div");
  status.className = "be-backup-status";
  status.setAttribute("role", "status");

  let pendingData = null;

  const setStatus = (lines, isError = false) => {
    status.classList.toggle("be-backup-error", isError);
    status.replaceChildren(
      ...[].concat(lines).filter(Boolean).map((line) => {
        const p = document.createElement("p");
        p.textContent = line;
        return p;
      })
    );
  };

  const clearConfirm = () => {
    pendingData = null;
    confirmBox.hidden = true;
    confirmBox.replaceChildren();
  };

  const exportBtn = makeBackupButton("Export data", async () => {
    exportBtn.disabled = true;
    try {
      const payload = await collectBackupData();
      const blob = new Blob([JSON.stringify(payload, null, 2)], { type: "application/json" });
      const url = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = url;
      a.download = backupFileName();
      a.click();
      setTimeout(() => URL.revokeObjectURL(url), 10_000);
      clearConfirm();
      setStatus(`Exported ${a.download}.`);
    } catch (err) {
      setStatus(`Export failed: ${err?.message || err}`, true);
    } finally {
      exportBtn.disabled = false;
    }
  });

  const fileInput = document.createElement("input");
  fileInput.type = "file";
  fileInput.accept = ".json,application/json";
  fileInput.hidden = true;

  const importBtn = makeBackupButton("Import data…", () => fileInput.click());

  fileInput.addEventListener("change", async () => {
    const file = fileInput.files?.[0];
    fileInput.value = ""; // so the same file can be re-picked later
    if (!file) return;
    clearConfirm();

    let parsed;
    try {
      parsed = parseBackupFile(await file.text());
    } catch (_) {
      parsed = { error: "Could not read the file." };
    }
    if (parsed.error) {
      setStatus(parsed.error, true);
      return;
    }

    // Confirm step: nothing is written until the user applies.
    pendingData = parsed.data;
    setStatus(`"${file.name}" contains:`);

    const list = document.createElement("ul");
    for (const line of summarizeBackup(parsed.data)) {
      const li = document.createElement("li");
      li.textContent = line;
      list.appendChild(li);
    }

    const applyBtn = makeBackupButton("Import", async () => {
      const data = pendingData;
      clearConfirm();
      if (!data) return;
      setStatus("Importing…");
      try {
        const results = await applyBackup(data);
        setStatus(results);
        // The import may have replaced be_settings behind this page's back.
        chrome.storage.sync.get(SETTINGS_KEY, (o) => {
          settings = normalize(o?.[SETTINGS_KEY]);
          renderToggles();
        });
      } catch (err) {
        setStatus(`Import failed: ${err?.message || err}`, true);
      }
    });
    applyBtn.classList.add("be-backup-primary");

    const cancelBtn = makeBackupButton("Cancel", () => {
      clearConfirm();
      setStatus("Import cancelled. Nothing was changed.");
    });

    const confirmActions = document.createElement("div");
    confirmActions.className = "be-backup-actions";
    confirmActions.append(applyBtn, cancelBtn);
    confirmBox.replaceChildren(list, confirmActions);
    confirmBox.hidden = false;
  });

  actions.append(exportBtn, importBtn, fileInput);
  host.replaceChildren(actions, confirmBox, status);
}

function render() {
  renderToggles();
  renderVersionBanner();
  renderBackupSection();

  const openOptions = document.getElementById("be-open-options");
  if (openOptions) {
    openOptions.addEventListener("click", () => chrome.runtime.openOptionsPage());
  }
}

chrome.storage.sync.get(SETTINGS_KEY, (o) => {
  settings = normalize(o?.[SETTINGS_KEY]);
  render();
});
