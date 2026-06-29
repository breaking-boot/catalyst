// leaderboard.js
// All-time XP leaderboard injection and personal leaderboard feature.
// Handles: handleAllTimeLeaderboard, personal leaderboard UI and storage.

const LEADERBOARD_CACHE_KEY = "be_alltime_leaderboard_cache";
const ALL_TIME_LEADERBOARD_URL = "https://api.boot.dev/v1/leaderboard_xp/alltime";
const DAILY_LEADERBOARD_URL = "https://api.boot.dev/v1/leaderboard_xp/day";
const KARMA_LEADERBOARD_URL = "https://api.boot.dev/v1/leaderboard_karma/alltime";
const LEAGUE_DAILY_LEADERBOARD_URL = "https://api.boot.dev/v1/league_leaderboard_xp/day?limit=25";
const LEAGUE_LEADERBOARD_URL = "https://api.boot.dev/v1/league_leaderboard_xp/alltime?limit=25";
const PERSONAL_HANDLES_KEY = "be_personal_leaderboard_handles";
const PERSONAL_CACHE_KEY = "be_personal_leaderboard_cache";
const CURRENT_USER_HANDLE_KEY = "be_current_user_handle";
// Avatar role frames, indexed to match ROLE_FRAME_INDEX_BY_ROLE below. Bundled
// locally (assets/frames/<index>.png) and resolved to extension URLs so the
// fallback never depends on boot.dev's build-hashed asset paths, which are
// regenerated on every redeploy. Only used when the API provides no explicit
// frame URL (see getExplicitFrameUrl); if boot.dev redesigns the frames the
// bundled copies render slightly stale rather than breaking.
const ROLE_FRAME_URLS = Array.from({ length: 10 }, (_, i) =>
  chrome.runtime.getURL(`assets/frames/${i}.png`)
);
// Dev-only rot-detection baseline (NOT used for rendering). These are the
// boot.dev source URLs the bundled assets/frames PNGs were copied from. Nuxt/Vite
// content-hash asset filenames, so a URL keeps resolving as long as the image
// bytes are unchanged and 404s once the art changes. checkFrameAssetsForRot()
// probes these when the be_frame_debug flag is set so the maintainer gets a local
// heads-up to refresh the bundled copies. Keep in sync if the bundle is updated.
const FRAME_SOURCE_URLS = [
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
const FRAME_DEBUG_KEY = "be_frame_debug";
let frameDebugEnabled = false;
let frameRotChecked = false; // probe at most once per page load

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
let cachedDailyEntries = [];
let cachedKarmaEntries = [];
let cachedLeagueDailyEntries = [];
let cachedLeagueEntries = [];
let personalHandles = [];
let personalRecords = {};
let personalFeedback = null;
let personalPendingHandle = null;
let currentUserHandle = "";
let allTimeRenderVersion = 0;
let personalRenderVersion = 0;
let personalRenderTimer = null;

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
// Frame rot detection (opt-in, maintainer-only)
// ---------------------------------------------------------------------------
// boot.dev's API never sends a frame URL (the frame is derived from Role/Level),
// so the bundled assets/frames copies are always the source. They can't 404, but
// they can drift if boot.dev redesigns the art. This probe lets the maintainer
// notice that drift locally without ever surfacing anything to ordinary users:
// it does nothing unless `be_frame_debug` is set to true in chrome.storage.local.
async function loadFrameDebugFlag() {
  frameDebugEnabled = Boolean(await chromeGet(FRAME_DEBUG_KEY));
}

function checkFrameAssetsForRot() {
  if (!frameDebugEnabled || frameRotChecked || enhancerStopped) return;
  if (!isLeaderboardPage()) return;
  frameRotChecked = true;

  FRAME_SOURCE_URLS.forEach((url, index) => {
    // A same-origin <img> probe: load succeeds while the content hash is intact,
    // and errors once boot.dev ships different art under a new hash.
    const probe = new Image();
    probe.onerror = () => {
      console.warn(
        `[catalyst] role frame ${index} no longer resolves upstream (${url}); ` +
        "boot.dev likely changed the art. Re-download assets/frames and update FRAME_SOURCE_URLS."
      );
      toast(`Role frame ${index} changed on boot.dev. Refresh the bundled frames when convenient.`);
    };
    probe.src = url;
  });
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
  // Sticky once known: a confirmed identity is never overridden by a transient
  // DOM read (the nav heuristic can match a scrolled-past leaderboard card). The
  // 2-second scan keeps it corrected from the authoritative gold-glow highlight.
  if (currentUserHandle) return currentUserHandle;
  const nativeHandle = isLeaderboardPage() ? findNativeCurrentUserHandle() : "";
  const navHandle = getProfileHandleFromHref(navLink?.getAttribute("href"));
  return normalizeHandle(nativeHandle || navHandle);
}

function getCurrentUserDisplayName(navLink) {
  const text = normalizeText(navLink?.textContent || "");
  return text
    .replace(/\bLevel\s+\d+\b/gi, "")
    .replace(/\bArchmage\b/gi, "")
    .trim();
}

// Memoized for the duration of one synchronous burst. A single render pass calls
// this many times (per row, per delta), and each call ran a querySelectorAll plus
// a getBoundingClientRect loop (forced layout). The microtask reset guarantees the
// cache never survives an await, so it only collapses redundant calls in one stack.
let cachedProfileLink = null;
let cachedProfileLinkValid = false;
function findCurrentUserProfileLink() {
  if (cachedProfileLinkValid) return cachedProfileLink;

  const links = Array.from(document.querySelectorAll('a[href^="/u/"]'))
    .filter((link) => isVisible(link) && !link.closest("main, #be-alltime-leaderboard, #be-personal-leaderboards"));
  const topLinks = links
    .map((link) => ({ link, rect: link.getBoundingClientRect() }))
    .filter(({ rect }) => rect.top >= 0 && rect.top < 90 && rect.right > window.innerWidth / 2)
    .sort((a, b) => b.rect.right - a.rect.right);

  cachedProfileLink = topLinks[0]?.link || null;
  cachedProfileLinkValid = true;
  queueMicrotask(() => { cachedProfileLinkValid = false; });
  return cachedProfileLink;
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
  // FRAGILE: hashed class, may break on redeploy. boot.dev marks the signed-in
  // user's own leaderboard cards with this gold-glow utility class.
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
  schedulePersonalLeaderboardRender();
}

function learnCurrentUserHandleFromDom() {
  // The native gold-glow highlight marks the current user's own cards and is never
  // wrong, so trust it as the source of truth and let it correct a stale handle.
  const nativeHandle = isLeaderboardPage() ? findNativeCurrentUserHandle() : "";
  if (nativeHandle) {
    void rememberCurrentUserHandle(nativeHandle);
    return;
  }
  // Off the leaderboard (or before the glow renders) fall back to the nav profile
  // link, but only to learn an unknown handle — never to overwrite a known one,
  // since that heuristic can transiently match a scrolled-past profile card.
  if (currentUserHandle) return;
  const navHandle = getProfileHandleFromHref(findCurrentUserProfileLink()?.getAttribute("href"));
  if (navHandle) void rememberCurrentUserHandle(navHandle);
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

// Our own value for a given metric. Prefer the actual leaderboard responses
// (which are exactly the numbers shown on those boards) so deltas always match
// the displayed values; fall back to the saved personal record only when we are
// not present in any cached board.
function getMyValue(kind) {
  const identity = getCurrentUserIdentity();
  if (!normalizeHandle(identity.handle)) return null;

  const fromEntries = (entries, ...fields) => myValueFromEntries(entries, ...fields);

  let value = null;
  if (kind === "xp") {
    value = fromEntries(cachedAllTimeEntries, "XP", "TotalXP")
      ?? fromEntries(cachedLeagueEntries, "XP")
      ?? fromEntries(cachedLeagueDailyEntries, "XP");
  } else if (kind === "daily") {
    // Daily XP earned is universal, so the league-daily response is a valid
    // fallback when we rank outside the global daily top 25.
    value = fromEntries(cachedDailyEntries, "XPEarned", "XP")
      ?? fromEntries(cachedLeagueDailyEntries, "XPEarned", "XP");
  } else if (kind === "karma") {
    value = fromEntries(cachedKarmaEntries, "Karma");
  }
  if (value != null) return value;

  const record = personalRecords[normalizeHandle(identity.handle)];
  return record ? getPersonalValue(record, kind) : null;
}

// ---------------------------------------------------------------------------
// Delta helpers (shared by string templates and in-place DOM patching)
// ---------------------------------------------------------------------------
function deltaParts(myValue, theirValue) {
  if (myValue == null || theirValue == null) return null;
  const delta = myValue - theirValue;
  if (delta === 0) return null;
  return {
    text: `${delta > 0 ? "+" : "−"}${fmtNum(Math.abs(delta))}`,
    cls: delta > 0 ? "be-leader-delta-ahead" : "be-leader-delta-behind",
  };
}

function deltaText(myValue, theirValue, unit, skip) {
  if (skip) return "";
  const parts = deltaParts(myValue, theirValue);
  return parts ? `${parts.text} ${unit}` : "";
}

// An always-present, possibly empty, delta span. Empty spans are hidden via
// `.be-delta:empty`. Keeping the node stable lets us patch text/class in place
// instead of rebuilding the card, which is what eliminates the glow flicker.
function deltaSpanHTML(myValue, theirValue, unit, skip) {
  const parts = skip ? null : deltaParts(myValue, theirValue);
  const cls = parts ? ` ${parts.cls}` : "";
  const text = parts ? `${parts.text} ${unit}` : "";
  return `<span class="be-leader-delta be-delta${cls}" data-be-delta>${escapeHtml(text)}</span>`;
}

function patchDeltaEl(el, myValue, theirValue, unit, skip) {
  if (!el) return;
  const parts = skip ? null : deltaParts(myValue, theirValue);
  const text = parts ? `${parts.text} ${unit}` : "";
  setTextIfChanged(el, text);
  el.classList.toggle("be-leader-delta-ahead", !!parts && parts.cls === "be-leader-delta-ahead");
  el.classList.toggle("be-leader-delta-behind", !!parts && parts.cls === "be-leader-delta-behind");
}

// ---------------------------------------------------------------------------
// In-place DOM reconciliation
// ---------------------------------------------------------------------------
// Update `container`'s children to match `items` without tearing down nodes that
// persist between renders. Each kept node is patched in place (no destroy/create),
// so the current-user box-shadow never drops a frame. Only genuinely new rows are
// created and only removed rows are deleted; reorders move existing nodes.
function reconcileKeyedChildren(container, items, keyOf, createEl, updateEl) {
  const existing = new Map();
  for (const child of Array.from(container.children)) {
    const key = child.getAttribute("data-be-key");
    if (key !== null) existing.set(key, child);
    else child.remove(); // drop stray nodes such as the empty-state placeholder
  }

  let prev = null;
  for (const item of items) {
    const key = String(keyOf(item));
    let el = existing.get(key);
    if (el) {
      updateEl(el, item);
      existing.delete(key);
    } else {
      el = createEl(item);
      el.setAttribute("data-be-key", key);
    }
    if (prev) {
      if (prev.nextElementSibling !== el) prev.insertAdjacentElement("afterend", el);
    } else if (container.firstElementChild !== el) {
      container.insertBefore(el, container.firstElementChild);
    }
    prev = el;
  }

  for (const el of existing.values()) el.remove();
}

function elementFromHTML(html) {
  const tpl = document.createElement("template");
  tpl.innerHTML = html.trim();
  return tpl.content.firstElementChild;
}

function setTextIfChanged(el, text) {
  if (el && el.textContent !== text) el.textContent = text;
}

function renderAllTimeLeaderboard(entries) {
  if (!isFeatureEnabled("allTimeLeaderboard")) {
    removeAllTimeLeaderboard();
    return;
  }
  // Fast path: if panel already exists skip waitFor to avoid async races.
  const existingPanel = document.getElementById("be-alltime-leaderboard");
  if (existingPanel) {
    if (!isLeaderboardPage()) return;
    _applyAllTimeContent(existingPanel, entries);
    return;
  }

  // Slow path: wait for the native insertion point, then create and fill panel.
  const version = ++allTimeRenderVersion;
  waitFor(() => findAllTimeLeaderboardInsertionPoint() || document.querySelector("main") || document.body).then((host) => {
    if (version !== allTimeRenderVersion) return; // superseded by a later call
    if (!isLeaderboardPage() || !host) return;
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
    _applyAllTimeContent(panel, entries);
  });
}

function _applyAllTimeContent(panel, entries) {
  // Build the static skeleton once; thereafter reconcile the grid in place.
  let grid = panel.querySelector(".be-native-grid");
  if (!grid) {
    panel.innerHTML = `
      <h3 class="be-native-title">Top All-Time Learners</h3>
      <p class="be-native-subtitle" data-be-subtitle hidden></p>
      <div class="be-native-grid-wrap">
        <div class="be-native-grid"></div>
      </div>`;
    grid = panel.querySelector(".be-native-grid");
  }

  const currentIdentity = getCurrentUserIdentity();
  updateAllTimeSubtitle(panel, entries, currentIdentity);
  const visibleEntries = getVisibleAllTimeEntries(entries, currentIdentity);
  const myXP = getMyValue("xp");

  const items = visibleEntries.map((e, i) => {
    const handle = getHandle(e);
    return {
      key: handle || `#${i}`,
      entry: e,
      handle,
      displayName: getDisplayName(e, handle),
      xp: e.XP ?? e.TotalXP ?? e.XPEarned ?? 0,
      rank: e.Position ?? e.Rank ?? i + 1,
      isCurrentUser: isCurrentLeaderboardEntry(e, currentIdentity),
      href: handle ? `/u/${encodeURIComponent(handle)}` : "#",
    };
  });

  reconcileKeyedChildren(
    grid,
    items,
    (it) => it.key,
    (it) => elementFromHTML(allTimeCardHTML(it, myXP)),
    (el, it) => patchAllTimeCard(el, it, myXP)
  );
}

function allTimeCardHTML(it, myXP) {
  return `<div class="be-leader-card${it.isCurrentUser ? " be-current-user" : ""}">
      <a href="${it.href}" class="be-leader-link">
        <span class="be-leader-rank">${escapeHtml(it.rank)}</span>
        ${renderLeaderAvatar(it.entry, it.displayName)}
        <span class="be-leader-copy">
          <span class="be-leader-name">${escapeHtml(it.displayName)}</span>
          <span class="be-leader-xp">${fmtNum(it.xp)} xp</span>
          ${deltaSpanHTML(myXP, it.xp, "xp", it.isCurrentUser || !isDiffEnabled("diffsAllTime"))}
        </span>
      </a>
    </div>`;
}

function patchAllTimeCard(el, it, myXP) {
  el.classList.toggle("be-current-user", it.isCurrentUser);
  const link = el.querySelector(".be-leader-link");
  if (link && link.getAttribute("href") !== it.href) link.setAttribute("href", it.href);
  setTextIfChanged(el.querySelector(".be-leader-rank"), String(it.rank));
  setTextIfChanged(el.querySelector(".be-leader-name"), it.displayName);
  setTextIfChanged(el.querySelector(".be-leader-xp"), `${fmtNum(it.xp)} xp`);
  patchDeltaEl(el.querySelector("[data-be-delta]"), myXP, it.xp, "xp", it.isCurrentUser || !isDiffEnabled("diffsAllTime"));
}

// Mirror the native boards' "You are in position N" subtitle on our All-Time
// panel. boot.dev's API returns no platform-wide student count, so we show the
// position (the user's own Position from the all-time response) without the
// "of N total students" tail the native boards add from data we can't see.
function updateAllTimeSubtitle(panel, entries, currentIdentity) {
  const sub = panel.querySelector("[data-be-subtitle]");
  if (!sub) return;
  const rank = currentUserAllTimePosition(entries, currentIdentity);
  if (rank == null) {
    sub.hidden = true;
    setTextIfChanged(sub, "");
    return;
  }
  sub.hidden = false;
  setTextIfChanged(sub, `You are in position ${fmtNum(rank)}`);
}

function currentUserAllTimePosition(entries, currentIdentity) {
  if (!normalizeHandle(currentIdentity.handle)) return null;
  const current = entries.find((e) => isCurrentLeaderboardEntry(e, currentIdentity));
  return current ? num(current.Position ?? current.Rank) : null;
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

// ---------------------------------------------------------------------------
// Native section delta augmentation
// ---------------------------------------------------------------------------
// boot.dev renders four native leaderboard boards (League daily + standing,
// Global daily + community). We can't read their values from the DOM, so each
// board is matched to the API response that feeds it and a delta vs. our own
// value is appended into the card's text column, beneath the native value.
// Deltas are patched in place (never torn down) so they never flicker.

// Titles that delimit a leaderboard board. Only these bound a section's cards —
// the Global boards put a dynamic "You are in position N…" <h3> subtitle between
// the board title and its cards, and that must not be treated as a boundary.
const NATIVE_SECTION_TITLES = new Set([
  "league leaderboards",
  "global leaderboards",
  "top daily learners",
  "top league learners",
  "top community members",
  "recent archmages",
  "top all-time learners",
  "personal leaderboards",
]);

function isNativeSectionHeading(el) {
  return NATIVE_SECTION_TITLES.has(normalizeText(el.textContent).toLowerCase());
}

// Cards (profile links) sitting in document order between `heading` and the next
// section heading. Using document position rather than DOM nesting keeps this
// correct for both the League and Global containers regardless of their wrappers.
function nativeCardsForHeading(heading) {
  if (!heading) return [];
  const headings = Array.from(document.querySelectorAll("h1,h2,h3,[role='heading']"));
  let next = null;
  for (const h of headings) {
    if (h === heading || !isNativeSectionHeading(h)) continue;
    if (!(heading.compareDocumentPosition(h) & Node.DOCUMENT_POSITION_FOLLOWING)) continue;
    if (!next || (h.compareDocumentPosition(next) & Node.DOCUMENT_POSITION_FOLLOWING)) next = h;
  }

  return Array.from(document.querySelectorAll('a[href^="/u/"]')).filter((a) => {
    if (a.closest("#be-alltime-leaderboard, #be-personal-leaderboards")) return false;
    if (!(heading.compareDocumentPosition(a) & Node.DOCUMENT_POSITION_FOLLOWING)) return false;
    if (next && (next.compareDocumentPosition(a) & Node.DOCUMENT_POSITION_FOLLOWING)) return false;
    return true;
  });
}

function mapByHandle(entries, ...fields) {
  const map = {};
  for (const entry of entries) {
    const handle = normalizeHandle(getHandle(entry));
    if (!handle) continue;
    let value = null;
    for (const field of fields) {
      value = num(entry[field]);
      if (value != null) break;
    }
    if (value != null) map[handle] = value;
  }
  return map;
}

function myValueFromEntries(entries, ...fields) {
  const identity = getCurrentUserIdentity();
  const mine = entries.find((entry) => isCurrentLeaderboardEntry(entry, identity));
  if (!mine) return null;
  for (const field of fields) {
    const value = num(mine[field]);
    if (value != null) return value;
  }
  return null;
}

function augmentNativeSection(heading, dataByHandle, myValue, unit) {
  if (!heading || myValue == null) return;
  for (const link of nativeCardsForHeading(heading)) {
    const column = link.lastElementChild; // [rank, avatar, textColumn]
    if (!column) continue;
    const handle = normalizeHandle(getProfileHandleFromHref(link.getAttribute("href")));
    const theirValue = handle ? dataByHandle[handle] : null;
    applyNativeDelta(column, myValue, theirValue, unit, theirValue == null);
  }
}

function applyNativeDelta(column, myValue, theirValue, unit, skip) {
  let el = column.querySelector(":scope > .be-native-delta");
  const parts = skip ? null : deltaParts(myValue, theirValue);
  if (!parts) {
    if (el) el.remove();
    return;
  }
  if (!el) {
    el = document.createElement("span");
    el.className = "be-leader-delta be-native-delta";
    column.appendChild(el);
  }
  setTextIfChanged(el, `${parts.text} ${unit}`);
  el.classList.toggle("be-leader-delta-ahead", parts.cls === "be-leader-delta-ahead");
  el.classList.toggle("be-leader-delta-behind", parts.cls === "be-leader-delta-behind");
}

function augmentNativeLeagueDaily() {
  const heading = findHeadingAfter(findHeadingByText("League Leaderboards"), "Top Daily Learners");
  if (!isDiffEnabled("diffsLeagueDaily")) return stripNativeSection(heading);
  augmentNativeSection(
    heading,
    mapByHandle(cachedLeagueDailyEntries, "XPEarned"),
    myValueFromEntries(cachedLeagueDailyEntries, "XPEarned"),
    "xp"
  );
}

function augmentNativeLeagueStanding() {
  const heading = findHeadingAfter(findHeadingByText("League Leaderboards"), "Top League Learners");
  if (!isDiffEnabled("diffsLeagueStanding")) return stripNativeSection(heading);
  augmentNativeSection(
    heading,
    mapByHandle(cachedLeagueEntries, "XPEarned"),
    myValueFromEntries(cachedLeagueEntries, "XPEarned"),
    "xp"
  );
}

function augmentNativeDailyLeaderboard() {
  const heading = findHeadingAfter(findHeadingByText("Global Leaderboards"), "Top Daily Learners");
  if (!isDiffEnabled("diffsGlobalDaily")) return stripNativeSection(heading);
  augmentNativeSection(
    heading,
    mapByHandle(cachedDailyEntries, "XPEarned", "XP"),
    getMyValue("daily"),
    "xp"
  );
}

function augmentNativeKarmaLeaderboard() {
  const heading = findHeadingAfter(findHeadingByText("Global Leaderboards"), "Top Community Members");
  if (!isDiffEnabled("diffsGlobalKarma")) return stripNativeSection(heading);
  augmentNativeSection(
    heading,
    mapByHandle(cachedKarmaEntries, "Karma"),
    getMyValue("karma"),
    "karma"
  );
}

// Remove the deltas this extension injected into one native board (used when a
// board's diff toggle is off). The cards themselves are boot.dev's; we only
// strip our own appended `.be-native-delta` spans.
function stripNativeSection(heading) {
  if (!heading) return;
  for (const link of nativeCardsForHeading(heading)) {
    link.querySelector(":scope > * > .be-native-delta")?.remove();
  }
}

// Strip every injected native delta in one pass (used when the master toggle
// goes off, regardless of which board is in view).
function removeNativeDeltas() {
  document.querySelectorAll(".be-native-delta").forEach((el) => el.remove());
}

function augmentNativeLeaderboards() {
  augmentNativeLeagueDaily();
  augmentNativeLeagueStanding();
  augmentNativeDailyLeaderboard();
  augmentNativeKarmaLeaderboard();
}

function ensureLeaderboardUiState() {
  if (!isLeaderboardPage()) return;

  const currentIdentity = getCurrentUserIdentity();

  // All-Time: re-render if it's missing or its current-user highlight dropped.
  if (isFeatureEnabled("allTimeLeaderboard")) {
    const allTime = document.getElementById("be-alltime-leaderboard");
    if (!allTime) {
      if (cachedAllTimeEntries.length) renderAllTimeLeaderboard(cachedAllTimeEntries);
    } else if (cachedAllTimeEntries.some((entry) => isCurrentLeaderboardEntry(entry, currentIdentity)) &&
        !allTime.querySelector(".be-current-user")) {
      renderAllTimeLeaderboard(cachedAllTimeEntries);
    }
  }

  // Personal: ensure it exists and stays pinned above the native boards.
  if (isFeatureEnabled("personalLeaderboards")) {
    const personal = document.getElementById("be-personal-leaderboards");
    if (!personal) {
      schedulePersonalLeaderboardRender();
    } else {
      ensurePersonalPlacement(personal);
      if (personalHandles.some((handle) => isCurrentLeaderboardEntry({ handle }, currentIdentity)) &&
          !personal.querySelector(".be-current-user")) {
        schedulePersonalLeaderboardRender();
      }
    }
  }

  augmentNativeLeaderboards();
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

// Personal Leaderboards is pinned to the very top of the leaderboard page, above
// the native League/Global boards — users care most about their own list, and it
// looked out of place wedged between the Global sections.
function findPersonalLeaderboardInsertionPoint() {
  const heading = findHeadingByText("League Leaderboards") || findHeadingByText("Global Leaderboards");
  return heading ? topLevelBlockFor(heading) : null;
}

// The ancestor of `el` that sits directly inside <main> (or <body>) — the
// top-level section block — so a panel can be inserted as a sibling above it.
function topLevelBlockFor(el) {
  const root = document.querySelector("main") || document.body;
  let node = el;
  while (node.parentElement && node.parentElement !== root && node.parentElement !== document.body) {
    node = node.parentElement;
  }
  return node;
}

// Keep the personal panel as the sibling immediately before the native boards.
function ensurePersonalPlacement(panel) {
  const block = findPersonalLeaderboardInsertionPoint();
  if (!block) {
    if (!panel.isConnected) (document.querySelector("main") || document.body).prepend(panel);
    return;
  }
  if (block.previousElementSibling !== panel) {
    block.insertAdjacentElement("beforebegin", panel);
  }
}

// ===========================================================================
// FEATURE 4: Manual personal leaderboards
// ===========================================================================
function handleDailyXpLeaderboard(json) {
  const entries = getLeaderboardEntries(json);
  cachedDailyEntries = entries;
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
    schedulePersonalLeaderboardRender();
  }
  if (isLeaderboardPage()) augmentNativeDailyLeaderboard();
}

function handleKarmaLeaderboard(json) {
  const entries = getLeaderboardEntries(json);
  if (!entries.length) return;
  cachedKarmaEntries = entries;
  if (isLeaderboardPage()) augmentNativeKarmaLeaderboard();
}

function handleLeagueDailyLeaderboard(json) {
  cachedLeagueDailyEntries = getLeaderboardEntries(json);
  if (isLeaderboardPage()) {
    augmentNativeLeagueDaily();
    augmentNativeDailyLeaderboard(); // league-daily is a fallback for our own daily value
  }
}

function handleLeagueLeaderboard(json) {
  cachedLeagueEntries = getLeaderboardEntries(json);
  if (isLeaderboardPage()) augmentNativeLeagueStanding();
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
  schedulePersonalLeaderboardRender();
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
  if (!isFeatureEnabled("personalLeaderboards")) return;
  if (!isLeaderboardPage() || !personalHandles.length) return;

  // The daily board is requested by requestNativeLeaderboardData, which always
  // runs on the leaderboard page; no need to re-request it here.
  for (const handle of personalHandles) {
    void refreshPersonalHandle(handle);
  }
}

// Source data for native-section deltas (karma + league boards). Independent of
// personal handles so deltas show even with no saved handles, and useful when the
// extension loads into an already-open leaderboard page boot.dev won't re-fetch.
function requestNativeLeaderboardData() {
  if (!isLeaderboardPage()) return;
  // These boards exist only to compute deltas; with the master diff toggle off
  // nothing consumes them, so skip the four requests entirely.
  if (!isFeatureEnabled("diffs")) return;
  requestApiJson(DAILY_LEADERBOARD_URL);
  requestApiJson(KARMA_LEADERBOARD_URL);
  requestApiJson(LEAGUE_DAILY_LEADERBOARD_URL);
  requestApiJson(LEAGUE_LEADERBOARD_URL);
}

function schedulePersonalLeaderboardRender() {
  if (!isLeaderboardPage()) return;
  clearTrackedTimeout(personalRenderTimer);
  personalRenderTimer = setTrackedTimeout(renderPersonalLeaderboards, 50);
}

function renderPersonalLeaderboards() {
  personalRenderTimer = null;
  if (!isFeatureEnabled("personalLeaderboards")) {
    removePersonalLeaderboards();
    return;
  }
  if (!isLeaderboardPage()) return;

  // Fast path: panel already exists — render in place.
  const existing = document.getElementById("be-personal-leaderboards");
  if (existing) {
    _applyPersonalContent(existing);
    return;
  }

  // Otherwise wait for the native boards to mount so we know where "above them" is.
  const version = ++personalRenderVersion;
  waitFor(() => findPersonalLeaderboardInsertionPoint(), 10000).then((block) => {
    if (version !== personalRenderVersion) return; // superseded
    if (!isLeaderboardPage() || !block) return;
    let panel = document.getElementById("be-personal-leaderboards");
    if (!panel) {
      panel = document.createElement("section");
      panel.id = "be-personal-leaderboards";
      panel.className = "be-personal-leaderboards";
    }
    _applyPersonalContent(panel);
  });
}

// Static board definitions: which kind of value each board shows and its unit.
const PERSONAL_BOARDS = [
  { title: "Top Daily Learners", kind: "daily", unit: "xp" },
  { title: "Top All-Time Learners", kind: "xp", unit: "xp" },
  { title: "Top Community Members", kind: "karma", unit: "karma" },
];

// Build the persistent panel skeleton once. The form, chips container, message
// slot, and per-board row containers stay mounted across renders so that data
// refreshes patch text in place rather than recreating the glowing cards.
function ensurePersonalSkeleton(panel) {
  if (panel.querySelector(".be-personal-shell")) return;

  const boards = PERSONAL_BOARDS
    .map((b) => `
      <section class="be-personal-board">
        <h4>${escapeHtml(b.title)}</h4>
        <div class="be-personal-rows" data-kind="${b.kind}" data-unit="${b.unit}"></div>
      </section>`)
    .join("");

  panel.innerHTML = `
    <h3 class="be-native-title">Personal Leaderboards</h3>
    <div class="be-personal-shell">
      <form id="be-personal-form" class="be-personal-form">
        <input id="be-personal-handle" type="text" autocomplete="off" spellcheck="false" placeholder="boot.dev handle or profile URL" aria-label="boot.dev handle or profile URL">
        <button type="submit">Add</button>
      </form>
      <div class="be-personal-message-slot"></div>
      <div class="be-personal-chips"></div>
      <div class="be-personal-grid">${boards}</div>
    </div>`;

  bindPersonalLeaderboardControls(panel);
}

function _applyPersonalContent(panel) {
  ensurePersonalPlacement(panel);
  ensurePersonalSkeleton(panel);

  // Message slot (feedback / pending). Only touched when its markup changes.
  const slot = panel.querySelector(".be-personal-message-slot");
  const messageMarkup = personalFeedback?.text
    ? `<div class="be-personal-message be-personal-message-${escapeHtml(personalFeedback.type || "info")}">${escapeHtml(personalFeedback.text)}</div>`
    : personalPendingHandle
      ? `<div class="be-personal-message be-personal-message-info">Checking @${escapeHtml(personalPendingHandle)}...</div>`
      : "";
  if (slot && slot.innerHTML !== messageMarkup) slot.innerHTML = messageMarkup;

  // Chips. The container is persistent and uses delegated click handling, so a
  // plain innerHTML swap here is safe and never touches the row cards' glow.
  const chipsEl = panel.querySelector(".be-personal-chips");
  const chipsMarkup = personalHandles.length
    ? personalHandles
        .map((handle) => `<button type="button" class="be-personal-chip" data-be-remove-handle="${escapeHtml(handle)}">@${escapeHtml(getPersonalDisplayHandle(handle))}<span aria-hidden="true">&times;</span></button>`)
        .join("")
    : '<span class="be-personal-empty">Add handles to compare friends, guild members, or rivals.</span>';
  if (chipsEl && chipsEl.innerHTML !== chipsMarkup) chipsEl.innerHTML = chipsMarkup;

  // Rows: reconcile each board in place so unchanged rows are never rebuilt.
  for (const rowsEl of panel.querySelectorAll(".be-personal-rows")) {
    const kind = rowsEl.getAttribute("data-kind");
    const unit = rowsEl.getAttribute("data-unit");
    const rows = getPersonalRows(kind);
    const myValue = getMyValue(kind);

    if (!rows.length) {
      const empty = '<div class="be-personal-board-empty">No handles added yet.</div>';
      if (rowsEl.innerHTML !== empty) rowsEl.innerHTML = empty;
      continue;
    }

    const items = rows.map((row, i) => ({ row, rank: i + 1, unit, myValue }));
    reconcileKeyedChildren(
      rowsEl,
      items,
      (it) => it.row.handle,
      (it) => elementFromHTML(personalRowHTML(it)),
      (el, it) => patchPersonalRow(el, it)
    );
  }
}

function personalRowHTML(it) {
  const { row, rank, unit, myValue } = it;
  const valueText = row.value == null
    ? row.loading ? "loading" : "unavailable"
    : `${fmtNum(row.value)} ${unit}`;
  const isCurrentUser = isCurrentLeaderboardEntry(row, getCurrentUserIdentity());
  const skipDelta = isCurrentUser || row.loading || row.value == null || !isDiffEnabled("diffsPersonal");

  return `
    <a class="be-personal-row${isCurrentUser ? " be-current-user" : ""}" href="/u/${encodeURIComponent(row.handle)}">
      <span class="be-personal-rank">${rank}</span>
      ${renderLeaderAvatar(row, row.name)}
      <span class="be-personal-copy">
        <span class="be-personal-name">${escapeHtml(row.name)}</span>
        <span class="be-personal-handle">@${escapeHtml(row.displayHandle)}</span>
      </span>
      <span class="be-personal-value-col">
        <span class="be-personal-value">${escapeHtml(valueText)}</span>
        ${deltaSpanHTML(myValue, row.value, unit, skipDelta)}
      </span>
    </a>`;
}

function patchPersonalRow(el, it) {
  const { row, rank, unit, myValue } = it;
  const isCurrentUser = isCurrentLeaderboardEntry(row, getCurrentUserIdentity());
  const skipDelta = isCurrentUser || row.loading || row.value == null || !isDiffEnabled("diffsPersonal");
  const valueText = row.value == null
    ? row.loading ? "loading" : "unavailable"
    : `${fmtNum(row.value)} ${unit}`;

  el.classList.toggle("be-current-user", isCurrentUser);
  const href = `/u/${encodeURIComponent(row.handle)}`;
  if (el.getAttribute("href") !== href) el.setAttribute("href", href);
  setTextIfChanged(el.querySelector(".be-personal-rank"), String(rank));
  setTextIfChanged(el.querySelector(".be-personal-name"), row.name);
  setTextIfChanged(el.querySelector(".be-personal-handle"), `@${row.displayHandle}`);
  setTextIfChanged(el.querySelector(".be-personal-value"), valueText);
  patchDeltaEl(el.querySelector("[data-be-delta]"), myValue, row.value, unit, skipDelta);
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
  schedulePersonalLeaderboardRender();

  const profile = await loadPublicUserProfile(normalized);
  if (!profile) {
    personalPendingHandle = null;
    schedulePersonalLeaderboardRender();
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
  schedulePersonalLeaderboardRender();
  void refreshPersonalStats(canonical);
}

async function removePersonalHandle(handle) {
  const normalized = normalizeHandle(handle);
  if (!normalized) return;

  personalHandles = personalHandles.filter((h) => h !== normalized);
  delete personalRecords[normalized];
  await savePersonalHandles();
  savePersonalCache();
  schedulePersonalLeaderboardRender();
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
  schedulePersonalLeaderboardRender();

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
    schedulePersonalLeaderboardRender();
    return;
  }

  if (result.status !== 404) {
    const record = ensurePersonalRecord(normalized);
    record.statsError = isAuthStatus(result.status) ? "auth" : "unavailable";
    record.updatedAt = Date.now();
    savePersonalCache();
    schedulePersonalLeaderboardRender();
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
  schedulePersonalLeaderboardRender();
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
