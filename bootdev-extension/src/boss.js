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
const BOSS_DEBUG_RESPONSE_KEY = "be_boss_debug_response";
const BOSS_PROGRESS_URL = "https://api.boot.dev/v1/boss_events_progress";
const BOSS_REFRESH_MS = 120_000; // boss data changes slowly; poll every 2 min
// --- aura statistics and alert tiers ---------------------------------------
// The old single alert fired at 95% of the event high, which is unreachable
// once that high is 100% — exactly what happened to the 2026-08 event, whose
// opening surge hit 100% and then sat near 32% for a week. These four tiers
// replace it, and they need to know what is NORMAL for the event, which is
// what the statistics below measure.
const AURA_SAMPLE_CAP_MS = 5 * 60_000; // one interval contributes at most this much observed time
const AURA_MEAN_MIN_MS = 30 * 60_000; // below this, an average is noise
const AURA_CHANGES_MAX = 500; // ~7 days of 30-min steps; the mean is unaffected by this cap
const AURA_CHANGE_MIN_DELTA = 1; // points; the aura is a step function, so only steps are logged

const AURA_ALERT_MIN_DELTA = 1; // points above the previous high before it counts as a new one
const AURA_ALERT_NEAR_RATIO = 0.8; // "near the event high" starts here
const AURA_ALERT_FLOOR_DEFAULT = 50; // below this, a bonus is not worth interrupting for
const AURA_ALERT_ABOVE_AVG_DELTA = 10; // points above this event's average
const AURA_ALERT_COOLDOWN_MS = {
  record: 10 * 60_000,
  high: 10 * 60_000,
  near: 60 * 60_000,
  above: 120 * 60_000,
};
// After a higher tier fires, stay quiet on the lower ones for a while: a climb
// should not produce a record toast chased by a near-high toast.
const AURA_ALERT_LOWER_SUPPRESS_MS = 15 * 60_000;
// How long the panel keeps showing the last alert. Long enough to still be
// there when you look up from an editor; short enough that it never becomes
// furniture. Dismissable at any time.
const BOSS_ALERT_NOTE_MAX_AGE_MS = 3 * 60 * 60_000;
const AURA_ALERT_RANK = { record: 4, high: 3, near: 2, above: 1 };
const BOSS_REMINDER_REPEAT_MS = 24 * 60 * 60 * 1000; // re-remind at most daily
const BOSS_REMINDER_TOAST_MS = 20_000; // action toast needs longer than the default 6s
const BOSS_INACTIVE_NOTICE_KEY = "be_boss_inactive_notice";
const BOSS_INACTIVE_REPEAT_MS = 24 * 60 * 60 * 1000; // "no active event" toast at most daily
// Boot.dev visual asset used with permission (see ATTRIBUTION.md). Resolved
// through the extension rather than referenced relatively from styles.css: a
// relative url() in the content-script stylesheet resolved against the DOCUMENT
// (measured 2026-08-14: background-image was
// https://www.boot.dev/assets/maptexture2.webp, which 404s), so the panel had
// been rendering with no texture at all. Same pattern as ROLE_FRAME_URLS.
const BOSS_TEXTURE_URL = chrome.runtime.getURL("assets/maptexture2.webp");
let bossRefreshTimer = null;
let bossUiState = { minimized: false, settingsOpen: false, x: null, y: null };
let bossUiLoaded = false;
let bossAuthUnavailableUntil = 0;
// Whether the last response described an active event. null = unknown (poll to
// find out); false = between events, so routine polls are skipped until a forced
// re-check (navigation / manual Refresh) or Boot.dev's own fetch shows a new one.
let bossEventActive = null;
// Synchronous same-session guard for the "no active event" toast (a burst of
// responses must not double-toast); the real once-per-24h throttle is the
// persisted timestamp in be_boss_inactive_notice.
let bossInactiveNotified = false;
// Authoritative in-memory copy of the persisted boss state. chrome.storage is a
// write-through cache; reading from memory avoids the read-modify-write race
// between the refresh interval, the manual Refresh button, and near-high notify.
let bossState = null;
let bossStateLoaded = false;
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

// Loaded REGARDLESS of whether the tracker is enabled, and memoized. This is
// load-bearing: quiet mode writes be_boss_state (see handleBossProgress), and a
// write from a null in-memory copy would create a fresh record and destroy
// allTimeHigh. Pass force after an import, which changes storage behind us.
async function loadBossState({ force = false } = {}) {
  if (bossStateLoaded && !force) return bossState;
  const stored = (await chromeGet(BOSS_KEY)) || {};
  if (enhancerStopped) return bossState;
  bossState = migrateBossState(stored.state);
  bossStateLoaded = true;
  return bossState;
}

async function restoreBossPanel() {
  await loadBossState();
  if (!isFeatureEnabled("bossTracker")) {
    removeBossPanel();
    return;
  }
  if (enhancerStopped) return;
  if (bossState) renderBossPanel(bossState);
}

// ===========================================================================
// FEATURE 5: Boss-event tracker
// ===========================================================================
// This endpoint is mid-migration and the normalizer is load-bearing TODAY:
// the live-event capture (2026-06-26) is PascalCase, and between-events
// captures on 2026-07-16 AND 2026-07-31 are entirely camelCase (event.uuid,
// xpBonus, …), as is the live capture of the new event model (2026-08-14).
// See boss_events_progress_between_events.json in reference_data and the
// v0.12.2 audit bundle.
//
// Reads go through pickField (utils.js) per FIELD, never gated on the shape of
// the whole response — see the comment there for why a mixed response is the
// case that matters.
function normalizeBossProgressJson(json) {
  if (!isPlainObject(json)) return json;
  const event = pickField(json, "Event", "event");
  const rewards = pickField(json, "Rewards", "rewards");
  const guilds = pickField(json, "Guilds", "guilds");
  // Nothing boss-shaped to normalize (an error body, or an empty response):
  // hand it back untouched so hasBossEventIdentity can rule it inactive.
  if (!isPlainObject(event) && !Array.isArray(rewards)) return json;

  const boss = pickField(event, "Boss", "boss");
  return {
    ...json,
    Event: isPlainObject(event)
      ? {
          ...event,
          UUID: pickField(event, "UUID", "uuid"),
          StartsAt: pickField(event, "StartsAt", "startsAt"),
          ExpiresAt: pickField(event, "ExpiresAt", "expiresAt"),
          DefeatedAt: pickField(event, "DefeatedAt", "defeatedAt"),
          HealthPoints: pickField(event, "HealthPoints", "healthPoints"),
          Boss: isPlainObject(boss)
            ? { ...boss, UUID: pickField(boss, "UUID", "uuid"), Name: pickField(boss, "Name", "name") }
            : boss,
        }
      : event,
    XPBonus: pickField(json, "XPBonus", "xpBonus"),
    XPTotal: pickField(json, "XPTotal", "xpTotal"),
    XPUser: pickField(json, "XPUser", "xpUser"),
    NumLessonsCompletedHourly: pickField(json, "NumLessonsCompletedHourly", "numLessonsCompletedHourly"),
    Rewards: Array.isArray(rewards)
      ? rewards.map((r) => ({
          ...(isPlainObject(r) ? r : {}),
          UUID: pickField(r, "UUID", "uuid"),
          ChestUUID: pickField(r, "ChestUUID", "chestUUID"),
          XPThreshold: pickField(r, "XPThreshold", "xpThreshold"),
          UserXPThreshold: pickField(r, "UserXPThreshold", "userXPThreshold"),
          IsUnlocked: pickField(r, "IsUnlocked", "isUnlocked"),
          IsUnlockedByUser: pickField(r, "IsUnlockedByUser", "isUnlockedByUser"),
        }))
      : rewards,
    // Guild progress arrived with the 2026-08-14 event redesign, in this same
    // response — there is no guild endpoint (eleven guessed names 404'd).
    Guilds: Array.isArray(guilds)
      ? guilds.map((g) => ({
          ...(isPlainObject(g) ? g : {}),
          GuildUUID: pickField(g, "GuildUUID", "guildUUID"),
          Name: pickField(g, "Name", "name"),
          Handle: pickField(g, "Handle", "handle"),
          MemberCount: pickField(g, "MemberCount", "memberCount"),
          ContributorCount: pickField(g, "ContributorCount", "contributorCount"),
          XP: pickField(g, "XP", "xp"),
          XPThreshold: pickField(g, "XPThreshold", "xpThreshold"),
          IsCompleted: pickField(g, "IsCompleted", "isCompleted"),
        }))
      : guilds,
    GuildRewardGranted: pickField(json, "GuildRewardGranted", "guildRewardGranted"),
  };
}

async function handleBossProgress(json) {
  json = normalizeBossProgressJson(json);
  // QUIET MODE (tracker off) still RECORDS, and shows nothing. Catalyst issues
  // zero boss requests while the tracker is off — requestBossProgress refuses —
  // so everything handled here came from Boot.dev's own traffic, relayed by
  // injected.js. Recording it is what makes switching the tracker on mid-event
  // show the history Catalyst could have had. (Before v0.14.0 quiet mode wrote
  // nothing at all, which is why an event that peaked at 100% was recorded as
  // 66%.) Only the UI is suppressed: no render, no toast, no timers.
  const visible = isFeatureEnabled("bossTracker");
  if (!visible) await maybeShowBossReminder(json);

  await loadBossState();
  if (enhancerStopped) return;

  const active = isBossEventActive(json);
  bossEventActive = active;

  // A response without a readable event must not fall through to the
  // new-event detection below — it would reset the stored per-event stats to
  // a synthetic "unknown-event". Mark things inactive and keep the last
  // event's stats for whenever the next one starts.
  if (!hasBossEventIdentity(json)) {
    if (visible) {
      clearBossRefreshTimer();
      await notifyBossInactiveOnce();
    }
    if (enhancerStopped || !bossState) return;
    bossState.eventActive = false;
    bossState.updatedAt = Date.now();
    await chromeSet(BOSS_KEY, { state: bossState });
    if (enhancerStopped || !visible) return;
    renderBossPanel(bossState);
    return;
  }

  reportBossFieldGaps(json);

  const now = Date.now();
  const eventId = json?.Event?.UUID ?? json?.Event?.StartsAt ?? "unknown-event";
  const bonusPct = pct(json?.XPBonus);
  const chests = getPersonalChestState(json);

  let state = bossState || newEventState(eventId);

  // Auto-detect a new event. Event stats reset, all-time high persists, and the
  // outgoing event is archived first — otherwise the moment a new event starts,
  // everything about the one just finished disappears.
  if (state.eventId !== eventId) {
    const archived = archivePreviousEvent(state);
    const allTimeHigh = Math.max(state.allTimeHigh || 0, bonusPct || 0);
    state = newEventState(eventId);
    state.allTimeHigh = allTimeHigh; // all-time high persists across events
    state.previousEvent = archived;
  }

  // Captured BEFORE the update: the alert tiers compare the new value against
  // the highs as they stood, otherwise every new high has already been absorbed
  // by the time it would be announced.
  const prevHighs = { eventHigh: state.eventHigh || 0, allTimeHigh: state.allTimeHigh || 0 };
  const auraChanged = bonusPct != null && bonusPct !== state.current;

  // Update rolling event stats.
  if (bonusPct != null) {
    state.current = bonusPct;
    if (bonusPct > (state.eventHigh || 0)) {
      state.eventHigh = bonusPct;
      state.eventHighAt = now; // when the high was observed; backup export/merge metadata
    }
    state.allTimeHigh = Math.max(state.allTimeHigh || 0, bonusPct);
    state.aura = updateAuraStats(state.aura, bonusPct, now);
  }

  const bossName = json?.Event?.Boss?.Name;
  if (typeof bossName === "string" && bossName) state.bossName = bossName;

  // Each field is written only when the response actually carries it, so a
  // partial response leaves a good value alone instead of zeroing it.
  const lessonsHourly = num(json?.NumLessonsCompletedHourly);
  if (lessonsHourly != null) state.lessonsHourly = lessonsHourly;

  if (chests) {
    state.xpUser = chests.xpUser;
    state.personalTarget = chests.target;
    state.chestsEarned = chests.earned;
    state.chestTotal = chests.total;
    state.nextThreshold = chests.nextThreshold;
    state.nextTier = chests.nextTier;
  }

  if (typeof json?.GuildRewardGranted === "boolean") {
    state.guildRewardGranted = json.GuildRewardGranted;
  }
  if (Array.isArray(json?.Guilds)) {
    const picked = selectBossGuild(json.Guilds, state.pinnedGuildId);
    state.guild = picked.guild;
    state.pinnedGuildId = picked.pinnedGuildId;
  }

  state.eventActive = active;
  state.expiresAt = getEventExpiry(json);
  state.updatedAt = now;

  if (visible) {
    if (active) {
      // A live event: keep polling and watch for the near-high moment.
      bossInactiveNotified = false;
      ensureBossPollingActive();
    } else {
      // Between events: stop the standing poll and say so (at most once a day).
      clearBossRefreshTimer();
      await notifyBossInactiveOnce();
    }
  }

  // Before the write, so the alert bookkeeping and the panel's alert line are
  // persisted with everything else rather than in a second round-trip.
  if (visible && active && auraChanged) maybeNotifyAura(state, prevHighs, now);

  bossState = state;
  await chromeSet(BOSS_KEY, { state });
  if (enhancerStopped || !visible) return;
  renderBossPanel(state);
}

// Boundary checks for the fields this feature depends on. Every block here
// degrades to "show less" when a value goes missing, which is exactly what
// makes a rename invisible (v0.12.1's lesson). These cost nothing on a healthy
// response and log once per session on a broken one. Note XPUser is checked for
// ABSENCE, not falsiness — 0 is a legitimate value that pickField preserves,
// and a fresh account genuinely has it.
function reportBossFieldGaps(json) {
  if (json?.XPUser === undefined) {
    warnOnce(
      "boss:xp-user",
      "boss_events_progress carried an event but no XPUser in either casing — " +
      "personal chest progress will render nothing. Boot.dev may have renamed it."
    );
  }
  reportUsableFields("boss rewards", json?.Rewards, "UserXPThreshold", (r) => r?.UserXPThreshold);
  // Only fires when guilds[] is present and non-empty: a user in no guild is
  // normal and must never warn.
  reportUsableFields("boss guilds", json?.Guilds, "XPThreshold", (g) => g?.XPThreshold);
}

// An event is active until its ExpiresAt passes. Missing/unparseable expiry on
// a response that clearly carries a real event is treated as active so a
// schema change never wrongly hides a running event.
function getEventExpiry(json) {
  const raw = json?.Event?.ExpiresAt;
  const t = raw ? Date.parse(raw) : NaN;
  return Number.isFinite(t) ? t : null;
}

// Does the response carry a readable event at all? A response whose event
// Catalyst cannot read (or that has none) must never count as "active" — the
// missing-expiry fail-open used to treat exactly that as a live event,
// producing phantom reminder toasts between events (root cause: the
// between-events response is camelCase, so the PascalCase reads all came back
// undefined; see normalizeBossProgressJson). Identity fields mirror the
// eventId fallback used by the tracker.
function hasBossEventIdentity(json) {
  return Boolean(json?.Event?.UUID || json?.Event?.StartsAt);
}

function isBossEventActive(json) {
  if (!hasBossEventIdentity(json)) return false;
  const expiry = getEventExpiry(json);
  if (expiry == null) return true;
  return Date.now() < expiry;
}

// Throttled to once per BOSS_INACTIVE_REPEAT_MS per device: every page load
// between events produces an inactive response (the init forced re-check), so
// a session-only guard would toast on every refresh.
async function notifyBossInactiveOnce() {
  if (bossInactiveNotified) return;
  bossInactiveNotified = true;
  const stored = await chromeGet(BOSS_INACTIVE_NOTICE_KEY);
  if (enhancerStopped) return;
  const notifiedAt = num(stored?.notifiedAt);
  if (notifiedAt && Date.now() - notifiedAt < BOSS_INACTIVE_REPEAT_MS) return;
  await chromeSet(BOSS_INACTIVE_NOTICE_KEY, { notifiedAt: Date.now() });
  if (enhancerStopped) return;
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

// Marks an event's reminder as handled. Reached from either toast button —
// including Show Tracker, so turning the tracker back off mid-event doesn't
// resume the reminders — and from the panel's close (×) button.
function acknowledgeBossReminder(eventId, showTracker) {
  bossReminderToastClose = null; // the toast closes itself after an action click
  bossReminderState = { eventId, lastShownAt: Date.now(), dismissed: true };
  bossReminderLoaded = true; // memory is now authoritative; don't let a pending load overwrite it
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
// chrome.storage.local and reload Boot.dev; a synthetic active event is fed
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

// be_boss_state as of v0.14.0. The community-era fields (damage, bossMaxHp,
// nextChestAt, lastChestTier, nextChestTier) are gone: they measured the goal
// Boot.dev retired on 2026-08-14, and a stored example read "82,949,113 damage
// of a 10,000 HP boss" once healthPoints changed meaning underneath them.
// Maintainer-only, and the only way to exercise the panel between events (they
// run 4-8 weeks apart). Put a captured /v1/boss_events_progress body in
// be_boss_debug_response (chrome.storage.local) and reload Boot.dev: it runs
// through the REAL handleBossProgress, so every production guard applies.
// Accepts probe 01d's wrapper ({ account, label, json }) or a bare body. An
// expired capture reads as inactive — edit expiresAt in the copy you store,
// never in the evidence file. Unset the key when done.
async function maybeReplayBossDebugResponse() {
  const stored = await chromeGet(BOSS_DEBUG_RESPONSE_KEY);
  if (!isPlainObject(stored) || enhancerStopped) return;
  const body = isPlainObject(stored.json) ? stored.json : stored;
  console.debug("[catalyst] replaying be_boss_debug_response through handleBossProgress");
  await handleBossProgress(body);
}

function newEventState(eventId) {
  return {
    eventId,
    bossName: null,
    // When Catalyst first saw THIS event. The recorded highs are only the
    // highest values OBSERVED, so the panel states the window they came from.
    // Never moved forward; null means "unknown" (a record migrated from an
    // older version cannot say, and inventing a window would be a lie).
    observedSince: Date.now(),
    current: 0,
    eventHigh: 0,
    eventHighAt: null, // when eventHigh was last raised (ms); backup export/merge metadata
    allTimeHigh: 0,
    // Personal fight: xpUser against the userXPThreshold ladder.
    xpUser: null,
    personalTarget: null,
    chestsEarned: null,
    chestTotal: null,
    nextThreshold: null,
    nextTier: null,
    lessonsHourly: null, // site-wide lessons this hour; the aura's leading indicator
    // Guild fight: the selected guild (see selectBossGuild) and its pin.
    guild: null,
    guildRewardGranted: null,
    pinnedGuildId: null,
    // Aura statistics for THIS event, and the alert bookkeeping that reads them.
    aura: newAuraStats(),
    alerts: null, // { tierLastAt, lastPct, lastTier, lastAt }
    lastAlert: null, // { tier, note, at } — the line the panel keeps on screen
    previousEvent: null, // summary of the event this one replaced (archivePreviousEvent)
    updatedAt: Date.now(),
  };
}

// A one-object summary of the event that just ended, written as the next one
// resets the record. Boss events are 4-8 weeks apart, so without this the
// question "how did I do last time?" becomes unanswerable the instant a new
// event begins. Only the parts that stay true are kept — a final result, an
// observed high and an observed average — never the live figures.
function archivePreviousEvent(state) {
  if (!isPlainObject(state) || !state.eventId) return null;
  const hasSomethingToSay = state.eventHigh > 0 || state.xpUser != null || isPlainObject(state.guild);
  if (!hasSomethingToSay) return null;

  const g = isPlainObject(state.guild) ? state.guild : null;
  return {
    eventId: state.eventId,
    bossName: state.bossName ?? null,
    endedAt: num(state.expiresAt) ?? num(state.updatedAt) ?? Date.now(),
    observedSince: num(state.observedSince),
    observedMs: num(state.aura?.observedMs) ?? 0,
    eventHigh: num(state.eventHigh) ?? 0,
    eventHighAt: num(state.eventHighAt),
    auraMean: auraMean(state.aura),
    xpUser: num(state.xpUser),
    chestsEarned: num(state.chestsEarned),
    chestTotal: num(state.chestTotal),
    defeated: num(state.chestTotal) > 0 && num(state.chestsEarned) >= num(state.chestTotal),
    guildRewardGranted: typeof state.guildRewardGranted === "boolean" ? state.guildRewardGranted : null,
    guild: g
      ? {
          name: g.name ?? "",
          xp: num(g.xp),
          xpThreshold: num(g.xpThreshold),
          isCompleted: g.isCompleted === true,
          contributorCount: num(g.contributorCount),
          memberCount: num(g.memberCount),
        }
      : null,
  };
}

// One line for the settings panel: the whole point of the archive is that it
// stays reachable once a new event is live and owns the rest of the panel.
function describePreviousEvent(previous) {
  if (!isPlainObject(previous)) return "";
  const bits = [];
  if (num(previous.chestTotal)) bits.push(`${num(previous.chestsEarned) ?? 0} of ${previous.chestTotal} chests`);
  if (previous.guildRewardGranted) bits.push("guild reward earned");
  if (num(previous.eventHigh)) bits.push(`high ${fmtPct(previous.eventHigh)}`);
  if (previous.auraMean != null) bits.push(`avg ${fmtPct(previous.auraMean)}`);
  if (!bits.length) return "";
  return `Last event${previous.bossName ? ` (${previous.bossName})` : ""}: ${bits.join(" · ")}`;
}

// Bring a stored record up to the v0.14.0 shape. The aura history carries
// forward — it still means exactly what it says — and the community-era fields
// are dropped rather than reinterpreted. observedSince is deliberately NOT
// backfilled: an older record cannot say when its window began, and the panel
// would rather admit that than claim one starting now.
function migrateBossState(stored) {
  if (!isPlainObject(stored)) return null;

  const eventId = typeof stored.eventId === "string" && stored.eventId ? stored.eventId : "unknown-event";
  const state = newEventState(eventId);
  const carryNum = (key, value, fallback = null) => {
    const parsed = num(value);
    state[key] = parsed != null ? parsed : fallback;
  };

  state.observedSince = num(stored.observedSince); // null for a pre-v0.14.0 record
  state.current = Math.max(0, num(stored.current) ?? 0);
  state.eventHigh = Math.max(0, num(stored.eventHigh) ?? 0);
  state.eventHighAt = num(stored.eventHighAt);
  state.allTimeHigh = Math.max(0, num(stored.allTimeHigh) ?? 0, state.eventHigh);
  state.updatedAt = num(stored.updatedAt) ?? Date.now();
  // notifiedHigh (the old single 95%-of-high dedupe) is dropped: the tiered
  // alerts keep their own per-tier bookkeeping.
  if (isPlainObject(stored.aura)) {
    state.aura = {
      observedMs: Math.max(0, num(stored.aura.observedMs) ?? 0),
      weightedSum: Math.max(0, num(stored.aura.weightedSum) ?? 0),
      lastSampleAt: num(stored.aura.lastSampleAt),
      lastPct: num(stored.aura.lastPct),
      changes: Array.isArray(stored.aura.changes) ? stored.aura.changes.slice(-AURA_CHANGES_MAX) : [],
    };
  }
  if (isPlainObject(stored.alerts)) state.alerts = stored.alerts;
  if (isPlainObject(stored.lastAlert)) state.lastAlert = stored.lastAlert;
  if (isPlainObject(stored.previousEvent)) state.previousEvent = stored.previousEvent;
  if (typeof stored.bossName === "string") state.bossName = stored.bossName;
  if (typeof stored.eventActive === "boolean") state.eventActive = stored.eventActive;
  if (num(stored.expiresAt) != null) state.expiresAt = num(stored.expiresAt);

  carryNum("xpUser", stored.xpUser);
  carryNum("personalTarget", stored.personalTarget);
  carryNum("chestsEarned", stored.chestsEarned);
  carryNum("chestTotal", stored.chestTotal);
  carryNum("nextThreshold", stored.nextThreshold);
  carryNum("lessonsHourly", stored.lessonsHourly);
  if (typeof stored.nextTier === "string") state.nextTier = stored.nextTier;
  if (typeof stored.guildRewardGranted === "boolean") state.guildRewardGranted = stored.guildRewardGranted;
  if (typeof stored.pinnedGuildId === "string") state.pinnedGuildId = stored.pinnedGuildId;
  if (isPlainObject(stored.guild)) state.guild = stored.guild;

  return state;
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
    // Always positioned: applyBossPanelPosition drives left/top in every state
    // (see bossAnchorPoint), so the CSS corner offsets must be released.
    panel.className = `be-boss-panel be-positioned${bossUiState.minimized ? " be-boss-minimized" : ""}`;
    // styles.css reads this as var(--be-boss-texture), falling back to the
    // gradient alone if it is ever unset.
    panel.style.setProperty("--be-boss-texture", `url("${BOSS_TEXTURE_URL}")`);
    applyBossPanelPosition(panel);

    if (bossUiState.minimized) {
      panel.innerHTML = `
        <div class="be-boss-head be-boss-drag-handle">
          <span class="be-boss-title">Boss Event · Current Aura: ${fmtPct(s.current)}</span>
          <div class="be-boss-actions">
            <button id="be-boss-settings-toggle" type="button" title="Open boss settings" aria-label="Open boss settings" aria-expanded="${bossUiState.settingsOpen ? "true" : "false"}">&#9881;</button>
            <button id="be-boss-toggle" type="button" title="Expand boss event" aria-label="Expand boss event">+</button>
            <button id="be-boss-close" type="button" title="Close and turn off the boss tracker" aria-label="Close and turn off the boss tracker">&times;</button>
          </div>
        </div>`;
      applyBossPanelPosition(panel);
      bindBossPanelControls(panel, s);
      return;
    }

    const lastUpdated = s.updatedAt ? new Date(s.updatedAt).toLocaleTimeString([], { hour: "numeric", minute: "2-digit" }) : "unknown";
    // "Event high" has always meant the highest aura CATALYST HAPPENED TO SEE,
    // which is not the event's peak when the tracker was off for part of it —
    // an event that reached 100% was recorded as 66%. Say which window the
    // recorded highs came from rather than renaming the (already tight) tiles.
    const observed = s.observedSince
      ? `Observed since ${fmtBossDate(s.observedSince)}`
      : "observation window unknown";
    const metaText = `Last updated ${lastUpdated} · ${observed}`;
    // A finished event's numbers are final results, not live progress. They stay
    // on screen — they are the last thing that happened — with a banner saying so.
    const finalMarkup = s.eventActive === false
      ? `<div class="be-boss-final">${escapeHtml(
          s.expiresAt ? `Final — event ended ${fmtBossDate(s.expiresAt)}` : "Final — no active event"
        )}</div>`
      : "";
    const mean = auraMean(s.aura);
    // The alert also lands here, not only as a toast: a toast can be missed
    // while you are in the editor or another tab, and this is still on screen
    // when you look up. Cleared when the event rolls over.
    // It ages out on its own — "near the event high" from two days ago is not
    // news — and can be dismissed the moment it has been read.
    const alertAge = num(s.lastAlert?.at) == null ? 0 : Date.now() - num(s.lastAlert.at);
    const alertMarkup = isPlainObject(s.lastAlert) && s.lastAlert.note && alertAge < BOSS_ALERT_NOTE_MAX_AGE_MS
      ? `<div class="be-boss-alert be-boss-alert-${escapeHtml(s.lastAlert.tier || "info")}">
          <span>${escapeHtml(
            `⚑ ${s.lastAlert.note}${s.lastAlert.at ? ` · ${new Date(s.lastAlert.at).toLocaleTimeString([], { hour: "numeric", minute: "2-digit" })}` : ""}`
          )}</span>
          <button id="be-boss-alert-dismiss" type="button" title="Dismiss this alert" aria-label="Dismiss this alert">&times;</button>
        </div>`
      : "";
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
            <label title="Applies to the two 'good time to submit' alerts — near this event's high, and well above its average. A new event high or all-time high always alerts, whatever this is set to.">
              <span>"Good aura" from %</span>
              <input id="be-boss-alert-floor" type="number" min="0" max="100" step="1" inputmode="numeric" value="${escapeHtml(Math.round(getAuraAlertFloor()))}">
            </label>
            <div class="be-boss-caption be-boss-settings-note">Below this, a merely-good bonus stays quiet. New event and all-time highs always alert.</div>
            ${describePreviousEvent(s.previousEvent)
              ? `<div class="be-boss-caption be-boss-settings-note">${escapeHtml(describePreviousEvent(s.previousEvent))}</div>`
              : ""}
            <div class="be-boss-manual-actions">
              <button id="be-boss-save-highs" type="button">Save highs</button>
              <button id="be-boss-refresh" type="button">Refresh</button>
              <button id="be-boss-reset" class="be-boss-reset-button" type="button" title="Reset stats for this event">Reset</button>
            </div>
          </div>
        </div>`
      : "";

    // Three blocks, matching what the event actually is since 2026-08-14: the
    // aura (community-wide, and the reason to keep the panel open), your own
    // chest ladder, and one guild. Nothing here is derived from xpTotal or from
    // healthPoints-as-community-HP.
    panel.innerHTML = `
      <div class="be-boss-head be-boss-drag-handle">
        <span class="be-boss-title">${escapeHtml(s.bossName ? `Boss Event · ${s.bossName}` : "Boss Event")}</span>
        <div class="be-boss-actions">
          <button id="be-boss-settings-toggle" type="button" aria-expanded="${bossUiState.settingsOpen ? "true" : "false"}" title="Boss high settings" aria-label="Boss high settings">&#9881;</button>
          <button id="be-boss-toggle" type="button" title="Minimize boss event" aria-label="Minimize boss event">-</button>
          <button id="be-boss-close" type="button" title="Close and turn off the boss tracker" aria-label="Close and turn off the boss tracker">&times;</button>
        </div>
      </div>
      ${finalMarkup}
      <div class="be-boss-grid">
        <div><b>${fmtPct(s.current)}</b><span>Current aura</span></div>
        <div><b>${fmtPct(s.eventHigh)}</b><span>Event high</span></div>
        <div><b>${fmtPct(s.allTimeHigh)}</b><span>All-time high</span></div>
        <div><b>${mean == null ? "–" : fmtPct(mean)}</b><span>Event average</span></div>
        <div><b>${fmtPct(Math.max(0, (s.eventHigh || 0) - (s.current || 0)))}</b><span>Below event high</span></div>
        <div><b>${fmtNum(s.lessonsHourly ?? "?")}</b><span>Lessons this hour</span></div>
      </div>
      ${alertMarkup}
      ${renderPersonalFight(s)}
      ${renderGuildFight(s)}
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

  const closeBtn = panel.querySelector("#be-boss-close");
  if (closeBtn) {
    closeBtn.onclick = () => {
      // Closing is an explicit opt-out: also mark this event's reminder as
      // handled, so the next relayed boss response doesn't immediately toast
      // an offer to reopen what was just closed. Panel removal is instant;
      // the settings write then tears down polling via the live-apply path.
      acknowledgeBossReminder(state.eventId, false);
      removeBossPanel();
      setFeatureEnabled("bossTracker", false).catch((err) => handleAsyncError(err, "bossClose"));
    };
  }

  const alertDismiss = panel.querySelector("#be-boss-alert-dismiss");
  if (alertDismiss) {
    alertDismiss.onclick = async () => {
      const next = { ...state, lastAlert: null };
      bossState = next;
      await chromeSet(BOSS_KEY, { state: next });
      renderBossPanel(next);
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

      if (eventHigh != null && Math.max(0, eventHigh) !== (next.eventHigh || 0)) {
        next.eventHigh = Math.max(0, eventHigh);
        next.eventHighAt = Date.now(); // manual edit counts as a new observation
      }
      if (allTimeHigh != null) next.allTimeHigh = Math.max(0, allTimeHigh);
      if ((next.eventHigh || 0) > (next.allTimeHigh || 0)) {
        next.allTimeHigh = next.eventHigh;
      }
      const alertFloor = num(panel.querySelector("#be-boss-alert-floor")?.value);
      if (alertFloor != null) await saveBossUiState({ alertFloor: clamp(alertFloor, 0, 100) });
      // Editing the highs re-arms the alerts: the numbers they compare against
      // just changed, so a value already announced deserves another look. The
      // panel's alert line goes too — it refers to a comparison that no longer
      // holds. (This is also the quickest way to re-test the tiers by hand,
      // without waiting out a cooldown.)
      next.alerts = null;
      next.lastAlert = null;
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

function fmtBossDate(ms) {
  return new Date(ms).toLocaleString([], { month: "short", day: "numeric", hour: "numeric", minute: "2-digit" });
}

function renderBossSection(title, right, body) {
  if (!body) return "";
  return `<div class="be-boss-section">
    <div class="be-boss-section-head"><span>${escapeHtml(title)}</span>${right ? `<b>${escapeHtml(right)}</b>` : ""}</div>
    ${body}
  </div>`;
}

function renderBossTrack(label, pctValue) {
  const width = pctValue == null ? 0 : clamp(pctValue, 0, 100);
  return `<div class="be-boss-progress-track" role="progressbar" aria-label="${escapeHtml(label)}" aria-valuemin="0" aria-valuemax="100" aria-valuenow="${escapeHtml(Math.round(width))}">
    <span style="width: ${escapeHtml(width)}%"></span>
  </div>`;
}

function renderBossCaption(text) {
  return text ? `<div class="be-boss-caption">${escapeHtml(text)}</div>` : "";
}

// Your own fight: xpUser against the userXPThreshold ladder. Rendered as one
// bar across the whole ladder, matching Boot.dev's own single track with four
// chest markers. Once every chest is earned the bar is replaced by a status
// line — a permanently-full bar says nothing, and Boot.dev calls the final
// milestone "defeating the boss personally".
function renderPersonalFight(s) {
  if (s.xpUser == null) return "";

  const earned = num(s.chestsEarned) ?? 0;
  const total = num(s.chestTotal) ?? 0;
  const target = num(s.personalTarget);
  const chestCount = total > 0 ? `${earned} of ${total} chests` : "";

  if (total > 0 && earned >= total) {
    return renderBossSection(
      "Your fight",
      chestCount,
      `<div class="be-boss-status">Boss defeated · ${escapeHtml(chestTier(total - 1))} chest earned</div>` +
        renderBossCaption(`Your event XP ${fmtNum(s.xpUser)}`)
    );
  }

  const next = num(s.nextThreshold);
  const caption = target
    ? `${fmtNum(s.xpUser)} / ${fmtNum(target)} XP` +
      (next != null
        ? ` · Next: ${s.nextTier || "next"} Chest at ${fmtNum(next)} (${fmtNum(Math.max(0, next - s.xpUser))} to go)`
        : "")
    : `Your event XP ${fmtNum(s.xpUser)}`;

  // No readable target means no honest bar — show the XP alone rather than a
  // bar measuring nothing.
  const body = target
    ? renderBossTrack("Your fight", getProgressPct(s.xpUser, target)) + renderBossCaption(caption)
    : renderBossCaption(caption);
  return renderBossSection("Your fight", chestCount, body);
}

// One guild, chosen by selectBossGuild. Renders exactly what the API serves —
// the same numbers Boot.dev's own modal shows — plus the one thing the modal
// leaves unexplained: a guild below two qualified members reports 0 XP however
// much its members have earned.
function renderGuildFight(s) {
  const g = s.guild;
  if (!isPlainObject(g) || !g.name) return "";

  const chip = g.isCompleted ? "Reward earned" : g.eligible ? "" : "Ineligible";
  const qualified =
    g.contributorCount != null && g.memberCount != null
      ? `${fmtNum(g.contributorCount)} of ${fmtNum(g.memberCount)} members qualified`
      : "";

  if (!g.eligible) {
    return renderBossSection(g.name, chip, renderBossCaption("Guilds need at least 2 members"));
  }

  const xp = num(g.xp);
  const threshold = num(g.xpThreshold);
  const body =
    renderBossCaption(qualified) +
    (g.xpPending ? renderBossCaption("Guild XP counts once 2 members qualify") : "") +
    (xp != null && threshold
      ? renderBossTrack(`${g.name} guild progress`, getProgressPct(xp, threshold)) +
        renderBossCaption(`${fmtNum(xp)} / ${fmtNum(threshold)} XP`)
      : "");
  return renderBossSection(g.name, chip, body);
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

// ---------------------------------------------------------------------------
// Aura statistics
// ---------------------------------------------------------------------------
// A TIME-WEIGHTED mean over observed time, kept as a running aggregate. The
// aura is a step function held for unequal durations and Catalyst does not
// observe continuously (the tab hides, the browser closes), so averaging raw
// samples would over-weight whichever value happened to be live while the tab
// was busiest. Each response contributes the elapsed time since the last one,
// capped, at the value that was live across it.
function newAuraStats() {
  return { observedMs: 0, weightedSum: 0, lastSampleAt: null, lastPct: null, changes: [] };
}

function updateAuraStats(stats, pctValue, now) {
  const s = isPlainObject(stats)
    ? { ...stats, changes: Array.isArray(stats.changes) ? stats.changes.slice() : [] }
    : newAuraStats();
  if (pctValue == null) return s;

  if (s.lastSampleAt != null && s.lastPct != null) {
    // The cap is what keeps a closed browser from weighting one value by three
    // days. What is left is an honest mean over the time actually watched,
    // which is what the panel's "Observed since" line claims.
    const elapsed = Math.max(0, Math.min(now - s.lastSampleAt, AURA_SAMPLE_CAP_MS));
    s.observedMs += elapsed;
    s.weightedSum += s.lastPct * elapsed;
  }
  if (s.lastPct == null || Math.abs(pctValue - s.lastPct) >= AURA_CHANGE_MIN_DELTA) {
    s.changes.push([now, pctValue]);
    // Dropping the oldest entries never distorts the mean: that is an O(1)
    // aggregate, and this list exists to retune the thresholds next event.
    if (s.changes.length > AURA_CHANGES_MAX) s.changes = s.changes.slice(-AURA_CHANGES_MAX);
  }
  s.lastPct = pctValue;
  s.lastSampleAt = now;
  return s;
}

function auraMean(stats) {
  if (!isPlainObject(stats)) return null;
  const observedMs = num(stats.observedMs);
  const weightedSum = num(stats.weightedSum);
  if (observedMs == null || weightedSum == null) return null;
  if (observedMs < AURA_MEAN_MIN_MS) return null; // too little watched to mean anything
  return weightedSum / observedMs;
}

// ---------------------------------------------------------------------------
// Alert tiers (pure: scripts/check_boss_normalizer.mjs drives this directly)
// ---------------------------------------------------------------------------
// Highest matching tier only, one alert per aura change, each with its own
// cooldown. The `prev... > 0` guards matter: on a fresh install the all-time
// high starts at 0, so without them every early sample would be a "record".
function chooseAuraAlert({ current, prevEventHigh = 0, prevAllTimeHigh = 0, mean = null, floor, alerts, now }) {
  if (current == null) return null;
  const a = isPlainObject(alerts) ? alerts : {};
  if (a.lastPct === current) return null; // this exact value already alerted

  const minFloor = num(floor) ?? AURA_ALERT_FLOOR_DEFAULT;
  const tierLastAt = isPlainObject(a.tierLastAt) ? a.tierLastAt : {};
  const cooled = (tier) => {
    const last = num(tierLastAt[tier]);
    if (last != null && now - last < AURA_ALERT_COOLDOWN_MS[tier]) return false;
    const lastAt = num(a.lastAt);
    if (
      lastAt != null &&
      a.lastTier &&
      (AURA_ALERT_RANK[a.lastTier] ?? 0) > AURA_ALERT_RANK[tier] &&
      now - lastAt < AURA_ALERT_LOWER_SUPPRESS_MS
    ) {
      return false;
    }
    return true;
  };

  if (prevAllTimeHigh > 0 && current >= prevAllTimeHigh + AURA_ALERT_MIN_DELTA && cooled("record")) {
    return {
      tier: "record",
      variant: "record",
      durationMs: 0, // sticky: a new all-time high should still be there when you look up
      message: `New all-time high — Boots Aura ${fmtPct(current)}. The best Catalyst has seen.`,
      note: `New all-time high ${fmtPct(current)}`,
    };
  }
  if (prevEventHigh > 0 && current >= prevEventHigh + AURA_ALERT_MIN_DELTA && cooled("high")) {
    return {
      tier: "high",
      variant: "high",
      durationMs: 14_000,
      message: `New event high — Boots Aura ${fmtPct(current)} (was ${fmtPct(prevEventHigh)}).`,
      note: `New event high ${fmtPct(current)}`,
    };
  }
  if (prevEventHigh > 0 && current >= AURA_ALERT_NEAR_RATIO * prevEventHigh && current >= minFloor && cooled("near")) {
    return {
      tier: "near",
      variant: "info",
      durationMs: 10_000,
      message: `Boots Aura ${fmtPct(current)} — near this event's high of ${fmtPct(prevEventHigh)}. Good time to submit.`,
      note: `Near the event high · ${fmtPct(current)}`,
    };
  }
  if (mean != null && current >= minFloor && current >= mean + AURA_ALERT_ABOVE_AVG_DELTA && cooled("above")) {
    return {
      tier: "above",
      variant: "info",
      durationMs: 10_000,
      message: `Boots Aura ${fmtPct(current)} — well above this event's ${fmtPct(mean)} average. Good time to submit.`,
      note: `Above average · ${fmtPct(current)}`,
    };
  }
  return null;
}

// The alert is delivered twice on purpose: a toast interrupts, and a line in
// the panel persists. A toast can be missed while you are in the editor or
// another tab; the panel is on screen whenever the tracker is.
function maybeNotifyAura(state, prev, now) {
  if (!isFeatureEnabled("bossAuraAlerts")) return;
  // A toast on a hidden tab is gone before it is seen. The value is still
  // recorded, and returning to the tab forces a fresh response, so the
  // "near"/"above" tiers get another chance at the current value.
  if (document.hidden) return;

  const alert = chooseAuraAlert({
    current: state.current,
    prevEventHigh: prev.eventHigh,
    prevAllTimeHigh: prev.allTimeHigh,
    mean: auraMean(state.aura),
    floor: getAuraAlertFloor(),
    alerts: state.alerts,
    now,
  });
  if (!alert) return;

  state.alerts = {
    tierLastAt: { ...(isPlainObject(state.alerts?.tierLastAt) ? state.alerts.tierLastAt : {}), [alert.tier]: now },
    lastPct: state.current,
    lastTier: alert.tier,
    lastAt: now,
  };
  state.lastAlert = { tier: alert.tier, note: alert.note, at: now };
  toast(alert.message, { variant: alert.variant, durationMs: alert.durationMs });
}

function getAuraAlertFloor() {
  const stored = num(bossUiState.alertFloor);
  return stored != null && stored >= 0 ? stored : AURA_ALERT_FLOOR_DEFAULT;
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
    // Per-device, like the rest of this record: the bonus worth interrupting for.
    alertFloor: Number.isFinite(Number(stored.alertFloor)) ? Number(stored.alertFloor) : null,
  };
  bossUiLoaded = true;
}

async function saveBossUiState(patch) {
  bossUiState = { ...bossUiState, ...patch };
  await chromeSet(BOSS_UI_KEY, bossUiState);
}

// Where the panel sits when it has never been dragged. Computed once per page
// from the default bottom-right corner and then held, because the panel is
// anchored by its TOP-LEFT: with bottom/right anchoring the bottom edge is what
// stays put, so collapsing the body walked the title and buttons down the
// screen every time the panel was minimized.
let bossDefaultAnchor = null;

function bossAnchorPoint(panel) {
  if (hasSavedBossPosition()) return { x: bossUiState.x, y: bossUiState.y };
  const width = panel.offsetWidth || 380;
  const height = panel.offsetHeight;
  // Called once before innerHTML is set, when the panel has no height yet —
  // place it provisionally then, and only cache once there is a real box to
  // measure, or the anchor would be the height-zero corner forever.
  if (!height) return { x: window.innerWidth - width - 16, y: window.innerHeight - 236 };
  if (!bossDefaultAnchor) {
    bossDefaultAnchor = { x: window.innerWidth - width - 16, y: window.innerHeight - height - 16 };
  }
  return bossDefaultAnchor;
}

function applyBossPanelPosition(panel) {
  const anchor = bossAnchorPoint(panel);
  const panelWidth = panel.offsetWidth || 320;
  const panelHeight = panel.offsetHeight || 120;
  // Clamped so a tall panel or a small window can still never push it off
  // screen — the one case where the header legitimately has to move.
  const x = clamp(anchor.x, 8, Math.max(8, window.innerWidth - panelWidth - 8));
  const y = clamp(anchor.y, 8, Math.max(8, window.innerHeight - panelHeight - 8));
  panel.style.left = `${x}px`;
  panel.style.top = `${y}px`;
  panel.style.right = "auto";
  panel.style.bottom = "auto";
}

function hasSavedBossPosition() {
  return Number.isFinite(Number(bossUiState.x)) && Number.isFinite(Number(bossUiState.y));
}

function chestTier(index) {
  // The reward payload has ChestUUIDs but no tier names; the modal renders
  // these thresholds in this order in the captured boss page.
  return ["Common", "Uncommon", "Rare", "Mythic"][index] ?? `Tier ${index + 1}`;
}

// ---------------------------------------------------------------------------
// The new event model (v0.14.0): personal ladder + guild progress
// ---------------------------------------------------------------------------
// Boot.dev replaced the community boss goal with individual and guild progress
// on 2026-08-14. Both helpers below are PURE so scripts/check_boss_normalizer.mjs
// can exercise them against the real captures in
// reference_data/catalyst_versions/v0.14.0_boss_event_redesign/api/responses/.

// Your own chest progress, computed from XPUser against the UserXPThreshold
// ladder — NOT from IsUnlocked/IsUnlockedByUser. Captures on 2026-08-16 show
// the two flags agree per chest (2,500 unlocked at xpUser 2689 while the rest
// stayed false), so this is no longer a workaround for ambiguous booleans; it
// is simply a value Catalyst can recompute, from a field whose meaning has not
// changed under it once already.
function getPersonalChestState(json) {
  const xpUser = num(json?.XPUser);
  if (xpUser == null) return null;

  const thresholds = (Array.isArray(json?.Rewards) ? json.Rewards : [])
    .map((r) => num(r?.UserXPThreshold))
    .filter((t) => t != null && t > 0)
    .sort((a, b) => a - b);

  // Event.HealthPoints is the same number as the top of the ladder (10000 in
  // every capture since the redesign) but it carried the COMMUNITY hit points
  // before it, so it is only a fallback — and never compared against XPTotal.
  const hp = num(json?.Event?.HealthPoints);
  const target = thresholds.length ? thresholds[thresholds.length - 1] : hp;
  const earned = thresholds.filter((t) => xpUser >= t).length;
  const nextIndex = thresholds.findIndex((t) => xpUser < t);
  const nextThreshold = nextIndex === -1 ? null : thresholds[nextIndex];

  return {
    xpUser,
    target: target != null && target > 0 ? target : null,
    thresholds,
    earned,
    total: thresholds.length,
    nextThreshold,
    nextTier: nextIndex === -1 ? null : chestTier(nextIndex),
    remaining: nextThreshold == null ? 0 : Math.max(0, nextThreshold - xpUser),
    defeated: thresholds.length > 0 && earned === thresholds.length,
  };
}

const GUILD_MIN_MEMBERS = 2; // Boot.dev: a guild needs 2 members to be eligible
const GUILD_MIN_QUALIFIED = 2; // ...and 2 qualified contributors before its XP counts

function describeBossGuild(g) {
  const memberCount = num(g?.MemberCount);
  const contributorCount = num(g?.ContributorCount);
  return {
    uuid: typeof g?.GuildUUID === "string" ? g.GuildUUID : null,
    name: typeof g?.Name === "string" ? g.Name : "",
    memberCount,
    contributorCount,
    xp: num(g?.XP),
    xpThreshold: num(g?.XPThreshold),
    isCompleted: g?.IsCompleted === true,
    eligible: (memberCount ?? 0) >= GUILD_MIN_MEMBERS,
    // Guild XP reads 0 until two members qualify, then jumps to the full
    // retroactive sum of their event XP (measured 2026-08-16/17: Byte Club sat
    // at 0 while a member held 260k, then went to 263,032 the instant a second
    // member qualified; DumbAndDumber went 0 -> 6149 = 3045 + 3104 exactly).
    // The panel says so, otherwise a user who has personally earned thousands
    // reads that 0 as a Catalyst bug.
    xpPending: (contributorCount ?? 0) < GUILD_MIN_QUALIFIED,
  };
}

// Which guild the panel shows, and whether that choice is pinned for the event.
// Maintainer-specified rule:
//   1. an existing pin wins, so the display never switches away mid-event
//   2. otherwise a COMPLETED guild wins AND is pinned (most XP, then UUID —
//      deterministic from the response's own values, independent of array order)
//   3. otherwise the eligible guild closest to completing (least XP remaining),
//      deliberately NOT pinned, because "closest" is a live measure
//   4. otherwise an ineligible guild, which the panel renders without a bar
// A pin naming a guild that is no longer in the list (the user left it) is
// cleared and the rule re-runs, rather than showing nothing.
function selectBossGuild(guilds, pinnedGuildId = null) {
  const list = (Array.isArray(guilds) ? guilds : []).filter(isPlainObject);
  if (!list.length) return { guild: null, pinnedGuildId: null };

  const pinned = pinnedGuildId ? list.find((g) => g.GuildUUID === pinnedGuildId) : null;
  if (pinned) return { guild: describeBossGuild(pinned), pinnedGuildId };

  const byUuid = (a, b) => String(a?.GuildUUID ?? "").localeCompare(String(b?.GuildUUID ?? ""));
  const completed = list
    .filter((g) => g.IsCompleted === true)
    .sort((a, b) => (num(b.XP) ?? 0) - (num(a.XP) ?? 0) || byUuid(a, b));
  if (completed.length) {
    return {
      guild: describeBossGuild(completed[0]),
      pinnedGuildId: typeof completed[0].GuildUUID === "string" ? completed[0].GuildUUID : null,
    };
  }

  // An unreadable threshold sorts last rather than winning by default.
  const remaining = (g) => {
    const threshold = num(g.XPThreshold);
    return threshold == null ? Infinity : Math.max(0, threshold - (num(g.XP) ?? 0));
  };
  const eligible = list.filter((g) => (num(g.MemberCount) ?? 0) >= GUILD_MIN_MEMBERS);
  const pool = eligible.length ? eligible : list;
  const best = pool
    .slice()
    .sort((a, b) => remaining(a) - remaining(b) || (num(b.XP) ?? 0) - (num(a.XP) ?? 0) || byUuid(a, b))[0];

  return { guild: describeBossGuild(best), pinnedGuildId: null };
}

// Test hook: scripts/check_boss_normalizer.mjs predefines this global before
// evaluating the file. Never defined on the real page.
if (typeof window !== "undefined" && window.__BOOTDEV_ENHANCER_TEST__) {
  window.__BOOTDEV_ENHANCER_TEST__.boss = {
    pickField,
    normalizeBossProgressJson,
    hasBossEventIdentity,
    isBossEventActive,
    getPersonalChestState,
    selectBossGuild,
    migrateBossState,
    newEventState,
    renderPersonalFight,
    renderGuildFight,
    archivePreviousEvent,
    describePreviousEvent,
    updateAuraStats,
    auraMean,
    chooseAuraAlert,
  };
}
