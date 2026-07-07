// boss.js
// Boss-event tracker: state, render, drag-to-reposition, background refresh,
// settings (manual high editing), and near-high toast notification.
// Persistent state key: be_boss_state in chrome.storage.local.
// New-event detection keys off Event.UUID.
// Also owns the boss-event reminder: with the tracker hidden (its default),
// a live event surfaces as a small action toast instead of the panel.

const BOSS_KEY = "be_boss_state";
const BOSS_UI_KEY = "be_boss_ui_state";
const BOSS_REMINDER_KEY = "be_boss_reminder_state";
const BOSS_REMINDER_DEBUG_KEY = "be_boss_reminder_debug";
const BOSS_PROGRESS_URL = "https://api.boot.dev/v1/boss_events_progress";
const BOSS_REFRESH_MS = 120_000; // boss data changes slowly; poll every 2 min
const NEAR_HIGH_THRESHOLD = 0.95; // notify when current >= 95% of event high
const BOSS_REMINDER_REPEAT_MS = 24 * 60 * 60 * 1000; // re-remind at most daily
const BOSS_REMINDER_TOAST_MS = 20_000; // action toast needs longer than the default 6s

let bossRefreshTimer = null;
let bossUiState = { minimized: false, settingsOpen: false, x: null, y: null };
let bossUiLoaded = false;
let bossAuthUnavailableUntil = 0;
// Whether the last response described an active event. null = unknown (poll to
// find out); false = between events, so routine polls are skipped until a forced
// re-check (navigation / manual Refresh) or boot.dev's own fetch shows a new one.
let bossEventActive = null;
let bossInactiveNotified = false; // dedupe the "no active event" toast per session
// Authoritative in-memory copy of the persisted boss state. chrome.storage is a
// write-through cache; reading from memory avoids the read-modify-write race
// between the refresh interval, the manual Refresh button, and near-high notify.
let bossState = null;
// Reminder bookkeeping ({ eventId, lastShownAt, dismissed }), one record for the
// most-recently-seen event; a different eventId starts fresh. In-memory copy of
// be_boss_reminder_state, same write-through pattern as bossState.
let bossReminderState = null;
let bossReminderLoaded = false;
let bossReminderCheckInFlight = false; // burst of relayed responses → one check
let bossReminderToastClose = null; // close() of the visible reminder toast, if any

function clearBossRefreshTimer() {
  if (!bossRefreshTimer) return;
  clearInterval(bossRefreshTimer);
  bossRefreshTimer = null;
}

function removeBossPanel() {
  document.getElementById("be-boss-panel")?.remove();
}

// Owned here so all boss auth-state mutation and timer control stays in boss.js
// rather than being reached into from content.js.
function markBossAuthUnavailable(durationMs, retry = false) {
  bossAuthUnavailableUntil = Date.now() + durationMs;
  clearBossRefreshTimer();
  if (retry) setTrackedTimeout(() => resetBossRefreshTimer(true), durationMs);
}

function resetBossRefreshTimer(fetchNow = false) {
  clearBossRefreshTimer();
  if (!isFeatureEnabled("bossTracker")) return;
  if (Date.now() < bossAuthUnavailableUntil) return;
  if (fetchNow) {
    // A forced re-check: confirms whether an event is running even between events.
    setTrackedTimeout(() => requestBossProgress(true), 1200);
  }
  bossRefreshTimer = setTrackedInterval(requestBossProgress, BOSS_REFRESH_MS);
}

// Start (or keep) the poll interval for an active event, without an immediate
// fetch — used after a response reveals a newly-active event so polling resumes.
function ensureBossPollingActive() {
  if (bossRefreshTimer) return;
  if (!isFeatureEnabled("bossTracker")) return;
  if (Date.now() < bossAuthUnavailableUntil) return;
  bossRefreshTimer = setTrackedInterval(requestBossProgress, BOSS_REFRESH_MS);
}

function requestBossProgress(force = false) {
  if (!isFeatureEnabled("bossTracker")) {
    clearBossRefreshTimer();
    return;
  }
  if (Date.now() < bossAuthUnavailableUntil) {
    clearBossRefreshTimer();
    return;
  }
  // Don't poll while the tab is hidden; the next visible tick will refresh.
  if (document.hidden) return;
  // Between events (known inactive), only forced re-checks (navigation, manual
  // Refresh, tab focus) fetch — routine ticks stay quiet so downtime is near-zero
  // standing load until a new event begins.
  if (!force && bossEventActive === false) return;
  requestApiJson(BOSS_PROGRESS_URL);
}

async function restoreBossPanel() {
  if (!isFeatureEnabled("bossTracker")) {
    removeBossPanel();
    return;
  }
  const stored = (await chromeGet(BOSS_KEY)) || {};
  if (enhancerStopped) return;
  bossState = stored.state || null;
  if (bossState) renderBossPanel(bossState);
}

// ===========================================================================
// FEATURE 5: Boss-event tracker
// ===========================================================================
async function handleBossProgress(json) {
  if (!isFeatureEnabled("bossTracker")) {
    // Quiet mode: never touch be_boss_state (previous-event stats stay intact
    // for whenever the tracker is re-enabled); at most offer the tracker via
    // the reminder toast. Detection here is passive-only — these responses come
    // from boot.dev's own fetches relayed by injected.js.
    await maybeShowBossReminder(json);
    return;
  }
  const active = isBossEventActive(json);
  bossEventActive = active;
  const rewards = getBossRewards(json);
  const cur = {
    eventId: json?.Event?.UUID ?? json?.Event?.StartsAt ?? "unknown-event",
    bonusPct: pct(json?.XPBonus),
    damage: num(json?.XPTotal),
    nextChestAt: getNextChestAt(rewards),
    bossMaxHp: num(json?.Event?.HealthPoints),
    lastChestTier: getLastChestTier(rewards),
    nextChestTier: getNextChestTier(rewards),
    expiresAt: getEventExpiry(json),
  };

  let state = bossState || newEventState(cur.eventId);

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
  state.eventActive = active;
  state.expiresAt = cur.expiresAt;
  state.updatedAt = Date.now();

  if (active) {
    // A live event: keep polling and watch for the near-high moment.
    bossInactiveNotified = false;
    ensureBossPollingActive();
  } else {
    // Between events: stop the standing poll and say so once.
    clearBossRefreshTimer();
    notifyBossInactiveOnce();
  }

  bossState = state;
  await chromeSet(BOSS_KEY, { state });
  if (enhancerStopped) return;
  renderBossPanel(state);
  if (active) maybeNotifyNearHigh(state);
}

// An event is active until its ExpiresAt passes. Missing/unparseable expiry is
// treated as active so a schema change never wrongly hides a running event.
function getEventExpiry(json) {
  const raw = json?.Event?.ExpiresAt;
  const t = raw ? Date.parse(raw) : NaN;
  return Number.isFinite(t) ? t : null;
}

function isBossEventActive(json) {
  const expiry = getEventExpiry(json);
  if (expiry == null) return true;
  return Date.now() < expiry;
}

function notifyBossInactiveOnce() {
  if (bossInactiveNotified) return;
  bossInactiveNotified = true;
  toast("No active boss event right now. The tracker will resume when the next event starts.");
}

// ---------------------------------------------------------------------------
// Boss-event reminder (tracker hidden, event live → small opt-in toast)
// ---------------------------------------------------------------------------

// Shown at most once per BOSS_REMINDER_REPEAT_MS per event, and never again for
// an event once either toast button was clicked. "Show Tracker" flips the
// bossTracker setting; the existing storage.onChanged live-apply then renders
// the panel and restarts polling — no extra wiring here.
async function maybeShowBossReminder(json) {
  if (isFeatureEnabled("bossTracker")) return; // reminder only backs up a hidden tracker
  if (!isFeatureEnabled("bossReminders")) return;
  if (bossReminderToastClose || bossReminderCheckInFlight) return;
  if (!isBossEventActive(json)) return;
  const eventId = json?.Event?.UUID ?? json?.Event?.StartsAt ?? "unknown-event";

  bossReminderCheckInFlight = true;
  try {
    await loadBossReminderState();
    if (enhancerStopped) return;
    const rec = bossReminderState;
    if (rec && rec.eventId === eventId) {
      if (rec.dismissed) return; // user already acted on this event's reminder
      if (rec.lastShownAt && Date.now() - rec.lastShownAt < BOSS_REMINDER_REPEAT_MS) return;
    }

    bossReminderState = { eventId, lastShownAt: Date.now(), dismissed: false };
    await saveBossReminderState();
    await waitFor(() => document.body);
    if (enhancerStopped) return;
    // Settings may have flipped while we awaited storage/DOM.
    if (isFeatureEnabled("bossTracker") || !isFeatureEnabled("bossReminders")) return;

    bossReminderToastClose = toast("Boss event is live. Show Boss Tracker?", {
      durationMs: BOSS_REMINDER_TOAST_MS,
      actions: [
        {
          label: "Show Tracker",
          primary: true,
          onClick: () => acknowledgeBossReminder(eventId, true),
        },
        {
          label: "Don't remind me for this event",
          onClick: () => acknowledgeBossReminder(eventId, false),
        },
      ],
    });
    // The toast dismisses itself; drop our handle shortly after so a stale
    // reference can't block a later event's reminder within this session. Only
    // clear if it's still this toast's handle — a click may already have
    // cleared it and a newer toast may own the slot by then.
    const shownToastClose = bossReminderToastClose;
    setTrackedTimeout(() => {
      if (bossReminderToastClose === shownToastClose) bossReminderToastClose = null;
    }, BOSS_REMINDER_TOAST_MS + 1000);
  } finally {
    bossReminderCheckInFlight = false;
  }
}

// Either button means "handled for this event" — including Show Tracker, so
// turning the tracker back off mid-event doesn't resume the reminders.
function acknowledgeBossReminder(eventId, showTracker) {
  bossReminderToastClose = null; // the toast closes itself after an action click
  bossReminderState = { eventId, lastShownAt: Date.now(), dismissed: true };
  saveBossReminderState().catch((err) => handleAsyncError(err, "bossReminder"));
  if (showTracker) {
    setFeatureEnabled("bossTracker", true).catch((err) => handleAsyncError(err, "bossReminder"));
  }
}

function removeBossReminderToast() {
  if (!bossReminderToastClose) return;
  bossReminderToastClose();
  bossReminderToastClose = null;
}

async function loadBossReminderState() {
  if (bossReminderLoaded) return;
  const stored = await chromeGet(BOSS_REMINDER_KEY);
  if (enhancerStopped) return;
  bossReminderState = isPlainObject(stored)
    ? {
        eventId: stored.eventId ?? null,
        lastShownAt: num(stored.lastShownAt),
        dismissed: Boolean(stored.dismissed),
      }
    : null;
  bossReminderLoaded = true;
}

async function saveBossReminderState() {
  await chromeSet(BOSS_REMINDER_KEY, bossReminderState);
}

// Maintainer-only: boss events run 4–8 weeks apart, so the reminder flow needs a
// trigger between events. Set be_boss_reminder_debug to true in
// chrome.storage.local and reload boot.dev; a synthetic active event is fed
// through the REAL maybeShowBossReminder, so every production guard applies
// (reminders on, tracker off, daily window, dismissal record). Re-run a test by
// removing be_boss_reminder_state. Does nothing unless the flag is set, so
// ordinary users never see it.
async function maybeTriggerBossReminderDebug() {
  const flag = await chromeGet(BOSS_REMINDER_DEBUG_KEY);
  if (flag !== true || enhancerStopped) return;
  await maybeShowBossReminder({
    Event: {
      UUID: "be-debug-event",
      ExpiresAt: new Date(Date.now() + 60 * 60 * 1000).toISOString(),
    },
  });
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
  if (!isFeatureEnabled("bossTracker")) {
    removeBossPanel();
    return;
  }
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

    const belowEventHigh =
      s.eventHigh > 0 ? Math.max(0, s.eventHigh - s.current).toFixed(0) : "0";
    const toNextChest =
      s.nextChestAt > 0 ? Math.max(0, s.nextChestAt - s.damage) : "?";
    const toDefeat =
      s.bossMaxHp > 0 ? Math.max(0, s.bossMaxHp - s.damage) : "?";
    const nextChestProgress = getProgressPct(s.damage, s.nextChestAt);
    const bossProgress = getProgressPct(s.damage, s.bossMaxHp);
    const lastUpdated = s.updatedAt ? new Date(s.updatedAt).toLocaleTimeString([], { hour: "numeric", minute: "2-digit" }) : "unknown";
    const metaText = s.eventActive === false
      ? (s.expiresAt
          ? `No active event — ended ${new Date(s.expiresAt).toLocaleString([], { month: "short", day: "numeric", hour: "numeric", minute: "2-digit" })}`
          : "No active event")
      : `Last updated ${lastUpdated}`;
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
        <div><b>${belowEventHigh}%</b><span>Below event high</span></div>
        <div><b>${fmtNum(s.damage)}</b><span>Boss damage</span></div>
        <div><b>${fmtNum(toNextChest)}</b><span>To next chest</span></div>
        <div><b>${fmtNum(toDefeat)}</b><span>To defeat boss</span></div>
        <div><b>${escapeHtml(s.lastChestTier ?? "Start")} &rarr; ${escapeHtml(s.nextChestTier ?? "Complete")}</b><span>Chest tier</span></div>
      </div>
      <div class="be-boss-progress-list">
        ${renderBossProgress("Next chest", nextChestProgress)}
        ${renderBossProgress("Boss defeat", bossProgress)}
      </div>
      <div class="be-boss-meta">${escapeHtml(metaText)}</div>
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
      bossState = fresh;
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
    // A manual refresh is a forced re-check, even between events.
    refresh.onclick = () => requestBossProgress(true);
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

      bossState = next;
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
