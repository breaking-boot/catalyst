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
const PERSONAL_HANDLES_KEY = "be_personal_leaderboard_handles";
const PERSONAL_CACHE_KEY = "be_personal_leaderboard_cache";
const BOSS_PROGRESS_URL = "https://api.boot.dev/v1/boss_events_progress";
const ALL_TIME_LEADERBOARD_URL = "https://api.boot.dev/v1/leaderboard_xp/alltime";
const DAILY_LEADERBOARD_URL = "https://api.boot.dev/v1/leaderboard_xp/day";
const DASHBOARD_CONTENT_URL = "https://api.boot.dev/v1/dashboard_content";
const ARCHMAGE_FRAME_URL = "https://www.boot.dev/_nuxt/9.Cmx5X891.png";
const BOSS_REFRESH_MS = 30_000;
const NEAR_HIGH_THRESHOLD = 0.95; // notify when current >= 95% of event high

let bossRefreshTimer = null;
let bossUiState = { minimized: false, settingsOpen: false, x: null, y: null };
let bossUiLoaded = false;
let cachedAllTimeEntries = [];
let nextLessonHref = null;
let nextLessonRefreshRequestedAt = 0;
let personalHandles = [];
let personalRecords = {};
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
    const publicUserMatch = /^\/v1\/users\/public\/([^/]+)(\/stats)?$/.exec(path);

    if (path === "/v1/leaderboard_xp/alltime") {
      handleAllTimeLeaderboard(json);
    } else if (path === "/v1/leaderboard_xp/day") {
      handleDailyXpLeaderboard(json);
    } else if (publicUserMatch) {
      handlePublicUserResponse(decodeURIComponent(publicUserMatch[1]), Boolean(publicUserMatch[2]), json);
    } else if (path === "/v1/boss_events_progress") {
      handleBossProgress(json);
    } else if (path === "/v1/dashboard_content") {
      handleDashboardContent(json);
    } else if (/\/v1\/users\/lessons\/[^/]+$/.test(path) ||
        /\/v1\/course_progress_by_lesson\/[^/]+$/.test(path)) {
      refreshNextLessonFromDashboardSoon();
    }
  } catch (e) {
    console.warn("[Boot.dev Enhancer] routing error", e);
  }
}

async function initEnhancer() {
  await loadBossUiState();
  await loadCachedAllTimeLeaderboard();
  await loadNextLessonHref();
  await loadPersonalLeaderboard();
  restoreBossPanel();
  syncRouteScopedUi();
  resetBossRefreshTimer(true);
  requestApiJson(DASHBOARD_CONTENT_URL);
  bindNextLessonShortcut();
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
    renderPersonalLeaderboards();
    setTimeout(() => requestApiJson(ALL_TIME_LEADERBOARD_URL), 50);
    setTimeout(() => requestPersonalLeaderboardData(), 100);
  } else {
    removeAllTimeLeaderboard();
    removePersonalLeaderboards();
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
    const currentIdentity = getCurrentUserIdentity();
    const visibleEntries = getVisibleAllTimeEntries(entries, currentIdentity);
    const cards = visibleEntries
      .map((e, i) => {
        const handle = getHandle(e);
        const displayName = getDisplayName(e, handle);
        const xp = e.XP ?? e.TotalXP ?? e.XPEarned ?? 0;
        const avatar = getAvatarUrl(e);
        const rank = e.Position ?? e.Rank ?? i + 1;
        const isCurrentUser = isCurrentLeaderboardEntry(e, currentIdentity);
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

function getVisibleAllTimeEntries(entries, currentIdentity = getCurrentUserIdentity()) {
  const top25 = entries.slice(0, 25);
  if (!currentIdentity.handle && !currentIdentity.avatarUrl && !currentIdentity.name) return top25;

  const current = entries.find((entry) => isCurrentLeaderboardEntry(entry, currentIdentity));
  if (!current) return top25;

  const currentRank = num(current.Position ?? current.Rank);
  if (currentRank != null && currentRank > 25) {
    const top24 = entries
      .filter((entry) => !isCurrentLeaderboardEntry(entry, currentIdentity))
      .slice(0, 24);
    return [...top24, current];
  }

  return top25;
}

// ===========================================================================
// FEATURE 2: Cumulative XP on profiles
// ===========================================================================
function handlePublicUserResponse(username, isStats, json) {
  updatePersonalUserData(username, isStats, json);
  if (!isStats) {
    handleProfileStats(json);
  }
}

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
      ? `<div class="be-profile-level-xp">${fmtNum(progress.current)} / ${fmtNum(progress.total)} XP</div>
         <div class="be-profile-remaining-xp">Remaining: <strong>${fmtNum(progress.remaining)} XP</strong></div>`
      : "";
    badge.innerHTML = `<div>Total XP: <strong>${fmtNum(totalXp)}</strong></div>${progressMarkup}`;
    anchor.insertAdjacentElement("afterend", badge);
    if (progress) removeNativeProfileLevelXp(anchor, progress.current);
  });
}

// ===========================================================================
// FEATURE 3: Next Lesson button in the top navigation
// ===========================================================================
function handleDashboardContent(json) {
  const href = getDashboardLessonHref(json);
  if (href) rememberNextLessonHref(href);
}

function refreshNextLessonFromDashboardSoon() {
  const now = Date.now();
  if (now - nextLessonRefreshRequestedAt < 1200) return;
  nextLessonRefreshRequestedAt = now;
  setTimeout(() => requestApiJson(DASHBOARD_CONTENT_URL), 700);
  setTimeout(() => requestApiJson(DASHBOARD_CONTENT_URL), 3000);
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
    link.setAttribute("title", "Next Lesson (Alt+N)");
    link.setAttribute("aria-label", "Next Lesson (Alt+N)");
    if (link.previousElementSibling !== target || link.parentElement !== target.parentElement) {
      target.insertAdjacentElement("afterend", link);
    }
  });
}

function captureNextLessonFromDom() {
  const dashboardHref = findDashboardContinueHref();
  if (dashboardHref) {
    rememberNextLessonHref(dashboardHref);
    return;
  }

  if (!nextLessonHref) {
    const lessonHref = findLessonNextHref();
    if (lessonHref) rememberNextLessonHref(lessonHref);
  }
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
    const tooltipText = normalizeText(tooltip).toLowerCase();
    return tooltipText.includes("next") && (a.querySelector(".sr-only") || a.querySelector("svg"));
  });

  return nextLink?.getAttribute("href") || null;
}

function getDashboardLessonHref(json) {
  const data = json?.data ?? json;
  const explicit = normalizeLessonHref(data?.CurrentLessonUUID);
  if (explicit) return explicit;

  const incomplete = findFirstIncompleteLesson(data?.CurrentCourseProgress);
  if (incomplete?.UUID) return normalizeLessonHref(incomplete.UUID);

  const courseLesson = findFirstIncompleteLesson(data?.CurrentCourse);
  if (courseLesson?.UUID) return normalizeLessonHref(courseLesson.UUID);

  return null;
}

function findFirstIncompleteLesson(progress) {
  const chapters = Array.isArray(progress?.Chapters) ? progress.Chapters : [];
  for (const chapter of chapters) {
    const lessons = Array.isArray(chapter?.Lessons) ? chapter.Lessons : [];
    const lesson = lessons.find((l) => l?.IsRequired !== false && l?.IsComplete === false && l?.IsReset !== true);
    if (lesson) return lesson;
  }
  return null;
}

function bindNextLessonShortcut() {
  document.addEventListener("keydown", (event) => {
    if (!nextLessonHref || !event.altKey || event.ctrlKey || event.metaKey || event.shiftKey) return;
    if (event.key.toLowerCase() !== "n") return;
    if (isEditableTarget(event.target)) return;

    event.preventDefault();
    location.href = nextLessonHref;
  });
}

// ===========================================================================
// FEATURE 4: Manual personal leaderboards
// ===========================================================================
function handleDailyXpLeaderboard(json) {
  const entries = getLeaderboardEntries(json);
  let changed = false;

  for (const entry of entries) {
    const handle = normalizeHandle(getHandle(entry));
    if (!handle || !isPersonalHandle(handle)) continue;

    const dailyXp = num(entry?.XPEarned ?? entry?.XP ?? entry?.TotalXP);
    if (dailyXp == null) continue;

    const record = ensurePersonalRecord(handle);
    record.dailyXp = dailyXp;
    record.updatedAt = Date.now();
    changed = true;
  }

  if (changed) {
    savePersonalCache();
    renderPersonalLeaderboards();
  }
}

function updatePersonalUserData(username, isStats, json) {
  const requestedHandle = normalizeHandle(username);
  const data = json?.data ?? json;
  const responseHandle = normalizeHandle(data?.Handle);
  const handle = isPersonalHandle(responseHandle) ? responseHandle : requestedHandle;
  if (!handle || !isPersonalHandle(handle)) return;

  const record = ensurePersonalRecord(handle);
  record.handle = data?.Handle || record.handle || handle;
  if (isStats) {
    record.stats = data;
  } else {
    record.profile = data;
    updateObservedDailyXp(record, data);
  }
  record.updatedAt = Date.now();

  savePersonalCache();
  renderPersonalLeaderboards();
}

async function loadPersonalLeaderboard() {
  const storedHandles = (await chromeGet(PERSONAL_HANDLES_KEY)) || {};
  const storedCache = (await chromeGet(PERSONAL_CACHE_KEY)) || {};
  const rawHandles = Array.isArray(storedHandles)
    ? storedHandles
    : Array.isArray(storedHandles.handles)
      ? storedHandles.handles
      : [];

  personalHandles = uniqueHandles(rawHandles);
  personalRecords = isPlainObject(storedCache.records) ? storedCache.records : {};
  for (const handle of personalHandles) ensurePersonalRecord(handle);
}

function requestPersonalLeaderboardData() {
  if (!isLeaderboardPage() || !personalHandles.length) return;

  requestApiJson(DAILY_LEADERBOARD_URL);
  for (const handle of personalHandles) {
    requestApiJson(`https://api.boot.dev/v1/users/public/${encodeURIComponent(handle)}`);
    requestApiJson(`https://api.boot.dev/v1/users/public/${encodeURIComponent(handle)}/stats`);
  }
}

function renderPersonalLeaderboards() {
  if (!isLeaderboardPage()) return;

  waitFor(() => document.getElementById("be-alltime-leaderboard") || findAllTimeLeaderboardInsertionPoint() || document.querySelector("main") || document.body).then((host) => {
    if (!isLeaderboardPage()) return;

    let panel = document.getElementById("be-personal-leaderboards");
    if (!panel) {
      panel = document.createElement("section");
      panel.id = "be-personal-leaderboards";
      panel.className = "be-personal-leaderboards";
    }

    const allTime = document.getElementById("be-alltime-leaderboard");
    if (allTime && panel.previousElementSibling !== allTime) {
      allTime.insertAdjacentElement("afterend", panel);
    } else if (!panel.parentElement) {
      if (host?.matches?.("h1,h2,h3,[role='heading']")) {
        host.insertAdjacentElement("beforebegin", panel);
      } else if (host?.parentElement && !["MAIN", "BODY"].includes(host.tagName)) {
        host.insertAdjacentElement("afterend", panel);
      } else {
        (host || document.body).append(panel);
      }
    }

    const chips = personalHandles
      .map((handle) => `<button type="button" class="be-personal-chip" data-be-remove-handle="${escapeHtml(handle)}">@${escapeHtml(getPersonalDisplayHandle(handle))}<span aria-hidden="true">&times;</span></button>`)
      .join("");

    panel.innerHTML = `
      <h3 class="be-native-title">Personal Leaderboards</h3>
      <div class="be-personal-shell">
        <form id="be-personal-form" class="be-personal-form">
          <input id="be-personal-handle" type="text" autocomplete="off" spellcheck="false" placeholder="boot.dev handle or profile URL" aria-label="boot.dev handle or profile URL">
          <button type="submit">Add</button>
        </form>
        <div class="be-personal-chips">${chips || '<span class="be-personal-empty">Add handles to compare friends, guild members, or rivals.</span>'}</div>
        <div class="be-personal-grid">
          ${renderPersonalBoard("Top Daily Learners", getPersonalRows("daily"), "xp today")}
          ${renderPersonalBoard("Top All-Time Learners", getPersonalRows("xp"), "xp")}
          ${renderPersonalBoard("Top Community Members", getPersonalRows("karma"), "karma")}
        </div>
      </div>`;

    bindPersonalLeaderboardControls(panel);
  });
}

function renderPersonalBoard(title, rows, unit) {
  const body = rows.length
    ? rows.map((row, index) => renderPersonalRow(row, index + 1, unit)).join("")
    : '<div class="be-personal-board-empty">No handles added yet.</div>';

  return `
    <section class="be-personal-board">
      <h4>${escapeHtml(title)}</h4>
      <div class="be-personal-rows">${body}</div>
    </section>`;
}

function renderPersonalRow(row, rank, unit) {
  const avatar = row.avatar
    ? `<img src="${escapeHtml(row.avatar)}" alt="${escapeHtml(row.name)} avatar">`
    : `<span>${escapeHtml(row.name.slice(0, 1).toUpperCase() || "?")}</span>`;
  const value = row.value == null ? "loading" : `${fmtNum(row.value)} ${unit}`;

  return `
    <a class="be-personal-row" href="/u/${encodeURIComponent(row.handle)}">
      <span class="be-personal-rank">${rank}</span>
      <span class="be-personal-avatar">${avatar}</span>
      <span class="be-personal-copy">
        <span class="be-personal-name">${escapeHtml(row.name)}</span>
        <span class="be-personal-handle">@${escapeHtml(row.displayHandle)}</span>
      </span>
      <span class="be-personal-value">${escapeHtml(value)}</span>
    </a>`;
}

function bindPersonalLeaderboardControls(panel) {
  const form = panel.querySelector("#be-personal-form");
  const input = panel.querySelector("#be-personal-handle");
  if (form && input) {
    form.onsubmit = (event) => {
      event.preventDefault();
      const handle = normalizeHandle(input.value);
      if (!handle) return;
      input.value = "";
      addPersonalHandle(handle);
    };
  }

  panel.querySelectorAll("[data-be-remove-handle]").forEach((button) => {
    button.onclick = () => removePersonalHandle(button.getAttribute("data-be-remove-handle"));
  });
}

async function addPersonalHandle(handle) {
  const normalized = normalizeHandle(handle);
  if (!normalized || isPersonalHandle(normalized)) return;

  personalHandles = uniqueHandles([...personalHandles, normalized]);
  ensurePersonalRecord(normalized);
  await savePersonalHandles();
  savePersonalCache();
  renderPersonalLeaderboards();
  requestPersonalLeaderboardData();
}

async function removePersonalHandle(handle) {
  const normalized = normalizeHandle(handle);
  if (!normalized) return;

  personalHandles = personalHandles.filter((h) => h !== normalized);
  delete personalRecords[normalized];
  await savePersonalHandles();
  savePersonalCache();
  renderPersonalLeaderboards();
}

function getPersonalRows(kind) {
  return personalHandles
    .map((handle) => {
      const record = ensurePersonalRecord(handle);
      const profile = record.profile || {};
      const value = getPersonalValue(record, kind);
      return {
        handle,
        displayHandle: getPersonalDisplayHandle(handle),
        name: getDisplayName(profile, getPersonalDisplayHandle(handle)),
        avatar: getAvatarUrl(profile),
        value,
      };
    })
    .sort((a, b) => (b.value ?? -1) - (a.value ?? -1) || a.displayHandle.localeCompare(b.displayHandle));
}

function getPersonalValue(record, kind) {
  if (kind === "daily") return record.dailyXp ?? record.dailyObservedXp ?? null;
  if (kind === "karma") return num(record.stats?.Karma ?? record.profile?.Karma);
  return num(record.profile?.XP);
}

function updateObservedDailyXp(record, profile) {
  const xp = num(profile?.XP);
  if (xp == null) return;

  const today = localDateKey();
  if (record.dailyBaselineDate !== today || record.dailyBaselineXp == null || record.dailyBaselineXp > xp) {
    record.dailyBaselineDate = today;
    record.dailyBaselineXp = xp;
    record.dailyObservedXp = 0;
    return;
  }

  record.dailyObservedXp = Math.max(record.dailyObservedXp || 0, xp - record.dailyBaselineXp);
}

function ensurePersonalRecord(handle) {
  const normalized = normalizeHandle(handle);
  if (!normalized) return {};

  if (!isPlainObject(personalRecords[normalized])) {
    personalRecords[normalized] = { handle: normalized };
  }
  return personalRecords[normalized];
}

function getPersonalDisplayHandle(handle) {
  const record = personalRecords[normalizeHandle(handle)] || {};
  return record.handle || handle;
}

function isPersonalHandle(handle) {
  return personalHandles.includes(normalizeHandle(handle));
}

function uniqueHandles(handles) {
  return Array.from(new Set(handles.map(normalizeHandle).filter(Boolean)));
}

async function savePersonalHandles() {
  await chromeSet(PERSONAL_HANDLES_KEY, { handles: personalHandles });
}

function savePersonalCache() {
  chromeSet(PERSONAL_CACHE_KEY, { records: personalRecords, updatedAt: Date.now() });
}

function removePersonalLeaderboards() {
  document.getElementById("be-personal-leaderboards")?.remove();
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
    const settingsMarkup = bossUiState.settingsOpen
      ? `<div class="be-boss-manual">
          <label>
            <span>Event high %</span>
            <input id="be-boss-event-high" type="number" min="0" step="1" inputmode="numeric" value="${escapeHtml(Math.round(s.eventHigh || 0))}">
          </label>
          <label>
            <span>All-time high %</span>
            <input id="be-boss-alltime-high" type="number" min="0" step="1" inputmode="numeric" value="${escapeHtml(Math.round(s.allTimeHigh || 0))}">
          </label>
          <button id="be-boss-save-highs" type="button">save highs</button>
        </div>`
      : "";

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
      <div class="be-boss-settings-row">
        <button id="be-boss-settings-toggle" type="button" aria-expanded="${bossUiState.settingsOpen ? "true" : "false"}" title="Toggle boss high settings">
          <span aria-hidden="true">&#9881;</span>
          <span>High settings</span>
        </button>
      </div>
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
      await saveBossUiState({ settingsOpen: !bossUiState.settingsOpen });
      renderBossPanel(state);
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

function removeNativeProfileLevelXp(anchor, currentXp) {
  const target = `${fmtNum(currentXp)} XP`.toLowerCase();
  const scope = findProfileSummaryScope({}) || anchor.parentElement || document;
  const duplicate = Array.from(scope.querySelectorAll("*"))
    .filter((el) => !el.closest("#be-total-xp"))
    .map((el) => ({ el, text: normalizeText(el.textContent).toLowerCase() }))
    .filter(({ text }) => text === target)
    .sort((a, b) => a.el.children.length - b.el.children.length)[0]?.el;

  duplicate?.remove();
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

function isCurrentLeaderboardEntry(entry, currentIdentity) {
  if (entry?.IsCurrentUser || entry?.IsSelf || entry?.IsMe) return true;

  const identity = typeof currentIdentity === "string"
    ? { handle: currentIdentity }
    : currentIdentity || {};
  const handle = normalizeHandle(identity.handle);
  if (handle && normalizeHandle(getHandle(entry)) === handle) return true;

  const identityAvatar = normalizeImageUrl(identity.avatarUrl);
  const entryAvatar = normalizeImageUrl(getAvatarUrl(entry));
  if (identityAvatar && entryAvatar && identityAvatar === entryAvatar) return true;

  return false;
}

function getCurrentUserIdentity() {
  const navLink = findCurrentUserProfileLink();
  return {
    handle: getCurrentUserHandle(navLink),
    avatarUrl: getCurrentUserAvatarUrl(navLink),
    name: getCurrentUserDisplayName(navLink),
  };
}

function getCurrentUserHandle(navLink = findCurrentUserProfileLink()) {
  const profileMatch = /^\/u\/([^/]+)\/?$/.exec(location.pathname);
  const href = navLink?.getAttribute("href") || "";
  const navMatch = /^\/u\/([^/]+)\/?$/.exec(href);
  return decodeURIComponent(navMatch?.[1] || profileMatch?.[1] || "");
}

function getCurrentUserAvatarUrl(navLink) {
  const img = navLink?.querySelector?.("img[src]") || findTopNavAvatarImage();
  return img?.currentSrc || img?.src || img?.getAttribute?.("src") || "";
}

function getCurrentUserDisplayName(navLink) {
  const text = normalizeText(navLink?.textContent || "");
  return text
    .replace(/\bLevel\s+\d+\b/gi, "")
    .replace(/\bArchmage\b/gi, "")
    .trim();
}

function findCurrentUserProfileLink() {
  const links = Array.from(document.querySelectorAll('a[href^="/u/"]')).filter(isVisible);
  const topLinks = links
    .map((link) => ({ link, rect: link.getBoundingClientRect() }))
    .filter(({ rect }) => rect.top >= 0 && rect.top < 90 && rect.right > window.innerWidth / 2)
    .sort((a, b) => b.rect.right - a.rect.right);

  return topLinks[0]?.link || null;
}

function findTopNavAvatarImage() {
  const images = Array.from(document.querySelectorAll("img[src]"))
    .filter(isVisible)
    .map((img) => ({ img, rect: img.getBoundingClientRect(), src: img.currentSrc || img.src || img.getAttribute("src") || "" }))
    .filter(({ rect, src }) => {
      if (rect.top < 0 || rect.top > 90 || rect.right < window.innerWidth / 2) return false;
      return !/bootdev-logo|\/_nuxt\/9\.|role|frame/i.test(src);
    })
    .sort((a, b) => b.rect.right - a.rect.right);

  return images[0]?.img || null;
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

function normalizeHandle(value) {
  const raw = String(value || "")
    .trim()
    .replace(/^https?:\/\/(?:www\.)?boot\.dev\/u\//i, "")
    .replace(/^\/u\//i, "")
    .replace(/^@/, "");
  return raw.split(/[/?#\s]/)[0].toLowerCase();
}

function normalizeImageUrl(value) {
  if (!value) return "";
  try {
    const parsed = new URL(value, location.origin);
    return `${parsed.origin}${parsed.pathname}`;
  } catch (_) {
    return String(value).split("?")[0];
  }
}

function isPlainObject(value) {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function localDateKey() {
  return new Date().toLocaleDateString("en-CA");
}

function isEditableTarget(target) {
  if (!(target instanceof Element)) return false;
  return Boolean(target.closest("input, textarea, select, [contenteditable=''], [contenteditable='true']"));
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
