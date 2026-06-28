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
  if (!msg || msg.source !== TAG || !msg.payload || !("json" in msg.payload)) {
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
async function routeResponse({ url, status, json }) {
  try {
    const path = new URL(url, window.location.origin).pathname;
    const publicUserMatch = /^\/v1\/users\/public\/([^/]+)(\/stats)?$/.exec(path);

    if (status === 0 && json?.error === "auth_headers_unavailable") {
      handleAuthUnavailable(path);
      return;
    }
    if (status === 401) {
      handleUnauthorizedApi(path);
      return;
    }
    if (status < 200 || status >= 300) return;

    if (path === "/v1/leaderboard_xp/alltime") {
      handleAllTimeLeaderboard(json);
    } else if (path === "/v1/leaderboard_xp/day") {
      handleDailyXpLeaderboard(json);
    } else if (path === "/v1/leaderboard_karma/alltime") {
      handleKarmaLeaderboard(json);
    } else if (path === "/v1/league_leaderboard_xp/day") {
      handleLeagueDailyLeaderboard(json);
    } else if (/^\/v1\/league_leaderboard_xp\/[^/]+$/.test(path)) {
      handleLeagueLeaderboard(json);
    } else if (publicUserMatch) {
      handlePublicUserResponse(decodeURIComponent(publicUserMatch[1]), Boolean(publicUserMatch[2]), json);
    } else if (path === "/v1/boss_events_progress") {
      await handleBossProgress(json);
    } else if (path === "/v1/dashboard_content") {
      await handleDashboardContent(json);
    } else if (/\/v1\/users\/lessons\/[^/]+$/.test(path) ||
        /\/v1\/course_progress_by_lesson\/[^/]+$/.test(path)) {
      refreshNextLessonFromDashboardSoon();
    }
  } catch (e) {
    handleAsyncError(e, "routing");
  }
}

async function initEnhancer() {
  await loadBossUiState();
  await loadCachedAllTimeLeaderboard();
  await loadNextLessonHref();
  await loadCurrentUserHandle();
  await loadPersonalLeaderboard();
  if (enhancerStopped) return;
  restoreBossPanel();
  syncRouteScopedUi();
  resetBossRefreshTimer(true);
  requestDashboardContentIfUseful(900);
  bindNextLessonShortcut();
  startDomScan();

  routeScanTimer = setTrackedInterval(() => {
    if (location.pathname === lastPath) return;
    lastPath = location.pathname;
    syncRouteScopedUi();
    resetBossRefreshTimer(true);
    requestDashboardContentIfUseful(900);
  }, 350);
}

function syncRouteScopedUi() {
  renderNextLessonNav();
  captureNextLessonFromDom();
  learnCurrentUserHandleFromDom();

  if (isLeaderboardPage()) {
    if (cachedAllTimeEntries.length) renderAllTimeLeaderboard(cachedAllTimeEntries);
    schedulePersonalLeaderboardRender();
    setTrackedTimeout(() => requestApiJson(ALL_TIME_LEADERBOARD_URL), 50);
    setTrackedTimeout(() => requestPersonalLeaderboardData(), 100);
    setTrackedTimeout(() => requestNativeLeaderboardData(), 150);
  } else {
    removeAllTimeLeaderboard();
    removePersonalLeaderboards();
  }

  if (!isProfilePage()) {
    removeProfileXpBadge();
  }
}

function startDomScan() {
  domScanTimer = setTrackedInterval(() => {
    renderNextLessonNav();
    captureNextLessonFromDom();
    learnCurrentUserHandleFromDom();
    ensureLeaderboardUiState();
  }, 2000);
}

function requestDashboardContentIfUseful(delay = 0) {
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
    markBossAuthUnavailable(AUTH_RETRY_MS, false);
  }
}

function stopEnhancer() {
  if (enhancerStopped) return;
  enhancerStopped = true;
  window.removeEventListener("message", handleWindowMessage);
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
