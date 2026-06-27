// boss.js
// Boss-event tracker: state, render, drag-to-reposition, background refresh,
// settings (manual high editing), and near-high toast notification.
// Persistent state key: be_boss_state in chrome.storage.local.
// New-event detection keys off Event.UUID.

const BOSS_KEY = "be_boss_state";
const BOSS_UI_KEY = "be_boss_ui_state";
const BOSS_PROGRESS_URL = "https://api.boot.dev/v1/boss_events_progress";
const BOSS_REFRESH_MS = 30_000;
const NEAR_HIGH_THRESHOLD = 0.95; // notify when current >= 95% of event high

let bossRefreshTimer = null;
let bossUiState = { minimized: false, settingsOpen: false, x: null, y: null };
let bossUiLoaded = false;
let bossAuthUnavailableUntil = 0;

function clearBossRefreshTimer() {
  if (!bossRefreshTimer) return;
  clearInterval(bossRefreshTimer);
  bossRefreshTimer = null;
}

function resetBossRefreshTimer(fetchNow = false) {
  clearBossRefreshTimer();
  if (Date.now() < bossAuthUnavailableUntil) return;
  if (fetchNow) {
    setTrackedTimeout(requestBossProgress, 1200);
  }
  bossRefreshTimer = setTrackedInterval(requestBossProgress, BOSS_REFRESH_MS);
}

function requestBossProgress() {
  if (Date.now() < bossAuthUnavailableUntil) {
    clearBossRefreshTimer();
    return;
  }
  requestApiJson(BOSS_PROGRESS_URL);
}

async function restoreBossPanel() {
  const stored = (await chromeGet(BOSS_KEY)) || {};
  if (enhancerStopped) return;
  if (stored.state) renderBossPanel(stored.state);
}

// ===========================================================================
// FEATURE 5: Boss-event tracker
// ===========================================================================
async function handleBossProgress(json) {
  const rewards = getBossRewards(json);
  const cur = {
    eventId: json?.Event?.UUID ?? json?.Event?.StartsAt ?? "unknown-event",
    bonusPct: pct(json?.XPBonus),
    damage: num(json?.XPTotal),
    nextChestAt: getNextChestAt(rewards),
    bossMaxHp: num(json?.Event?.HealthPoints),
    lastChestTier: getLastChestTier(rewards),
    nextChestTier: getNextChestTier(rewards),
  };

  const stored = (await chromeGet(BOSS_KEY)) || {};
  if (enhancerStopped) return;
  let state = stored.state || newEventState(cur.eventId);

  // Auto-detect a new event. Event stats reset, all-time high persists.
  if (state.eventId !== cur.eventId) {
    const allTimeHigh = Math.max(state.allTimeHigh || 0, cur.bonusPct || 0);
    state = newEventState(cur.eventId);
    state.allTimeHigh = allTimeHigh; // all-time high persists across events
  }

  // Update rolling event stats.
  if (cur.bonusPct != null) {
    state.current = cur.bonusPct;
    state.eventHigh = Math.max(state.eventHigh || 0, cur.bonusPct);
    state.allTimeHigh = Math.max(state.allTimeHigh || 0, cur.bonusPct);
  }
  if (cur.damage != null) state.damage = cur.damage;
  if (cur.nextChestAt != null) state.nextChestAt = cur.nextChestAt;
  if (cur.bossMaxHp != null) state.bossMaxHp = cur.bossMaxHp;
  state.lastChestTier = cur.lastChestTier;
  state.nextChestTier = cur.nextChestTier;
  state.updatedAt = Date.now();

  await chromeSet(BOSS_KEY, { state });
  if (enhancerStopped) return;
  renderBossPanel(state);
  maybeNotifyNearHigh(state);
}

function newEventState(eventId) {
  return {
    eventId,
    current: 0,
    eventHigh: 0,
    allTimeHigh: 0,
    damage: 0,
    nextChestAt: 0,
    bossMaxHp: 0,
    lastChestTier: null,
    nextChestTier: null,
    notifiedHigh: 0, // event-high value we last notified about (dedupe)
    updatedAt: Date.now(),
  };
}

async function renderBossPanel(s) {
  await loadBossUiState();
  if (enhancerStopped) return;
  waitFor(() => document.body).then(() => {
    if (enhancerStopped) return;
    let panel = document.getElementById("be-boss-panel");
    if (!panel) {
      panel = document.createElement("div");
      panel.id = "be-boss-panel";
      document.body.appendChild(panel);
    }
    panel.className = `be-boss-panel${bossUiState.minimized ? " be-boss-minimized" : ""}${
      hasSavedBossPosition() ? " be-positioned" : ""
    }`;
    applyBossPanelPosition(panel);

    if (bossUiState.minimized) {
      panel.innerHTML = `
        <div class="be-boss-head be-boss-drag-handle">
          <span class="be-boss-min-title">Boss Event - Current Aura: ${fmtPct(s.current)}</span>
          <div class="be-boss-actions">
            <button id="be-boss-settings-toggle" type="button" title="Open boss settings" aria-label="Open boss settings" aria-expanded="${bossUiState.settingsOpen ? "true" : "false"}">&#9881;</button>
            <button id="be-boss-toggle" type="button" title="Expand boss event" aria-label="Expand boss event">+</button>
          </div>
        </div>`;
      applyBossPanelPosition(panel);
      bindBossPanelControls(panel, s);
      return;
    }

    const deltaToHigh =
      s.eventHigh > 0 ? Math.max(0, s.eventHigh - s.current).toFixed(0) : "0";
    const toNextChest =
      s.nextChestAt > 0 ? Math.max(0, s.nextChestAt - s.damage) : "?";
    const toDefeat =
      s.bossMaxHp > 0 ? Math.max(0, s.bossMaxHp - s.damage) : "?";
    const nextChestProgress = getProgressPct(s.damage, s.nextChestAt);
    const bossProgress = getProgressPct(s.damage, s.bossMaxHp);
    const lastUpdated = s.updatedAt ? new Date(s.updatedAt).toLocaleTimeString([], { hour: "numeric", minute: "2-digit" }) : "unknown";
    const settingsMarkup = bossUiState.settingsOpen
      ? `<div class="be-boss-settings-panel">
          <div class="be-boss-manual">
            <label>
              <span>Event high %</span>
              <input id="be-boss-event-high" type="number" min="0" step="1" inputmode="numeric" value="${escapeHtml(Math.round(s.eventHigh || 0))}">
            </label>
            <label>
              <span>All-time high %</span>
              <input id="be-boss-alltime-high" type="number" min="0" step="1" inputmode="numeric" value="${escapeHtml(Math.round(s.allTimeHigh || 0))}">
            </label>
            <div class="be-boss-manual-actions">
              <button id="be-boss-save-highs" type="button">Save highs</button>
              <button id="be-boss-refresh" type="button">Refresh</button>
              <button id="be-boss-reset" class="be-boss-reset-button" type="button" title="Reset stats for this event">Reset</button>
            </div>
          </div>
        </div>`
      : "";

    panel.innerHTML = `
      <div class="be-boss-head be-boss-drag-handle">
        <span>Boss Event</span>
        <div class="be-boss-actions">
          <button id="be-boss-settings-toggle" type="button" aria-expanded="${bossUiState.settingsOpen ? "true" : "false"}" title="Boss high settings" aria-label="Boss high settings">&#9881;</button>
          <button id="be-boss-toggle" type="button" title="Minimize boss event" aria-label="Minimize boss event">-</button>
        </div>
      </div>
      <div class="be-boss-grid">
        <div><b>${fmtPct(s.current)}</b><span>Current aura</span></div>
        <div><b>${fmtPct(s.eventHigh)}</b><span>Event high</span></div>
        <div><b>${fmtPct(s.allTimeHigh)}</b><span>All-time high</span></div>
        <div><b>${deltaToHigh}%</b><span>Below event high</span></div>
        <div><b>${fmtNum(s.damage)}</b><span>Boss damage</span></div>
        <div><b>${fmtNum(toNextChest)}</b><span>To next chest</span></div>
        <div><b>${fmtNum(toDefeat)}</b><span>To defeat boss</span></div>
        <div><b>${escapeHtml(s.lastChestTier ?? "Start")} &rarr; ${escapeHtml(s.nextChestTier ?? "Complete")}</b><span>Chest tier</span></div>
      </div>
      <div class="be-boss-progress-list">
        ${renderBossProgress("Next chest", nextChestProgress)}
        ${renderBossProgress("Boss defeat", bossProgress)}
      </div>
      <div class="be-boss-meta">Last updated ${escapeHtml(lastUpdated)}</div>
      ${settingsMarkup}`;

    applyBossPanelPosition(panel);
    bindBossPanelControls(panel, s);
  });
}

function bindBossPanelControls(panel, state) {
  bindBossDrag(panel);

  const toggle = panel.querySelector("#be-boss-toggle");
  if (toggle) {
    toggle.onclick = async () => {
      await saveBossUiState({ minimized: !bossUiState.minimized });
      renderBossPanel(state);
    };
  }

  const reset = panel.querySelector("#be-boss-reset");
  if (reset) {
    reset.onclick = async () => {
      const fresh = newEventState(state.eventId);
      fresh.allTimeHigh = state.allTimeHigh; // keep the all-time record
      await chromeSet(BOSS_KEY, { state: fresh });
      renderBossPanel(fresh);
    };
  }

  const settingsToggle = panel.querySelector("#be-boss-settings-toggle");
  if (settingsToggle) {
    settingsToggle.onclick = async () => {
      await saveBossUiState({ settingsOpen: !bossUiState.settingsOpen, minimized: false });
      renderBossPanel(state);
    };
  }

  const refresh = panel.querySelector("#be-boss-refresh");
  if (refresh) {
    refresh.onclick = () => requestBossProgress();
  }

  const saveHighs = panel.querySelector("#be-boss-save-highs");
  if (saveHighs) {
    saveHighs.onclick = async () => {
      const eventHigh = num(panel.querySelector("#be-boss-event-high")?.value);
      const allTimeHigh = num(panel.querySelector("#be-boss-alltime-high")?.value);
      const next = { ...state };

      if (eventHigh != null) next.eventHigh = Math.max(0, eventHigh);
      if (allTimeHigh != null) next.allTimeHigh = Math.max(0, allTimeHigh);
      if ((next.eventHigh || 0) > (next.allTimeHigh || 0)) {
        next.allTimeHigh = next.eventHigh;
      }
      next.notifiedHigh = 0;
      next.updatedAt = Date.now();

      await chromeSet(BOSS_KEY, { state: next });
      renderBossPanel(next);
    };
  }
}

function getProgressPct(value, total) {
  const current = num(value);
  const max = num(total);
  if (current == null || max == null || max <= 0) return null;
  return clamp((current / max) * 100, 0, 100);
}

function renderBossProgress(label, pctValue) {
  const pctText = pctValue == null ? "?" : `${Math.round(pctValue)}%`;
  const width = pctValue == null ? 0 : pctValue;
  return `<div class="be-boss-progress">
    <div class="be-boss-progress-label"><span>${escapeHtml(label)}</span><b>${escapeHtml(pctText)}</b></div>
    <div class="be-boss-progress-track" role="progressbar" aria-label="${escapeHtml(label)}" aria-valuemin="0" aria-valuemax="100" aria-valuenow="${escapeHtml(pctValue == null ? 0 : Math.round(pctValue))}">
      <span style="width: ${escapeHtml(width)}%"></span>
    </div>
  </div>`;
}

function bindBossDrag(panel) {
  const handle = panel.querySelector(".be-boss-drag-handle");
  if (!handle) return;

  handle.onpointerdown = (event) => {
    if (event.target.closest("button,a,input,select,textarea")) return;
    event.preventDefault();

    const rect = panel.getBoundingClientRect();
    const offsetX = event.clientX - rect.left;
    const offsetY = event.clientY - rect.top;
    let nextX = rect.left;
    let nextY = rect.top;

    panel.classList.add("be-positioned", "be-dragging");
    panel.style.right = "auto";
    panel.style.bottom = "auto";
    document.body.classList.add("be-boss-drag-active");

    const move = (moveEvent) => {
      nextX = clamp(moveEvent.clientX - offsetX, 8, window.innerWidth - panel.offsetWidth - 8);
      nextY = clamp(moveEvent.clientY - offsetY, 8, window.innerHeight - panel.offsetHeight - 8);
      panel.style.left = `${nextX}px`;
      panel.style.top = `${nextY}px`;
    };

    const up = async () => {
      document.removeEventListener("pointermove", move);
      document.removeEventListener("pointerup", up);
      panel.classList.remove("be-dragging");
      document.body.classList.remove("be-boss-drag-active");
      await saveBossUiState({ x: Math.round(nextX), y: Math.round(nextY) });
    };

    document.addEventListener("pointermove", move);
    document.addEventListener("pointerup", up, { once: true });
  };
}

function maybeNotifyNearHigh(s) {
  if (!s.eventHigh) return;
  const ratio = s.current / s.eventHigh;
  // Only fire when we're near the high AND haven't already notified for
  // this particular high value (avoid spamming on every poll).
  if (ratio >= NEAR_HIGH_THRESHOLD && s.notifiedHigh !== s.eventHigh) {
    toast(`Boots Aura at ${fmtPct(s.current)}: near event high (${fmtPct(s.eventHigh)}). Good time to submit.`);
    s.notifiedHigh = s.eventHigh;
    chromeSet(BOSS_KEY, { state: s });
  }
}

async function loadBossUiState() {
  if (bossUiLoaded) return;
  const stored = (await chromeGet(BOSS_UI_KEY)) || {};
  if (enhancerStopped) return;
  bossUiState = {
    minimized: Boolean(stored.minimized),
    settingsOpen: Boolean(stored.settingsOpen),
    x: Number.isFinite(Number(stored.x)) ? Number(stored.x) : null,
    y: Number.isFinite(Number(stored.y)) ? Number(stored.y) : null,
  };
  bossUiLoaded = true;
}

async function saveBossUiState(patch) {
  bossUiState = { ...bossUiState, ...patch };
  await chromeSet(BOSS_UI_KEY, bossUiState);
}

function applyBossPanelPosition(panel) {
  if (hasSavedBossPosition()) {
    const panelWidth = panel.offsetWidth || 320;
    const panelHeight = panel.offsetHeight || 120;
    const x = clamp(bossUiState.x, 8, window.innerWidth - panelWidth - 8);
    const y = clamp(bossUiState.y, 8, window.innerHeight - panelHeight - 8);
    panel.style.left = `${x}px`;
    panel.style.top = `${y}px`;
    panel.style.right = "auto";
    panel.style.bottom = "auto";
  } else {
    panel.style.left = "";
    panel.style.top = "";
    panel.style.right = "";
    panel.style.bottom = "";
  }
}

function hasSavedBossPosition() {
  return Number.isFinite(Number(bossUiState.x)) && Number.isFinite(Number(bossUiState.y));
}

function getBossRewards(json) {
  const rewards = Array.isArray(json?.Rewards) ? json.Rewards : [];
  return rewards
    .slice()
    .sort((a, b) => num(a.XPThreshold) - num(b.XPThreshold));
}

function getNextChestAt(rewards) {
  const reward = rewards.find((r) => !r.IsUnlocked);
  return reward ? num(reward.XPThreshold) : null;
}

function getLastChestTier(rewards) {
  const unlocked = rewards.filter((r) => r.IsUnlocked && r.IsUnlockedByUser);
  const reward = unlocked[unlocked.length - 1];
  return reward ? chestTier(rewards.indexOf(reward)) : null;
}

function getNextChestTier(rewards) {
  const reward = rewards.find((r) => !r.IsUnlocked);
  return reward ? chestTier(rewards.indexOf(reward)) : null;
}

function chestTier(index) {
  // The reward payload has ChestUUIDs but no tier names; the modal renders
  // these thresholds in this order in the captured boss page.
  return ["Common", "Uncommon", "Rare", "Mythic"][index] ?? `Tier ${index + 1}`;
}
