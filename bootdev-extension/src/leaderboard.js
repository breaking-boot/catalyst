// leaderboard.js
// All-time XP leaderboard injection and personal leaderboard feature.
// Handles: handleAllTimeLeaderboard, personal leaderboard UI and storage.

const LEADERBOARD_CACHE_KEY = "be_alltime_leaderboard_cache";
const ALL_TIME_LEADERBOARD_URL = "https://api.boot.dev/v1/leaderboard_xp/alltime";
const DAILY_LEADERBOARD_URL = "https://api.boot.dev/v1/leaderboard_xp/day";
const PERSONAL_HANDLES_KEY = "be_personal_leaderboard_handles";
const PERSONAL_CACHE_KEY = "be_personal_leaderboard_cache";
const CURRENT_USER_HANDLE_KEY = "be_current_user_handle";
const ROLE_FRAME_URLS = [
  "https://www.boot.dev/_nuxt/0.B6ueYVE9.png",
  "https://www.boot.dev/_nuxt/1.DnmxFjr3.png",
  "https://www.boot.dev/_nuxt/2.Cijf5c5Q.png",
  "https://www.boot.dev/_nuxt/3.CikePfbF.png",
  "https://www.boot.dev/_nuxt/4.B5xh_zDj.png",
  "https://www.boot.dev/_nuxt/5.0Do8PVSr.png",
  "https://www.boot.dev/_nuxt/6.4Va-k18V.png",
  "https://www.boot.dev/_nuxt/7.BsonWGZg.png",
  "https://www.boot.dev/_nuxt/8.CJ6g5ANN.png",
  "https://www.boot.dev/_nuxt/9.Cmx5X891.png",
];
const ARCHMAGE_FRAME_URL = ROLE_FRAME_URLS[9];
const ROLE_FRAME_INDEX_BY_ROLE = {
  apprentice: 0,
  pupil: 1,
  acolyte: 2,
  disciple: 3,
  scholar: 4,
  sorcerer: 5,
  sage: 6,
  archsage: 7,
  mage: 8,
  archmage: 9,
};

let cachedAllTimeEntries = [];
let personalHandles = [];
let personalRecords = {};
let personalFeedback = null;
let personalPendingHandle = null;
let currentUserHandle = "";

// ---------------------------------------------------------------------------
// Page detection
// ---------------------------------------------------------------------------
function isLeaderboardPage() {
  return /^\/leaderboard\/?$/.test(location.pathname);
}

// ---------------------------------------------------------------------------
// Entry field accessors
// ---------------------------------------------------------------------------
function getHandle(entry) {
  return (
    entry?.handle ||
    entry?.Handle ||
    entry?.Username ||
    entry?.UserHandle ||
    entry?.User?.Handle ||
    entry?.User?.Username ||
    ""
  );
}

function getDisplayName(entry, handle) {
  return (
    entry?.name ||
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
    entry?.avatar ||
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

function getRoleFrameUrl(entry) {
  return (
    getExplicitFrameUrl(entry) ||
    ROLE_FRAME_URLS[getRoleFrameIndex(entry)] ||
    ""
  );
}

function getExplicitFrameUrl(entry) {
  const url = (
    entry?.RoleFrameURL ||
    entry?.RoleImageURL ||
    entry?.RankFrameURL ||
    entry?.RankImageURL ||
    entry?.AvatarFrameURL ||
    entry?.FrameURL ||
    entry?.User?.RoleFrameURL ||
    entry?.User?.RoleImageURL ||
    entry?.User?.RankFrameURL ||
    entry?.User?.RankImageURL ||
    entry?.User?.AvatarFrameURL ||
    entry?.User?.FrameURL ||
    ""
  );
  return normalizeAssetUrl(url);
}

function getRoleFrameIndex(entry) {
  const role = normalizeText(entry?.Role || entry?.User?.Role)
    .toLowerCase()
    .replace(/[\s_-]+/g, "");
  if (ROLE_FRAME_INDEX_BY_ROLE[role] != null) return ROLE_FRAME_INDEX_BY_ROLE[role];

  const level = num(entry?.Level ?? entry?.User?.Level);
  if (level != null) {
    const idx = Math.floor(level / 10) - 1;
    if (idx < 0) return -1;
    return Math.min(idx, ROLE_FRAME_URLS.length - 1);
  }

  return -1;
}

// ---------------------------------------------------------------------------
// Leaderboard entry helpers
// ---------------------------------------------------------------------------
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

  return false;
}

// ---------------------------------------------------------------------------
// Current user identity
// ---------------------------------------------------------------------------
function getCurrentUserIdentity() {
  const navLink = findCurrentUserProfileLink();
  return {
    handle: getCurrentUserHandle(navLink),
    name: getCurrentUserDisplayName(navLink),
  };
}

function getCurrentUserHandle(navLink = findCurrentUserProfileLink()) {
  const navHandle = getProfileHandleFromHref(navLink?.getAttribute("href"));
  const nativeHandle = isLeaderboardPage() ? findNativeCurrentUserHandle() : "";
  return normalizeHandle(navHandle || nativeHandle || currentUserHandle);
}

function getCurrentUserDisplayName(navLink) {
  const text = normalizeText(navLink?.textContent || "");
  return text
    .replace(/\bLevel\s+\d+\b/gi, "")
    .replace(/\bArchmage\b/gi, "")
    .trim();
}

function findCurrentUserProfileLink() {
  const links = Array.from(document.querySelectorAll('a[href^="/u/"]'))
    .filter((link) => isVisible(link) && !link.closest("main, #be-alltime-leaderboard, #be-personal-leaderboards"));
  const topLinks = links
    .map((link) => ({ link, rect: link.getBoundingClientRect() }))
    .filter(({ rect }) => rect.top >= 0 && rect.top < 90 && rect.right > window.innerWidth / 2)
    .sort((a, b) => b.rect.right - a.rect.right);

  return topLinks[0]?.link || null;
}

function getProfileHandleFromHref(href) {
  if (!href) return "";
  try {
    const parsed = new URL(href, location.origin);
    const match = /^\/u\/([^/]+)\/?$/.exec(parsed.pathname);
    return normalizeHandle(match?.[1] ? decodeURIComponent(match[1]) : "");
  } catch (_) {
    const match = /^\/u\/([^/]+)\/?$/.exec(String(href));
    return normalizeHandle(match?.[1] ? decodeURIComponent(match[1]) : "");
  }
}

function findNativeCurrentUserHandle() {
  const highlightedCards = Array.from(document.querySelectorAll(".box-shadow-glow-gold"))
    .filter((el) => isVisible(el) && !el.closest("#be-alltime-leaderboard, #be-personal-leaderboards"));

  for (const card of highlightedCards) {
    const handle = getProfileHandleFromHref(card.querySelector('a[href^="/u/"]')?.getAttribute("href"));
    if (handle) return handle;
  }

  return "";
}

async function loadCurrentUserHandle() {
  const stored = (await chromeGet(CURRENT_USER_HANDLE_KEY)) || {};
  if (enhancerStopped) return;
  currentUserHandle = normalizeHandle(stored.handle || stored);
}

async function rememberCurrentUserHandle(handle) {
  const normalized = normalizeHandle(handle);
  if (!isValidHandle(normalized) || normalized === currentUserHandle) return;

  currentUserHandle = normalized;
  await chromeSet(CURRENT_USER_HANDLE_KEY, { handle: normalized, updatedAt: Date.now() });
  if (!isLeaderboardPage()) return;

  if (cachedAllTimeEntries.length) renderAllTimeLeaderboard(cachedAllTimeEntries);
  renderPersonalLeaderboards();
}

function learnCurrentUserHandleFromDom() {
  const navHandle = getProfileHandleFromHref(findCurrentUserProfileLink()?.getAttribute("href"));
  const nativeHandle = isLeaderboardPage() ? findNativeCurrentUserHandle() : "";
  const handle = normalizeHandle(navHandle || nativeHandle);
  if (handle) void rememberCurrentUserHandle(handle);
}

// ---------------------------------------------------------------------------
// All-time leaderboard cache
// ---------------------------------------------------------------------------
async function loadCachedAllTimeLeaderboard() {
  const stored = (await chromeGet(LEADERBOARD_CACHE_KEY)) || {};
  if (enhancerStopped) return;
  cachedAllTimeEntries = Array.isArray(stored.entries) ? stored.entries : [];
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
        const rank = e.Position ?? e.Rank ?? i + 1;
        const isCurrentUser = isCurrentLeaderboardEntry(e, currentIdentity);
        const href = handle ? `/u/${encodeURIComponent(handle)}` : "#";

        return `<div class="be-leader-card${isCurrentUser ? " be-current-user" : ""}">
            <a href="${href}" class="be-leader-link">
              <span class="be-leader-rank">${escapeHtml(rank)}</span>
              ${renderLeaderAvatar(e, displayName)}
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
  if (!normalizeHandle(currentIdentity.handle)) return top25;

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

function renderLeaderAvatar(entry, displayName) {
  const avatar = getAvatarUrl(entry);
  const frameUrl = getRoleFrameUrl(entry);
  const name = displayName || getDisplayName(entry, getHandle(entry));
  const avatarMarkup = avatar
    ? `<img src="${escapeHtml(avatar)}" alt="${escapeHtml(name)} avatar" class="be-leader-avatar-img">`
    : `<span class="be-leader-avatar-fallback">${escapeHtml(name.slice(0, 1).toUpperCase() || "?")}</span>`;

  const frameMarkup = frameUrl
    ? `<img src="${escapeHtml(frameUrl)}" alt="" class="be-leader-frame" aria-hidden="true">`
    : "";

  return `<span class="be-leader-avatar">
    <span class="be-leader-avatar-inner">${avatarMarkup}</span>
    ${frameMarkup}
  </span>`;
}

function ensureLeaderboardUiState() {
  if (!isLeaderboardPage()) return;

  const allTime = document.getElementById("be-alltime-leaderboard");
  const personal = document.getElementById("be-personal-leaderboards");
  const currentIdentity = getCurrentUserIdentity();

  if (allTime && cachedAllTimeEntries.some((entry) => isCurrentLeaderboardEntry(entry, currentIdentity)) &&
      !allTime.querySelector(".be-current-user")) {
    renderAllTimeLeaderboard(cachedAllTimeEntries);
    return;
  }

  if (!allTime) return;

  if (!personal) {
    renderPersonalLeaderboards();
    return;
  }

  // Reposition without re-rendering if boot.dev inserted elements between the panels.
  const isAfterAllTime = !!(allTime.compareDocumentPosition(personal) & Node.DOCUMENT_POSITION_FOLLOWING);
  if (!isAfterAllTime) allTime.insertAdjacentElement("afterend", personal);

  if (personalHandles.some((handle) => isCurrentLeaderboardEntry({ handle }, currentIdentity)) &&
      !personal.querySelector(".be-current-user")) {
    renderPersonalLeaderboards();
  }
}

function removeAllTimeLeaderboard() {
  document.getElementById("be-alltime-leaderboard")?.remove();
}

function findAllTimeLeaderboardInsertionPoint() {
  const globalHeading = findHeadingByText("Global Leaderboards");
  const topCommunity = findHeadingAfter(globalHeading, "Top Community Members");
  if (topCommunity) return topCommunity;

  const dailyHeading = findHeadingAfter(globalHeading, "Top Daily Learners");
  if (dailyHeading?.parentElement) return dailyHeading.parentElement;

  return globalHeading?.parentElement || globalHeading;
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
  if (enhancerStopped) return;
  const rawHandles = Array.isArray(storedHandles)
    ? storedHandles
    : Array.isArray(storedHandles.handles)
      ? storedHandles.handles
      : [];

  personalHandles = uniqueHandles(rawHandles).filter(isValidHandle);
  personalRecords = isPlainObject(storedCache.records) ? storedCache.records : {};
  for (const handle of personalHandles) ensurePersonalRecord(handle);
  if (personalHandles.length !== rawHandles.length) {
    savePersonalHandles();
    savePersonalCache();
  }
}

function requestPersonalLeaderboardData() {
  if (!isLeaderboardPage() || !personalHandles.length) return;

  requestApiJson(DAILY_LEADERBOARD_URL);
  for (const handle of personalHandles) {
    void refreshPersonalHandle(handle);
  }
}

function renderPersonalLeaderboards() {
  if (!isLeaderboardPage()) return;

  waitFor(() => document.getElementById("be-alltime-leaderboard"), 10000).then((allTime) => {
    if (!isLeaderboardPage()) return;
    if (!allTime) return;

    let panel = document.getElementById("be-personal-leaderboards");
    if (!panel) {
      panel = document.createElement("section");
      panel.id = "be-personal-leaderboards";
      panel.className = "be-personal-leaderboards";
    }

    if (allTime && panel.previousElementSibling !== allTime) {
      allTime.insertAdjacentElement("afterend", panel);
    }

    // Save input state so background data refreshes don't clear a user's typing.
    const prevInput = panel.querySelector("#be-personal-handle");
    const savedInputValue = prevInput ? prevInput.value : "";
    const inputWasFocused = prevInput !== null && prevInput === document.activeElement;

    const chips = personalHandles
      .map((handle) => `<button type="button" class="be-personal-chip" data-be-remove-handle="${escapeHtml(handle)}">@${escapeHtml(getPersonalDisplayHandle(handle))}<span aria-hidden="true">&times;</span></button>`)
      .join("");
    const messageMarkup = personalFeedback?.text
      ? `<div class="be-personal-message be-personal-message-${escapeHtml(personalFeedback.type || "info")}">${escapeHtml(personalFeedback.text)}</div>`
      : "";
    const pendingMarkup = personalPendingHandle
      ? `<div class="be-personal-message be-personal-message-info">Checking @${escapeHtml(personalPendingHandle)}...</div>`
      : "";

    panel.innerHTML = `
      <h3 class="be-native-title">Personal Leaderboards</h3>
      <div class="be-personal-shell">
        <form id="be-personal-form" class="be-personal-form">
          <input id="be-personal-handle" type="text" autocomplete="off" spellcheck="false" placeholder="boot.dev handle or profile URL" aria-label="boot.dev handle or profile URL">
          <button type="submit">Add</button>
        </form>
        ${messageMarkup || pendingMarkup}
        <div class="be-personal-chips">${chips || '<span class="be-personal-empty">Add handles to compare friends, guild members, or rivals.</span>'}</div>
        <div class="be-personal-grid">
          ${renderPersonalBoard("Top Daily Learners", getPersonalRows("daily"), "xp today")}
          ${renderPersonalBoard("Top All-Time Learners", getPersonalRows("xp"), "xp")}
          ${renderPersonalBoard("Top Community Members", getPersonalRows("karma"), "karma")}
        </div>
      </div>`;

    // Restore input state after innerHTML replacement.
    if (savedInputValue || inputWasFocused) {
      const newInput = panel.querySelector("#be-personal-handle");
      if (newInput) {
        if (savedInputValue) newInput.value = savedInputValue;
        if (inputWasFocused) newInput.focus();
      }
    }

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
  const value = row.value == null
    ? row.loading ? "loading" : "unavailable"
    : `${fmtNum(row.value)} ${unit}`;
  const isCurrentUser = isCurrentLeaderboardEntry(row, getCurrentUserIdentity());

  return `
    <a class="be-personal-row${isCurrentUser ? " be-current-user" : ""}" href="/u/${encodeURIComponent(row.handle)}">
      <span class="be-personal-rank">${rank}</span>
      ${renderLeaderAvatar(row, row.name)}
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
      const parsed = parsePersonalHandleInput(input.value);
      if (parsed.error) {
        setPersonalFeedback(parsed.error, "error");
        return;
      }
      if (isPersonalHandle(parsed.handle)) {
        setPersonalFeedback("User already added", "error");
        return;
      }
      input.value = "";
      addPersonalHandle(parsed.handle);
    };
  }

  panel.querySelectorAll("[data-be-remove-handle]").forEach((button) => {
    button.onclick = () => removePersonalHandle(button.getAttribute("data-be-remove-handle"));
  });
}

async function addPersonalHandle(handle) {
  const normalized = normalizeHandle(handle);
  if (!isValidHandle(normalized)) {
    setPersonalFeedback("Invalid username", "error");
    return;
  }
  if (isPersonalHandle(normalized)) {
    setPersonalFeedback("User already added", "error");
    return;
  }

  clearPersonalFeedback();
  personalPendingHandle = normalized;
  renderPersonalLeaderboards();

  const profile = await loadPublicUserProfile(normalized);
  if (!profile) {
    personalPendingHandle = null;
    renderPersonalLeaderboards();
    return;
  }

  const canonical = normalizeHandle(profile.Handle || normalized);
  if (!isValidHandle(canonical)) {
    personalPendingHandle = null;
    setPersonalFeedback("Invalid username", "error");
    return;
  }
  if (isPersonalHandle(canonical)) {
    personalPendingHandle = null;
    setPersonalFeedback("User already added", "error");
    return;
  }

  personalHandles = uniqueHandles([...personalHandles, canonical]);
  const record = ensurePersonalRecord(canonical);
  record.handle = profile.Handle || canonical;
  record.profile = profile;
  record.profileError = null;
  updateObservedDailyXp(record, profile);

  if (await savePersonalHandles()) {
    savePersonalCache();
    setPersonalFeedback(`Added @${record.handle}`, "success");
  } else {
    setPersonalFeedback("Could not save user", "error");
  }

  personalPendingHandle = null;
  renderPersonalLeaderboards();
  void refreshPersonalStats(canonical);
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
        Handle: record.handle || handle,
        Level: profile.Level,
        Role: profile.Role,
        value,
        loading: personalPendingHandle === handle,
      };
    })
    .sort((a, b) => (b.value ?? -1) - (a.value ?? -1) || a.displayHandle.localeCompare(b.displayHandle));
}

function getPersonalValue(record, kind) {
  if (kind === "daily") return record.dailyXp ?? record.dailyObservedXp ?? null;
  if (kind === "karma") return num(record.stats?.Karma ?? record.profile?.Karma);
  return num(record.profile?.XP);
}

async function refreshPersonalHandle(handle) {
  const normalized = normalizeHandle(handle);
  if (!isValidHandle(normalized) || !isPersonalHandle(normalized)) return;

  const profile = await loadPublicUserProfile(normalized, { removeMissing: true });
  if (!profile || !isPersonalHandle(normalized)) return;

  const record = ensurePersonalRecord(normalized);
  record.handle = profile.Handle || record.handle || normalized;
  record.profile = profile;
  record.profileError = null;
  updateObservedDailyXp(record, profile);
  savePersonalCache();
  renderPersonalLeaderboards();

  await refreshPersonalStats(normalized);
}

async function refreshPersonalStats(handle) {
  const normalized = normalizeHandle(handle);
  if (!isValidHandle(normalized) || !isPersonalHandle(normalized)) return;

  const result = await fetchApiJsonWithAuthRetry(`https://api.boot.dev/v1/users/public/${encodeURIComponent(normalized)}/stats`);
  if (result.status >= 200 && result.status < 300) {
    const record = ensurePersonalRecord(normalized);
    record.stats = result.json?.data ?? result.json;
    record.statsError = null;
    record.updatedAt = Date.now();
    savePersonalCache();
    renderPersonalLeaderboards();
    return;
  }

  if (result.status !== 404) {
    const record = ensurePersonalRecord(normalized);
    record.statsError = isAuthStatus(result.status) ? "auth" : "unavailable";
    record.updatedAt = Date.now();
    savePersonalCache();
    renderPersonalLeaderboards();
  }
}

async function loadPublicUserProfile(handle, options = {}) {
  const normalized = normalizeHandle(handle);
  if (!isValidHandle(normalized)) {
    setPersonalFeedback("Invalid username", "error");
    return null;
  }

  const result = await fetchApiJsonWithAuthRetry(`https://api.boot.dev/v1/users/public/${encodeURIComponent(normalized)}`);
  if (result.status === 404) {
    if (options.removeMissing && isPersonalHandle(normalized)) {
      await removePersonalHandle(normalized);
      setPersonalFeedback(`Removed @${normalized}: user not found`, "error");
    } else {
      setPersonalFeedback("User not found", "error");
    }
    return null;
  }

  if (isAuthStatus(result.status)) {
    setPersonalFeedback("Session expired. Refresh Boot.dev and try again.", "error");
    return null;
  }

  if (result.status < 200 || result.status >= 300) {
    setPersonalFeedback(result.timedOut ? "Request timed out. Try again." : "Could not check user. Try again.", "error");
    return null;
  }

  const profile = result.json?.data ?? result.json;
  if (!isPlainObject(profile) || !isValidHandle(profile.Handle || normalized)) {
    setPersonalFeedback("Invalid username", "error");
    return null;
  }

  return profile;
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

function parsePersonalHandleInput(value) {
  const raw = String(value || "").trim();
  if (!raw) return { error: "Enter a username" };
  if (/\s/.test(raw)) return { error: "Invalid username" };

  const handle = normalizeHandle(raw);
  if (!isValidHandle(handle)) return { error: "Invalid username" };
  return { handle };
}

function setPersonalFeedback(text, type = "info") {
  personalFeedback = text ? { text, type } : null;
  renderPersonalLeaderboards();
}

function clearPersonalFeedback() {
  personalFeedback = null;
}

async function savePersonalHandles() {
  const validHandles = uniqueHandles(personalHandles).filter(isValidHandle);
  if (validHandles.length !== personalHandles.length) {
    personalHandles = validHandles;
  }
  return chromeSet(PERSONAL_HANDLES_KEY, { handles: validHandles });
}

function savePersonalCache() {
  const records = {};
  for (const handle of personalHandles.filter(isValidHandle)) {
    if (isPlainObject(personalRecords[handle])) records[handle] = personalRecords[handle];
  }
  chromeSet(PERSONAL_CACHE_KEY, { records, updatedAt: Date.now() });
}

function removePersonalLeaderboards() {
  document.getElementById("be-personal-leaderboards")?.remove();
}
