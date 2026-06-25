// content.js
// Runs in the isolated content-script world. Responsibilities:
//   1. Inject injected.js into the page context (to wrap fetch/XHR).
//   2. Receive relayed API responses via window.postMessage.
//   3. Route each response to a feature handler.
//   4. Own the stateful boss-event tracker (chrome.storage + notifications).
//
// NOTE ON FIELD NAMES: response fields are mapped from captured api.boot.dev
// JSON under the repo-level reference_data/http_responses_from_api_endpoints.

const TAG = "BOOTDEV_ENHANCER";
const BOSS_KEY = "be_boss_state";
const BOSS_UI_KEY = "be_boss_ui_state";
const LEADERBOARD_CACHE_KEY = "be_alltime_leaderboard_cache";
const NEXT_LESSON_KEY = "be_next_lesson_href";
const BOSS_PROGRESS_URL = "https://api.boot.dev/v1/boss_events_progress";
const ALL_TIME_LEADERBOARD_URL = "https://api.boot.dev/v1/leaderboard_xp/alltime";
const DASHBOARD_CONTENT_URL = "https://api.boot.dev/v1/dashboard_content";
const ARCHMAGE_FRAME_URL = "https://www.boot.dev/_nuxt/9.Cmx5X891.png";
const BOSS_REFRESH_MS = 30_000;
const NEAR_HIGH_THRESHOLD = 0.95; // notify when current >= 95% of event high

let bossRefreshTimer = null;
let bossUiState = { minimized: false, x: null, y: null };
let bossUiLoaded = false;
let cachedAllTimeEntries = [];
let nextLessonHref = null;
let lastPath = location.pathname;

// ---------------------------------------------------------------------------
// 1. Inject the page-context interceptor.
// ---------------------------------------------------------------------------
(function injectPageScript() {
  const s = document.createElement("script");
  s.src = chrome.runtime.getURL("src/injected.js");
  s.onload = () => s.remove();
  (document.head || document.documentElement).appendChild(s);
})();

// ---------------------------------------------------------------------------
// 2. Listen for relayed responses.
// ---------------------------------------------------------------------------
window.addEventListener("message", (event) => {
  if (event.source !== window) return;
  const msg = event.data;
  if (!msg || msg.source !== TAG || !msg.payload || !("json" in msg.payload)) {
    return;
  }
  routeResponse(msg.payload);
});

initEnhancer();

// ---------------------------------------------------------------------------
// 3. Route responses to handlers by URL.
// ---------------------------------------------------------------------------
function routeResponse({ url, status, json }) {
  if (status < 200 || status >= 300) return;
  try {
    const path = new URL(url, window.location.origin).pathname;

    if (path === "/v1/leaderboard_xp/alltime") {
      handleAllTimeLeaderboard(json);
    } else if (/\/v1\/users\/public\/[^/]+$/.test(path) ||
        /\/v1\/users\/public\/[^/]+\/stats$/.test(path)) {
      handleProfileStats(json);
    } else if (path === "/v1/boss_events_progress") {
      handleBossProgress(json);
    } else if (path === "/v1/dashboard_content") {
      handleNextLessonData(json);
    } else if (/\/v1\/course_progress_by_lesson\/[^/]+$/.test(path) ||
        /\/v1\/lessons\/[^/]+\/?$/.test(path)) {
      handleNextLessonData(json);
    }
  } catch (e) {
    console.warn("[Boot.dev Enhancer] routing error", e);
  }
}

async function initEnhancer() {
  await loadBossUiState();
  await loadCachedAllTimeLeaderboard();
  await loadNextLessonHref();
  restoreBossPanel();
  syncRouteScopedUi();
  resetBossRefreshTimer(true);
  requestApiJson(DASHBOARD_CONTENT_URL);
  startDomScan();

  setInterval(() => {
    if (location.pathname === lastPath) return;
    lastPath = location.pathname;
    syncRouteScopedUi();
    resetBossRefreshTimer(true);
    requestApiJson(DASHBOARD_CONTENT_URL);
  }, 350);
}

async function restoreBossPanel() {
  const stored = (await chromeGet(BOSS_KEY)) || {};
  if (stored.state) renderBossPanel(stored.state);
}

function syncRouteScopedUi() {
  renderNextLessonNav();
  captureNextLessonFromDom();

  if (isLeaderboardPage()) {
    if (cachedAllTimeEntries.length) renderAllTimeLeaderboard(cachedAllTimeEntries);
    setTimeout(() => requestApiJson(ALL_TIME_LEADERBOARD_URL), 50);
  } else {
    removeAllTimeLeaderboard();
  }

  if (!isProfilePage()) {
    removeProfileXpBadge();
  }
}

function startDomScan() {
  setInterval(() => {
    renderNextLessonNav();
    captureNextLessonFromDom();
  }, 2000);
}

function resetBossRefreshTimer(fetchNow = false) {
  if (bossRefreshTimer) clearInterval(bossRefreshTimer);
  if (fetchNow) {
    setTimeout(() => requestApiJson(BOSS_PROGRESS_URL), 250);
  }
  bossRefreshTimer = setInterval(() => {
    requestApiJson(BOSS_PROGRESS_URL);
  }, BOSS_REFRESH_MS);
}

function requestApiJson(url) {
  window.postMessage(
    { source: TAG, command: "BE_FETCH_JSON", payload: { url } },
    window.location.origin
  );
}

// ===========================================================================
// FEATURE 1: All-time XP leaderboard section
// ===========================================================================
function handleAllTimeLeaderboard(json) {
  if (!isLeaderboardPage()) return;

  const entries = getLeaderboardEntries(json);
  if (!entries.length) return;
  cachedAllTimeEntries = entries;
  chromeSet(LEADERBOARD_CACHE_KEY, { entries, updatedAt: Date.now() });

  renderAllTimeLeaderboard(entries);
}

function renderAllTimeLeaderboard(entries) {
  // The leaderboard page is an SPA route; wait for the native global section.
  waitFor(() => findAllTimeLeaderboardInsertionPoint() || document.querySelector("main") || document.body).then((host) => {
    if (!isLeaderboardPage()) return;
    if (!host) return;
    let panel = document.getElementById("be-alltime-leaderboard");
    if (!panel) {
      panel = document.createElement("section");
      panel.id = "be-alltime-leaderboard";
      panel.className = "be-native-leaderboard";
      if (host.matches?.("h1,h2,h3,[role='heading']")) {
        host.insertAdjacentElement("beforebegin", panel);
      } else if (host.parentElement && !["MAIN", "BODY"].includes(host.tagName)) {
        host.insertAdjacentElement("afterend", panel);
      } else {
        host.append(panel);
      }
    }
    const visibleEntries = getVisibleAllTimeEntries(entries);
    const currentHandle = getCurrentUserHandle();
    const cards = visibleEntries
      .map((e, i) => {
        const handle = getHandle(e);
        const displayName = getDisplayName(e, handle);
        const xp = e.XP ?? e.TotalXP ?? e.XPEarned ?? 0;
        const avatar = getAvatarUrl(e);
        const rank = e.Position ?? e.Rank ?? i + 1;
        const isCurrentUser = isCurrentLeaderboardEntry(e, currentHandle);
        const href = handle ? `/u/${encodeURIComponent(handle)}` : "#";
        const avatarMarkup = avatar
          ? `<img src="${escapeHtml(avatar)}" alt="${escapeHtml(displayName)} avatar" class="be-leader-avatar-img">`
          : `<span class="be-leader-avatar-fallback">${escapeHtml(displayName.slice(0, 1).toUpperCase() || "?")}</span>`;

        return `<div class="be-leader-card${isCurrentUser ? " be-current-user" : ""}">
            <a href="${href}" class="be-leader-link">
              <span class="be-leader-rank">${escapeHtml(rank)}</span>
              <span class="be-leader-avatar">
                <span class="be-leader-avatar-inner">${avatarMarkup}</span>
                <img src="${ARCHMAGE_FRAME_URL}" alt="" class="be-leader-frame" aria-hidden="true">
              </span>
              <span class="be-leader-copy">
                <span class="be-leader-name">${escapeHtml(displayName)}</span>
                <span class="be-leader-xp">${fmtNum(xp)} xp</span>
              </span>
            </a>
          </div>`;
      })
      .join("");

    panel.innerHTML = `
      <h3 class="be-native-title">Top All-Time Learners</h3>
      <div class="be-native-grid-wrap">
        <div class="be-native-grid">${cards}</div>
      </div>`;
  });
}

function getVisibleAllTimeEntries(entries) {
  const currentHandle = getCurrentUserHandle();
  const top25 = entries.slice(0, 25);
  if (!currentHandle) return top25;

  const current = entries.find((entry) => isCurrentLeaderboardEntry(entry, currentHandle));
  if (!current) return top25;

  const currentRank = num(current.Position ?? current.Rank);
  if (currentRank != null && currentRank > 25) {
    const top24 = entries
      .filter((entry) => !isCurrentLeaderboardEntry(entry, currentHandle))
      .slice(0, 24);
    return [...top24, current];
  }

  return top25;
}

// ===========================================================================
// FEATURE 2: Cumulative XP on profiles
// ===========================================================================
function handleProfileStats(json) {
  if (!isProfilePage()) return;

  const profile = json?.data ?? json;
  const totalXp = profile?.XP ?? null;
  if (totalXp == null) return;

  waitFor(() => findProfileLevelAnchor(profile) || findProfileAnchor(profile)).then((anchor) => {
    if (!isProfilePage()) return;
    if (!anchor) return;
    let badge = document.getElementById("be-total-xp");
    if (!badge) {
      badge = document.createElement("div");
      badge.id = "be-total-xp";
      badge.className = "be-profile-total-xp";
    }
    const progress = getLevelProgress(profile);
    const progressMarkup = progress
      ? `<div class="be-profile-level-xp"><strong>${fmtNum(progress.current)}</strong> / ${fmtNum(progress.total)} XP</div>
         <div class="be-profile-remaining-xp">Remaining: ${fmtNum(progress.remaining)} XP</div>`
      : "";
    badge.innerHTML = `<div>Total XP: <strong>${fmtNum(totalXp)}</strong></div>${progressMarkup}`;
    anchor.insertAdjacentElement("afterend", badge);
  });
}

// ===========================================================================
// FEATURE 3: Next Lesson button in the top navigation
// ===========================================================================
function handleNextLessonData(json) {
  const href = findLessonHrefInData(json);
  if (href) rememberNextLessonHref(href);
}

async function rememberNextLessonHref(href) {
  const normalized = normalizeLessonHref(href);
  if (!normalized || normalized === nextLessonHref) return;

  nextLessonHref = normalized;
  await chromeSet(NEXT_LESSON_KEY, { href: normalized, updatedAt: Date.now() });
  renderNextLessonNav();
}

function renderNextLessonNav() {
  const existing = document.getElementById("be-next-lesson-nav");
  if (!nextLessonHref) {
    existing?.remove();
    return;
  }

  waitFor(() => findTopNavInsertionPoint(), 3000).then((anchor) => {
    if (!anchor || !nextLessonHref) return;
    const target = anchor.closest("div.group, li") || anchor;

    let link = document.getElementById("be-next-lesson-nav");
    if (!link) {
      link = document.createElement("a");
      link.id = "be-next-lesson-nav";
      link.className = "be-next-lesson-nav";
      link.textContent = "Next Lesson";
    }

    link.setAttribute("href", nextLessonHref);
    if (link.previousElementSibling !== target || link.parentElement !== target.parentElement) {
      target.insertAdjacentElement("afterend", link);
    }
  });
}

function captureNextLessonFromDom() {
  const href = findDashboardContinueHref() || findLessonNextHref();
  if (href) rememberNextLessonHref(href);
}

function findDashboardContinueHref() {
  if (!/^\/dashboard\/?$/.test(location.pathname)) return null;

  const links = Array.from(document.querySelectorAll('a[href^="/lessons/"]'));
  const link = links.find((a) => normalizeText(a.textContent).toLowerCase() === "continue learning");
  return link?.getAttribute("href") || null;
}

function findLessonNextHref() {
  if (!/^\/lessons\//.test(location.pathname)) return null;

  const links = Array.from(document.querySelectorAll('a[href^="/lessons/"]'));
  const currentPath = location.pathname.replace(/\/$/, "");
  const nextLink = links.find((a) => {
    const path = new URL(a.getAttribute("href"), location.origin).pathname.replace(/\/$/, "");
    if (path === currentPath) return false;
    const text = normalizeText(a.textContent).toLowerCase();
    if (text === "next") return true;

    const tooltip = a.closest(".tooltip-box")?.textContent || a.parentElement?.textContent || "";
    return normalizeText(tooltip).toLowerCase().includes("next");
  });

  return nextLink?.getAttribute("href") || null;
}

// ===========================================================================
// FEATURE 4: Boss-event tracker
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
  waitFor(() => document.body).then(() => {
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
          <span class="be-boss-min-title">Boss event - Current Aura: ${fmtPct(s.current)}</span>
          <button id="be-boss-toggle" type="button" title="Expand boss event" aria-label="Expand boss event">+</button>
        </div>`;
      applyBossPanelPosition(panel);
      bindBossPanelControls(panel, s);
      return;
    }

    const deltaToHigh =
      s.eventHigh > 0 ? (s.eventHigh - s.current).toFixed(0) : "0";
    const toNextChest =
      s.nextChestAt > 0 ? Math.max(0, s.nextChestAt - s.damage) : "?";
    const toDefeat =
      s.bossMaxHp > 0 ? Math.max(0, s.bossMaxHp - s.damage) : "?";

    panel.innerHTML = `
      <div class="be-boss-head be-boss-drag-handle">
        <span>Boss event</span>
        <div class="be-boss-actions">
          <button id="be-boss-toggle" type="button" title="Minimize boss event" aria-label="Minimize boss event">-</button>
          <button id="be-boss-reset" type="button" title="Reset stats for a new event">reset</button>
        </div>
      </div>
      <div class="be-boss-grid">
        <div><b>${fmtPct(s.current)}</b><span>current aura</span></div>
        <div><b>${fmtPct(s.eventHigh)}</b><span>event high</span></div>
        <div><b>${fmtPct(s.allTimeHigh)}</b><span>all-time high</span></div>
        <div><b>${deltaToHigh}%</b><span>below event high</span></div>
        <div><b>${fmtNum(s.damage)}</b><span>boss damage</span></div>
        <div><b>${fmtNum(toNextChest)}</b><span>to next chest</span></div>
        <div><b>${fmtNum(toDefeat)}</b><span>to defeat boss</span></div>
        <div><b>${s.lastChestTier ?? "-"} &rarr; ${s.nextChestTier ?? "-"}</b><span>chest tier</span></div>
      </div>
      <div class="be-boss-manual">
        <label>
          <span>Event high %</span>
          <input id="be-boss-event-high" type="number" min="0" step="1" inputmode="numeric" value="${escapeHtml(Math.round(s.eventHigh || 0))}">
        </label>
        <label>
          <span>All-time high %</span>
          <input id="be-boss-alltime-high" type="number" min="0" step="1" inputmode="numeric" value="${escapeHtml(Math.round(s.allTimeHigh || 0))}">
        </label>
        <button id="be-boss-save-highs" type="button">save highs</button>
      </div>`;

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

function toast(text) {
  const t = document.createElement("div");
  t.className = "be-toast";
  t.textContent = text;
  document.body.appendChild(t);
  requestAnimationFrame(() => t.classList.add("be-toast-in"));
  setTimeout(() => {
    t.classList.remove("be-toast-in");
    setTimeout(() => t.remove(), 400);
  }, 6000);
}

async function loadBossUiState() {
  if (bossUiLoaded) return;
  const stored = (await chromeGet(BOSS_UI_KEY)) || {};
  bossUiState = {
    minimized: Boolean(stored.minimized),
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

// ---------------------------------------------------------------------------
// Small helpers
// ---------------------------------------------------------------------------
function isLeaderboardPage() {
  return /^\/leaderboard\/?$/.test(location.pathname);
}

function isProfilePage() {
  return /^\/u\/[^/]+\/?$/.test(location.pathname);
}

function removeAllTimeLeaderboard() {
  document.getElementById("be-alltime-leaderboard")?.remove();
}

function removeProfileXpBadge() {
  document.getElementById("be-total-xp")?.remove();
}

async function loadCachedAllTimeLeaderboard() {
  const stored = (await chromeGet(LEADERBOARD_CACHE_KEY)) || {};
  cachedAllTimeEntries = Array.isArray(stored.entries) ? stored.entries : [];
}

async function loadNextLessonHref() {
  const stored = (await chromeGet(NEXT_LESSON_KEY)) || {};
  nextLessonHref = normalizeLessonHref(stored.href || stored);
}

function getLeaderboardEntries(json) {
  if (Array.isArray(json)) return json;
  if (Array.isArray(json?.Leaderboard)) return json.Leaderboard;
  if (Array.isArray(json?.LeaderboardXP)) return json.LeaderboardXP;
  if (Array.isArray(json?.Entries)) return json.Entries;
  if (Array.isArray(json?.Members)) return json.Members;
  if (Array.isArray(json?.Users)) return json.Users;
  if (Array.isArray(json?.LeagueMembers)) return json.LeagueMembers;
  if (Array.isArray(json?.data)) return json.data;
  if (Array.isArray(json?.data?.Leaderboard)) return json.data.Leaderboard;
  if (Array.isArray(json?.data?.LeaderboardXP)) return json.data.LeaderboardXP;
  if (Array.isArray(json?.data?.Entries)) return json.data.Entries;
  if (Array.isArray(json?.data?.Members)) return json.data.Members;
  if (Array.isArray(json?.data?.Users)) return json.data.Users;
  if (Array.isArray(json?.data?.LeagueMembers)) return json.data.LeagueMembers;
  return [];
}

function isCurrentLeaderboardEntry(entry, currentHandle) {
  if (entry?.IsCurrentUser || entry?.IsSelf || entry?.IsMe) return true;
  if (!currentHandle) return false;
  return getHandle(entry).toLowerCase() === currentHandle.toLowerCase();
}

function getCurrentUserHandle() {
  const profileMatch = /^\/u\/([^/]+)\/?$/.exec(location.pathname);
  const navLink = findCurrentUserProfileLink();
  const href = navLink?.getAttribute("href") || "";
  const navMatch = /^\/u\/([^/]+)\/?$/.exec(href);
  return decodeURIComponent(navMatch?.[1] || profileMatch?.[1] || "");
}

function findCurrentUserProfileLink() {
  const links = Array.from(document.querySelectorAll('a[href^="/u/"]')).filter(isVisible);
  const topLinks = links
    .map((link) => ({ link, rect: link.getBoundingClientRect() }))
    .filter(({ rect }) => rect.top >= 0 && rect.top < 90 && rect.right > window.innerWidth / 2)
    .sort((a, b) => b.rect.right - a.rect.right);

  return topLinks[0]?.link || null;
}

function getLevelProgress(profile) {
  const current = num(profile?.XPForLevel);
  const total = num(profile?.XPTotalForLevel);
  if (current == null || total == null || total <= 0) return null;

  return {
    current,
    total,
    remaining: Math.max(0, total - current),
  };
}

function getHandle(entry) {
  return (
    entry?.Handle ||
    entry?.Username ||
    entry?.UserHandle ||
    entry?.User?.Handle ||
    entry?.User?.Username ||
    ""
  );
}

function normalizeLessonHref(value) {
  if (!value) return null;
  const raw = String(value).trim();
  if (!raw) return null;

  if (/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(raw)) {
    return `/lessons/${raw}`;
  }

  try {
    const parsed = new URL(raw, location.origin);
    if (parsed.origin !== location.origin && parsed.hostname !== "www.boot.dev") return null;
    if (!parsed.pathname.startsWith("/lessons/")) return null;
    return parsed.pathname + parsed.search + parsed.hash;
  } catch (_) {
    return null;
  }
}

function findLessonHrefInData(value, keyPath = []) {
  if (value == null) return null;

  if (typeof value === "string") {
    const lastKey = keyPath[keyPath.length - 1] || "";
    const href = normalizeLessonHref(value);
    if (!href) return null;
    if (value.includes("/lessons/")) return href;
    return /lesson.*(uuid|id)$|^(next|current|continue).*lesson/i.test(lastKey) ? href : null;
  }

  if (Array.isArray(value)) {
    for (const item of value) {
      const href = findLessonHrefInData(item, keyPath);
      if (href) return href;
    }
    return null;
  }

  if (typeof value !== "object") return null;

  const priorityKeys = [
    "ContinueLearningURL",
    "ContinueLearningHref",
    "ContinueLessonURL",
    "ContinueLessonHref",
    "CurrentLessonURL",
    "NextLessonURL",
    "NextLessonHref",
    "LessonURL",
    "LessonHref",
    "ContinueLessonUUID",
    "CurrentLessonUUID",
    "NextLessonUUID",
    "LessonUUID",
  ];

  for (const key of priorityKeys) {
    if (key in value) {
      const href = normalizeLessonHref(value[key]);
      if (href) return href;
    }
  }

  for (const [key, child] of Object.entries(value)) {
    const href = findLessonHrefInData(child, [...keyPath, key]);
    if (href) return href;
  }

  return null;
}

function getDisplayName(entry, handle) {
  return (
    entry?.FirstName ||
    entry?.Name ||
    entry?.DisplayName ||
    entry?.User?.FirstName ||
    entry?.User?.Name ||
    handle ||
    "unknown"
  );
}

function getAvatarUrl(entry) {
  return (
    entry?.ProfileImageURL ||
    entry?.ProfileImageUrl ||
    entry?.ProfilePictureURL ||
    entry?.AvatarURL ||
    entry?.ImageURL ||
    entry?.User?.ProfileImageURL ||
    entry?.User?.ProfileImageUrl ||
    entry?.User?.AvatarURL ||
    ""
  );
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

function num(v) {
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}
function pct(v) {
  const n = num(v);
  if (n == null) return null;
  return n > 0 && n <= 1 ? n * 100 : n;
}
function fmtPct(v) {
  return v == null ? "-" : `${Math.round(v)}%`;
}
function fmtNum(v) {
  return v === "?" || v == null ? "?" : Number(v).toLocaleString();
}
function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, (c) =>
    ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c])
  );
}
function chromeGet(key) {
  return new Promise((res) => chrome.storage.local.get(key, (o) => res(o[key])));
}
function chromeSet(key, val) {
  return new Promise((res) => chrome.storage.local.set({ [key]: val }, res));
}
function findAllTimeLeaderboardInsertionPoint() {
  const globalHeading = findHeadingByText("Global Leaderboards");
  const topCommunity = findHeadingAfter(globalHeading, "Top Community Members");
  if (topCommunity) return topCommunity;

  const dailyHeading = findHeadingAfter(globalHeading, "Top Daily Learners");
  if (dailyHeading?.parentElement) return dailyHeading.parentElement;

  return globalHeading?.parentElement || globalHeading;
}

function findProfileAnchor(profile) {
  const fullName = getProfileFullName(profile);
  return (
    (fullName && findHeadingByText(fullName)) ||
    (profile?.Handle && findElementByText(`@ ${profile.Handle}`)) ||
    (profile?.Handle && findElementByText(`@${profile.Handle}`)) ||
    null
  );
}

function findTopNavInsertionPoint() {
  const desktopCandidates = [
    'nav a[href="/training-grounds"]',
    'nav a[href="/training"]',
    'nav a[href="/courses"]',
    'nav a[href="/dashboard"]',
  ];

  for (const selector of desktopCandidates) {
    const link = Array.from(document.querySelectorAll(selector)).find((el) => {
      const rect = el.getBoundingClientRect();
      return isVisible(el) && rect.top >= 0 && rect.top < 90;
    });
    if (link) return link;
  }

  const mobileMenu = document.getElementById("mobile-menu");
  return mobileMenu?.querySelector('a[href="/training-grounds"], a[href="/training"], a[href="/courses"], a[href="/dashboard"]') || null;
}

function findProfileLevelAnchor(profile) {
  const level = profile?.Level;
  if (level == null) return null;

  const levelText = `Level ${level}`;
  const scope = findProfileSummaryScope(profile) || document;
  return (
    findSmallTextElement(scope, levelText, true) ||
    findSmallTextElement(scope, levelText, false)
  );
}

function findProfileSummaryScope(profile) {
  const fullName = getProfileFullName(profile);
  const levelText = profile?.Level == null ? "" : `Level ${profile.Level}`;
  const handleNeedles = profile?.Handle
    ? [`@ ${profile.Handle}`, `@${profile.Handle}`]
    : [];
  if (!fullName && !handleNeedles.length && !levelText) return null;

  const candidates = Array.from(document.querySelectorAll("main section, main article, main div, #__nuxt section, #__nuxt article, #__nuxt div"))
    .map((el) => ({ el, text: normalizeText(el.textContent) }))
    .filter(({ text }) => {
      if (text.length > 650) return false;
      if (fullName && !text.includes(fullName)) return false;
      if (handleNeedles.length && !handleNeedles.some((handle) => text.includes(handle))) return false;
      if (levelText && !text.includes(levelText)) return false;
      return true;
    })
    .sort((a, b) => a.text.length - b.text.length);

  return candidates[0]?.el || null;
}

function getProfileFullName(profile) {
  return [profile?.FirstName, profile?.LastName]
    .filter(Boolean)
    .join(" ")
    .trim();
}

function findHeadingByText(text) {
  const target = normalizeText(text).toLowerCase();
  return Array.from(document.querySelectorAll("h1,h2,h3,[role='heading']")).find(
    (el) => normalizeText(el.textContent).toLowerCase() === target
  );
}
function findHeadingAfter(anchor, text) {
  const target = normalizeText(text).toLowerCase();
  const headings = Array.from(document.querySelectorAll("h1,h2,h3,[role='heading']"));
  return headings.find((el) => {
    if (normalizeText(el.textContent).toLowerCase() !== target) return false;
    if (!anchor) return true;
    return Boolean(anchor.compareDocumentPosition(el) & Node.DOCUMENT_POSITION_FOLLOWING);
  });
}
function findElementByText(text) {
  const target = normalizeText(text).toLowerCase();
  return Array.from(document.querySelectorAll("main *, #__nuxt *")).find(
    (el) => normalizeText(el.textContent).toLowerCase() === target
  );
}
function findSmallTextElement(root, text, exact) {
  const target = normalizeText(text).toLowerCase();
  return Array.from(root.querySelectorAll("*")).find((el) => {
    if (el.id === "be-total-xp") return false;
    const value = normalizeText(el.textContent);
    if (value.length > 80) return false;
    const lowered = value.toLowerCase();
    return exact ? lowered === target : lowered.includes(target);
  });
}
function normalizeText(s) {
  return String(s || "").replace(/\s+/g, " ").trim();
}
function clamp(value, min, max) {
  const n = Number(value);
  const safeMin = Number.isFinite(min) ? min : 0;
  const safeMax = Math.max(safeMin, Number.isFinite(max) ? max : safeMin);
  if (!Number.isFinite(n)) return safeMin;
  return Math.min(safeMax, Math.max(safeMin, n));
}
function isVisible(el) {
  const rect = el.getBoundingClientRect();
  return rect.width > 0 && rect.height > 0;
}
// Poll for an element/condition (SPA routes render async).
function waitFor(fn, timeout = 8000, interval = 150) {
  return new Promise((resolve) => {
    const start = Date.now();
    const tick = () => {
      const v = fn();
      if (v) return resolve(v);
      if (Date.now() - start > timeout) return resolve(null);
      setTimeout(tick, interval);
    };
    tick();
  });
}
