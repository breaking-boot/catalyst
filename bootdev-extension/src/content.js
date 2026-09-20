// content.js
// Isolated-world content script. Injects injected.js into the page context,
// listens for relayed api.boot.dev responses via window.postMessage, and
// routes each response to the appropriate feature handler.
// Loaded last by manifest.json; all feature handlers are already in scope.
//
// NOTE ON FIELD NAMES: response fields are mapped from captured api.boot.dev
// JSON under the repo-level reference_data/http_responses_from_api_endpoints.

const TAG = "BOOTDEV_ENHANCER";
const API_REQUEST_TIMEOUT_MS = 10_000;
const AUTH_RETRY_MS = 5 * 60_000;
const DASHBOARD_CONTENT_URL = "https://api.boot.dev/v1/dashboard_content";
const SETTINGS_INTRO_KEY = "be_settings_introduced";
// Written by backup.js (options page) after a successful import — keep in sync.
const IMPORT_BROADCAST_KEY = "be_import_broadcast";

let routeScanTimer = null;
let domScanTimer = null;
let dashboardAuthUnavailableUntil = 0;
let pendingApiRequests = new Map();
let lastPath = location.pathname;

// ---------------------------------------------------------------------------
// 1. Inject the page-context interceptor.
// ---------------------------------------------------------------------------
(function injectPageScript() {
  try {
    const s = document.createElement("script");
    s.src = chrome.runtime.getURL("src/injected.js");
    s.onload = () => s.remove();
    (document.head || document.documentElement).appendChild(s);
  } catch (err) {
    handleAsyncError(err, "inject");
  }
})();

// ---------------------------------------------------------------------------
// 2. Listen for relayed responses.
// ---------------------------------------------------------------------------
window.addEventListener("message", handleWindowMessage);

function handleWindowMessage(event) {
  if (enhancerStopped) return;
  if (event.source !== window) return;
  if (event.origin !== window.location.origin) return;
  const msg = event.data;
  if (!msg || msg.source !== TAG) return;
  // Page-context notices carry no response body; they are not API traffic.
  if (msg.notice === "BE_PAGE_HYDRATED") {
    notePageHydrated(msg.reason);
    return;
  }
  if (!msg.payload || !("json" in msg.payload)) {
    return;
  }
  try {
    resolveApiRequest(msg.payload);
  } catch (err) {
    handleAsyncError(err, "resolve");
  }
  Promise.resolve(routeResponse(msg.payload)).catch((err) => handleAsyncError(err, "route"));
}

initEnhancer().catch((err) => handleAsyncError(err, "init"));

// ---------------------------------------------------------------------------
// 3. Route responses to handlers by URL.
// ---------------------------------------------------------------------------
async function routeResponse({ url, status, json, catalyst }) {
  try {
    const path = new URL(url, window.location.origin).pathname;
    const publicUserMatch = /^\/v1\/users\/public\/([^/]+)(\/stats)?$/.exec(path);
    const userLessonMatch = /^\/v1\/users\/lessons\/([^/]+)$/.exec(path);
    const heatmapMatch = /^\/v1\/users\/public\/([^/]+)\/activity_heatmap$/.exec(path);

    if (status === 0 && json?.error === "auth_headers_unavailable") {
      handleAuthUnavailable(path);
      return;
    }
    if (status === 401) {
      handleUnauthorizedApi(path);
      return;
    }
    // Everything reaching here is a path some feature consumes: injected.js
    // relays only RELAY_PATH_PATTERNS plus responses to our own requests. So a
    // repeated failure is always worth one line, and the drop that used to be
    // silent (see reportEndpointFailure) now leaves a breadcrumb.
    if (status < 200 || status >= 300) {
      reportEndpointFailure(path, status);
      return;
    }
    noteEndpointSuccess(path);

    if (path === "/v1/leaderboard_xp/alltime") {
      handleAllTimeLeaderboard(json);
    } else if (path === "/v1/leaderboard_xp/day") {
      handleDailyXpLeaderboard(json);
    } else if (path === "/v1/leaderboard_xp/week" || path === "/v1/leaderboard_xp/month") {
      // Discovery only — never a daily figure. See handleXpDiscoveryBoard.
      handleXpDiscoveryBoard(json);
    } else if (path === "/v1/leaderboard_stats") {
      handleLeaderboardStats(json);
    } else if (path === "/v1/leaderboard_karma/alltime") {
      handleKarmaLeaderboard(json);
    } else if (path === "/v1/league_leaderboard_xp/day") {
      handleLeagueDailyLeaderboard(json);
    } else if (/^\/v1\/league_leaderboard_xp\/[^/]+$/.test(path)) {
      handleLeagueLeaderboard(json);
    } else if (heatmapMatch) {
      handlePersonalHeatmap(decodeURIComponent(heatmapMatch[1]), json);
    } else if (publicUserMatch) {
      handlePublicUserResponse(decodeURIComponent(publicUserMatch[1]), Boolean(publicUserMatch[2]), json);
    } else if (path === "/v1/challenges/search") {
      handleChallengeSearch(json, catalyst);
    } else if (path === "/v1/boss_events_progress") {
      await handleBossProgress(json);
    } else if (path === "/v1/dashboard_content") {
      await handleDashboardContent(json);
    } else if (userLessonMatch) {
      // Whether a failed submission here can still cost armor — the Submit
      // confirmation's whole question, and this is the only source for it.
      recordLessonRiskState(decodeURIComponent(userLessonMatch[1]), json);
      refreshNextLessonFromDashboardSoon();
    } else if (/\/v1\/course_progress_by_lesson\/[^/]+$/.test(path)) {
      refreshNextLessonFromDashboardSoon();
    }
  } catch (e) {
    handleAsyncError(e, "routing");
  }
}

async function initEnhancer() {
  await loadSettings();
  await loadBossUiState();
  await loadNextLessonHref();
  await loadCurrentUserHandle();
  await loadPersonalLeaderboard();
  await loadAllTimeRoster();
  await loadLeaderboardStats();
  await loadFrameDebugFlag();
  if (enhancerStopped) return;
  chrome.storage.onChanged.addListener(handleSettingsChange);
  document.addEventListener("visibilitychange", handleVisibilityChange);
  restoreBossPanel();
  syncRouteScopedUi();
  resetBossRefreshTimer(true);
  requestDashboardContentIfUseful(900);
  bindNextLessonShortcut();
  bindTrainingGroundsEvents();
  bindSubmitConfirm();
  bindCliShortcuts();
  bindAssignmentShortcuts();
  startDomScan();
  maybeShowSettingsIntro().catch((err) => handleAsyncError(err, "intro"));
  maybeRunVersionCheck().catch((err) => handleAsyncError(err, "versionCheck"));
  maybeTriggerBossReminderDebug().catch((err) => handleAsyncError(err, "bossReminderDebug"));
  maybeReplayBossDebugResponse().catch((err) => handleAsyncError(err, "bossDebugResponse"));

  routeScanTimer = setTrackedInterval(() => {
    if (location.pathname === lastPath) return;
    lastPath = location.pathname;
    syncRouteScopedUi();
    resetBossRefreshTimer(true);
    requestDashboardContentIfUseful(900);
  }, 350);
}

// One-time nudge so users discover the (otherwise hidden) toolbar icon as the
// way into settings. Stored in storage.local so it shows once per device.
async function maybeShowSettingsIntro() {
  const seen = await chromeGet(SETTINGS_INTRO_KEY);
  if (seen || enhancerStopped) return;
  await waitFor(() => document.body);
  if (enhancerStopped) return;
  await chromeSet(SETTINGS_INTRO_KEY, { shownAt: Date.now() });
  if (enhancerStopped) return;
  toast("Catalyst is active. Click its toolbar icon (pin it from the puzzle-piece menu) to choose what's shown.");
}

// A route change / initial load both renders the UI and fetches fresh data.
function syncRouteScopedUi() {
  renderRouteScopedUi();
  requestRouteScopedData();
}

// Render/teardown only, from cached data — never issues network requests.
function renderRouteScopedUi() {
  renderNextLessonNav();
  captureNextLessonFromDom();
  learnCurrentUserHandleFromDom();
  ensureTrainingGroundsUiState();
  // Also reached from applyFeatureSettings, so switching the setting off closes
  // an open dialog as well as leaving the lesson route does.
  ensureSubmitConfirmUiState();

  if (isLeaderboardPage()) {
    renderAllTimeLeaderboard();
    schedulePersonalLeaderboardRender();
  } else {
    removeAllTimeLeaderboard();
    removePersonalLeaderboards();
  }

  if (!isProfilePage()) {
    removeProfileXpBadge();
  }
  ensureProfileUiState();
}

// The leaderboard-page fetches, kept separate so settings changes can re-render
// without re-pulling everything.
function requestRouteScopedData() {
  if (!isLeaderboardPage()) return;
  setTrackedTimeout(() => requestPersonalLeaderboardData(), 100);
  setTrackedTimeout(() => requestNativeLeaderboardData(), 150);
  // Last: the personal pass above is already in flight, so its handles are
  // skipped rather than fetched twice, and the native boards may have answered
  // with sightings that make part of this pass unnecessary.
  setTrackedTimeout(() => requestAllTimeRosterRefresh(), 400);
}

// Refresh boss data when the tab regains focus. Forced, so a new event that
// began while the tab was hidden is picked up too (matches the documented
// "tab focus resumes polling" behavior). Tab focus is infrequent and
// user-driven, so the one request it costs during downtime is negligible.
function handleVisibilityChange() {
  if (enhancerStopped || document.hidden) return;
  requestBossProgress(true);
}

// Live-apply a settings change from the popup/options page (chrome.storage.sync),
// or an options-page backup import (signalled via the local broadcast key).
function handleSettingsChange(changes, area) {
  if (enhancerStopped) return;
  if (area === "local" && changes[IMPORT_BROADCAST_KEY]) {
    applyImportedData().catch((err) => handleAsyncError(err, "import"));
    return;
  }
  if (area === "local") {
    adoptCrossTabWrites(changes).catch((err) => handleAsyncError(err, "crossTab"));
    return;
  }
  if (area !== "sync" || !changes[SETTINGS_KEY]) return;
  const before = getSettings();
  applyStoredSettings(changes[SETTINGS_KEY].newValue);
  applyFeatureSettings(before, getSettings());
}

// Another tab wrote one of the shared data keys. Until v0.15.1 tabs ignored
// these deliberately — they write them routinely, so reacting meant looping on
// their own writes — and the cost was that each tab kept its own divergent copy
// and overwrote the others. Boss event highs differing per tab is the reported
// form of it.
//
// Every write now carries the writing document's id (see mergeWrite in
// utils.js), so this tab's own echo is identifiable and skipped, and the loop
// that made this unsafe cannot form. The writer has already merged, so adopting
// what is on disk is simply taking the newer, reconciled copy.
async function adoptCrossTabWrites(changes) {
  const fromAnotherTab = (key) => {
    const change = changes[key];
    return Boolean(change) && !isOwnStorageWrite(change.newValue);
  };

  if (fromAnotherTab(BOSS_KEY)) {
    await adoptBossState(changes[BOSS_KEY].newValue);
  }
  if (fromAnotherTab(PERSONAL_CACHE_KEY) || fromAnotherTab(PERSONAL_HANDLES_KEY)) {
    await loadPersonalLeaderboard();
    if (enhancerStopped) return;
    schedulePersonalLeaderboardRender();
  }
  if (fromAnotherTab(ALLTIME_ROSTER_KEY)) {
    await loadAllTimeRoster();
    if (enhancerStopped) return;
    renderAllTimeLeaderboard();
  }
  if (fromAnotherTab(CURRENT_USER_KARMA_KEY)) {
    // The karma series is loaded alongside the handle it belongs to.
    await loadCurrentUserHandle();
    if (enhancerStopped) return;
    schedulePersonalLeaderboardRender();
  }
}

// An options-page import merged data into storage.local behind this tab's back
// (see backup.js). Reload the affected in-memory state — it is written through
// from memory, so a stale copy would clobber the merge on its next save — then
// re-render and fetch whatever the newly added handles are missing. Imported
// settings need nothing here: their sync write already runs the live-apply above.
async function applyImportedData() {
  await loadCurrentUserHandle();
  await loadPersonalLeaderboard();
  // Forced: the memoized load has already run, so without this the next
  // write-through would clobber the merged boss highs with our stale copy.
  await loadBossState({ force: true });
  await restoreBossPanel();
  await loadAllTimeRoster();
  if (enhancerStopped) return;
  renderAllTimeLeaderboard();
  schedulePersonalLeaderboardRender();
  if (isLeaderboardPage() && personalDataMissing()) requestPersonalLeaderboardData();
}

function applyFeatureSettings(before, after) {
  if (enhancerStopped) return;

  if (isFeatureEnabled("bossTracker")) {
    restoreBossPanel();
    resetBossRefreshTimer(true);
  } else {
    removeBossPanel();
    clearBossRefreshTimer();
  }
  // A visible boss reminder is moot once the tracker is shown, and must go
  // away immediately when reminders are switched off.
  if (isFeatureEnabled("bossTracker") || !isFeatureEnabled("bossReminders")) {
    removeBossReminderToast();
  }

  // Re-render the profile badge/button from cached data (handles both on and off);
  // unlike the other features it isn't redrawn by the standard render pass.
  reapplyProfileStats();

  applyChallengeFilterSetting(before, after);

  // Render from cache only. Fetching here would re-pull every Personal
  // Leaderboards handle (2 calls each) on every unrelated toggle.
  renderRouteScopedUi();
  if (isLeaderboardPage()) {
    if (isFeatureEnabled("comparisons")) augmentNativeLeaderboards();
    else removeNativeComparisons();
  }

  // Run a release check right away when the opt-in is switched on (page-independent).
  if (before && after && before.versionCheck === false && after.versionCheck !== false) {
    maybeRunVersionCheck().catch((err) => handleAsyncError(err, "versionCheck"));
  }

  // Fetch only when a feature just turned on AND its data isn't already cached.
  if (!before || !after || !isLeaderboardPage()) return;
  const turnedOn = (key) => before[key] === false && after[key] !== false;
  // The board renders from the roster with no request at all (renderRouteScopedUi
  // above already did); this only schedules whatever refresh is due.
  if (turnedOn("allTimeLeaderboard")) {
    requestAllTimeRosterRefresh();
  }
  if ((turnedOn("personalLeaderboards") || PERSONAL_BOARDS.some((b) => turnedOn(b.settingKey))) &&
      personalDataMissing()) {
    requestPersonalLeaderboardData();
  }
  if (turnedOn("comparisons") && !hasNativeComparisonData()) {
    requestNativeLeaderboardData();
  }
}

function startDomScan() {
  domScanTimer = setTrackedInterval(() => {
    renderNextLessonNav();
    captureNextLessonFromDom();
    learnCurrentUserHandleFromDom();
    ensureLeaderboardUiState();
    ensureTrainingGroundsUiState();
    ensureProfileUiState();
    checkFrameAssetsForRot();
  }, 2000);
}

function requestDashboardContentIfUseful(delay = 0) {
  if (!isFeatureEnabled("nextLesson")) return false;
  if (!shouldRefreshDashboardContent()) return false;
  if (Date.now() < dashboardAuthUnavailableUntil) return false;

  if (delay > 0) {
    setTrackedTimeout(() => requestDashboardContentIfUseful(0), delay);
    return true;
  }
  return requestApiJson(DASHBOARD_CONTENT_URL);
}

function shouldRefreshDashboardContent() {
  return isDashboardPage() || isLessonPage();
}

function requestApiJson(url, requestId = null) {
  if (enhancerStopped) return false;
  window.postMessage(
    { source: TAG, command: "BE_FETCH_JSON", payload: { url, requestId } },
    window.location.origin
  );
  return true;
}

function fetchApiJson(url, timeoutMs = API_REQUEST_TIMEOUT_MS) {
  return new Promise((resolve) => {
    if (enhancerStopped) {
      resolve({ url, status: 0, json: { error: "extension_stopped" } });
      return;
    }

    const requestId = createRequestId();
    const timeoutId = setTrackedTimeout(() => {
      pendingApiRequests.delete(requestId);
      resolve({ url, status: 0, json: { error: "timeout" }, timedOut: true });
    }, timeoutMs);

    pendingApiRequests.set(requestId, { resolve, timeoutId });
    if (!requestApiJson(url, requestId)) {
      clearTrackedTimeout(timeoutId);
      pendingApiRequests.delete(requestId);
      resolve({ url, status: 0, json: { error: "request_not_sent" } });
    }
  });
}

async function fetchApiJsonWithAuthRetry(url, timeoutMs = API_REQUEST_TIMEOUT_MS) {
  const first = await fetchApiJson(url, timeoutMs);
  if (!isAuthStatus(first.status) || enhancerStopped) return first;

  await trackedDelay(750);
  if (enhancerStopped) return first;

  const second = await fetchApiJson(url, timeoutMs);
  second.authRetried = true;
  second.firstStatus = first.status;
  return second;
}

function isAuthStatus(status) {
  return status === 401 || status === 403;
}

function trackedDelay(ms) {
  return new Promise((resolve) => {
    setTrackedTimeout(resolve, ms);
  });
}

function resolveApiRequest(payload) {
  const requestId = payload?.requestId;
  if (!requestId || !pendingApiRequests.has(requestId)) return;

  const pending = pendingApiRequests.get(requestId);
  pendingApiRequests.delete(requestId);
  clearTrackedTimeout(pending.timeoutId);
  pending.resolve(payload);
}

function createRequestId() {
  return `be_${Date.now().toString(36)}_${Math.random().toString(36).slice(2)}`;
}

function handleAuthUnavailable(path) {
  if (path === "/v1/dashboard_content") {
    dashboardAuthUnavailableUntil = Date.now() + 15_000;
  } else if (path === "/v1/boss_events_progress") {
    markBossAuthUnavailable(15_000, true);
  }
}

function handleUnauthorizedApi(path) {
  if (path === "/v1/dashboard_content") {
    dashboardAuthUnavailableUntil = Date.now() + AUTH_RETRY_MS;
  } else if (path === "/v1/boss_events_progress") {
    // Retry, unlike before: markBossAuthUnavailable(…, false) cleared the poll
    // timer and scheduled nothing to restart it, so a single 401 could stop the
    // tracker for the rest of the session unless a route change happened to
    // revive it. Costs at most one request per AUTH_RETRY_MS while it persists.
    markBossAuthUnavailable(AUTH_RETRY_MS, true);
  } else {
    // Anything else lands here and is dropped — the feature that asked for it
    // simply renders nothing. That silence is what hid the league-board 401s
    // (they were missing from AUTH_REQUIRED_PATHS in injected.js, so they were
    // sent bare instead of queued). Leave a breadcrumb so the next one is
    // findable in the console rather than invisible.
    console.debug("[catalyst] unhandled 401 from", path);
  }
}

function stopEnhancer() {
  if (enhancerStopped) return;
  enhancerStopped = true;
  window.removeEventListener("message", handleWindowMessage);
  document.removeEventListener("visibilitychange", handleVisibilityChange);
  unbindNextLessonShortcut();
  unbindTrainingGroundsEvents();
  unbindSubmitConfirm();
  unbindCliShortcuts();
  unbindAssignmentShortcuts();
  closeSubmitConfirmDialog();
  try {
    chrome.storage.onChanged.removeListener(handleSettingsChange);
  } catch (_) {}
  clearBossRefreshTimer();
  if (routeScanTimer) clearInterval(routeScanTimer);
  if (domScanTimer) clearInterval(domScanTimer);
  routeScanTimer = null;
  domScanTimer = null;
  for (const timeoutId of trackedTimeouts) clearTimeout(timeoutId);
  trackedTimeouts.clear();
  for (const pending of pendingApiRequests.values()) {
    clearTimeout(pending.timeoutId);
    pending.resolve({ status: 0, json: { error: "extension_stopped" } });
  }
  pendingApiRequests.clear();
}
