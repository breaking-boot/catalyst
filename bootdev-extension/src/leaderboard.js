// leaderboard.js
// All-time XP leaderboard injection and personal leaderboard feature.
// Handles: handleAllTimeLeaderboard, personal leaderboard UI and storage.

// be_alltime_leaderboard_cache (the pre-v0.15.0 frozen board) is deliberately
// NOT read any more, and equally deliberately never deleted. It is a snapshot
// of the same GLOBAL board the July 2026 capture holds, so it contains no
// handle the bundled seed lacks, while resolving its 25 stale handles would
// cost 25 /stats requests competing with fresher work. Its stored Position and
// XP were already known wrong (a-fleming at rank 1 while katcodes led on XP).
const DAILY_LEADERBOARD_URL = "https://api.boot.dev/v1/leaderboard_xp/day";
const KARMA_LEADERBOARD_URL = "https://api.boot.dev/v1/leaderboard_karma/alltime";
// `limit=25` is an upper bound, not an expectation. Boot.dev resized leagues
// from 25 members to 10 (observed 2026-08-19), and the server simply returns
// what the league holds. Deliberately NOT lowered to 10: asking for more than
// exists costs nothing, while asking for fewer than exists would silently drop
// league-mates off the comparisons if leagues grow again.
const LEAGUE_DAILY_LEADERBOARD_URL = "https://api.boot.dev/v1/league_leaderboard_xp/day?limit=25";
const LEAGUE_LEADERBOARD_URL = "https://api.boot.dev/v1/league_leaderboard_xp/alltime?limit=25";
const PERSONAL_HANDLES_KEY = "be_personal_leaderboard_handles";
const PERSONAL_CACHE_KEY = "be_personal_leaderboard_cache";
const CURRENT_USER_HANDLE_KEY = "be_current_user_handle";
const CURRENT_USER_KARMA_KEY = "be_current_user_karma";

// --- Personal daily-XP measurement (see computeDailyXpView) ---
// The native daily board is a rolling last-24-hours window, so a tracked user's
// "daily XP" can only be measured by diffing total-XP snapshots taken inside
// that window. Snapshots are [timestampMs, totalXp] pairs per tracked user.
const DAY_WINDOW_MS = 24 * 60 * 60 * 1000;
// Keep a little slack past 24h so a backdated board snapshot (taken at exactly
// now-24h) is still usable a few minutes later instead of being pruned instantly.
const SNAPSHOT_MAX_AGE_MS = DAY_WINDOW_MS + 30 * 60 * 1000;
const SNAPSHOT_CAP = 60;
// A measured window narrower than this says nothing about the day; fall through
// to the heatmap estimate instead of confidently showing "0 xp".
const SNAPSHOT_MIN_WINDOW_MS = 30 * 60 * 1000;
// A window at least this wide covers enough of the day to trust the measurement
// over the (resubmit-inflated) heatmap estimate.
const FULL_WINDOW_TRUST_MS = 18 * 60 * 60 * 1000;
// Heatmap-based estimate inputs. Lesson/challenge completions have no public
// per-day XP source, so the estimate is completions x average XP, plus Boot.dev's
// bonuses: a flat once-a-day first-clear bonus and a +1%/streak-day multiplier.
// FIXME: ESTIMATED_XP_PER_LESSON is a placeholder — calibrate from the base-XP
// spreadsheet as amounts are collected (see the README's personal "Daily XP" notes).
const ESTIMATED_XP_PER_LESSON = 115;
const DAILY_FIRST_CLEAR_BONUS_XP = 200;
const STREAK_BONUS_CAP = 20; // percent; +1% per consecutive active day, capped
const HEATMAP_REFRESH_MS = 10 * 60 * 1000;
// The daily-board caches live in memory, but personal records (snapshots) are
// persisted, so for a moment after a page refresh the measured tier has data
// while the exact tier does not, and rows flash "past 24hr" until the boards
// re-fetch. Persist a distilled handle->XPEarned map per daily board and honor
// it briefly at load. Kept short: XPEarned drifts as the rolling window slides,
// and live data (once received) is authoritative anyway.
const DAILY_BOARD_CACHE_KEY = "be_daily_board_cache";
const DAILY_BOARD_PERSIST_TTL_MS = 5 * 60 * 1000;
// Boot.dev visual asset used with permission.
// Not covered by this repository's MIT license. See ATTRIBUTION.md.
//
// Avatar role frames, indexed to match ROLE_FRAME_INDEX_BY_ROLE below. Bundled
// locally (assets/frames/<index>.png) and resolved to extension URLs so the
// fallback never depends on Boot.dev's build-hashed asset paths, which are
// regenerated on every redeploy. Only used when the API provides no explicit
// frame URL (see getExplicitFrameUrl); if Boot.dev redesigns the frames the
// bundled copies render slightly stale rather than breaking.
const ROLE_FRAME_URLS = Array.from({ length: 10 }, (_, i) =>
  chrome.runtime.getURL(`assets/frames/${i}.png`)
);
// Dev-only rot-detection baseline (NOT used for rendering). These are the
// Boot.dev source URLs the bundled assets/frames PNGs were copied from. Nuxt/Vite
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

// Per-tier avatar geometry, indexed like ROLE_FRAME_URLS. Boot.dev keeps every
// rank badge the same overall size by varying ring thickness: low tiers have a
// thin ring in a small footprint, archmage a thick ring filling the frame. The
// bundled PNGs reflect that — the opaque ring's outer diameter grows from ~146px
// (apprentice) to ~253px (archmage) within the same 256px canvas, while the
// transparent hole stays ~42–46%. Scaling every canvas uniformly therefore makes
// low-tier badges render small. These values (measured from the PNGs) scale each
// frame so the ring outer lands at a consistent ~49px and size the inner avatar
// to that frame's hole, so combos match across tiers like the native site.
// FRAME_DISPLAY_SCALE is the CSS transform scale for the frame <img>;
// FRAME_INNER_PCT is the inner avatar diameter as a % of the 40px avatar box.
// Values are trimmed ~10% of the boost above Archmage's 1.25 (Archmage is
// unchanged, the anchor that already matched native); low tiers were rendering
// a touch larger than the native ring, so their outer edge is pulled in slightly.
const FRAME_DISPLAY_SCALE = [2.08, 2.01, 1.73, 1.68, 1.67, 1.54, 1.57, 1.37, 1.33, 1.25];
// Inner % comes from each frame's fully-opaque hole, but the thick top-tier rings
// have a soft inner edge, so their true visual hole is a little larger than measured
// and the avatar left a small gap. Bump the top tiers (archsage, mage, archmage) to
// close it; the lower tiers already fill their ring cleanly.
const FRAME_INNER_PCT = [96, 92, 80, 77, 77, 69, 70, 64, 59, 57];
const DEFAULT_INNER_PCT = 62.5; // legacy fixed size, for an unrecognized frame

// Live boards only: each of these holds a response received in this session.
let cachedDailyEntries = [];
let cachedKarmaEntries = [];
let cachedLeagueDailyEntries = [];
let cachedLeagueEntries = [];

// Timestamps of the last passively-received (or actively-fetched) board data, so
// an active refetch on load/route change is skipped when Boot.dev just fetched
// the same board — avoiding the initial double-fetch — while a stale, already-open
// page (no recent data) still refetches.
const BOARD_FETCH_FRESH_MS = 10_000;
let boardSeenAt = {};
// Restored copy of DAILY_BOARD_CACHE_KEY: { daily|leagueDaily: { byHandle, seenAt } }.
let persistedDailyBoards = {};
function markBoardSeen(key) {
  boardSeenAt[key] = Date.now();
}
function boardFresh(key) {
  return Date.now() - (boardSeenAt[key] || 0) < BOARD_FETCH_FRESH_MS;
}
let personalHandles = [];
let personalRecords = {};
let personalFeedback = null;
let personalPendingHandle = null;
let currentUserHandle = "";
// My own karma series ([t, karma] pairs), kept apart from personal records so
// Daily Karma comparisons have a baseline without me tracking my own handle.
let currentUserKarmaSnapshots = [];
// My own lifetime XP, from a response received THIS SESSION. Session-only and
// never restored from storage, which is the whole point: v0.13.1's defect was
// getMyValue("xp") reading a stored board first, so every All-Time comparison
// was computed against a stale copy of me. The roster must never feed this.
let currentUserLiveXp = null;
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
    readField(entry, "Handle") ||
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
    readField(entry, "FirstName") ||
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
    readField(entry, "ProfileImageURL") ||
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
  const role = normalizeText(readField(entry, "Role") || entry?.User?.Role)
    .toLowerCase()
    .replace(/[\s_-]+/g, "");
  if (ROLE_FRAME_INDEX_BY_ROLE[role] != null) return ROLE_FRAME_INDEX_BY_ROLE[role];

  const level = num(readField(entry, "Level") ?? entry?.User?.Level);
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
// Boot.dev's API never sends a frame URL (the frame is derived from Role/Level),
// so the bundled assets/frames copies are always the source. They can't 404, but
// they can drift if Boot.dev redesigns the art. This probe lets the maintainer
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
    // and errors once Boot.dev ships different art under a new hash.
    const probe = new Image();
    probe.onerror = () => {
      console.warn(
        `[catalyst] role frame ${index} no longer resolves upstream (${url}); ` +
        "Boot.dev likely changed the art. Re-download assets/frames and update FRAME_SOURCE_URLS."
      );
      toast(`Role frame ${index} changed on Boot.dev. Refresh the bundled frames when convenient.`);
    };
    probe.src = url;
  });
}

// ---------------------------------------------------------------------------
// Leaderboard entry helpers
// ---------------------------------------------------------------------------
// Envelope keys that can carry the entry array, PascalCase -> camelCase. Kept
// separate from API_FIELD_ALIASES because these name containers, not values.
//
// The league boards are the only WRAPPED leaderboard responses, and their key
// flipped along with their entries on 2026-08-19: `LeagueMembers` ->
// `leagueMembers`. That made this function return [] for both League boards,
// and because those two handlers had no usable-field check, the comparisons
// vanished with nothing in the console at all. Casing the entry fields alone
// would not have repaired them.
const LEADERBOARD_ENVELOPE_KEYS = Object.freeze({
  Leaderboard: "leaderboard",
  LeaderboardXP: "leaderboardXP",
  Entries: "entries",
  Members: "members",
  Users: "users",
  LeagueMembers: "leagueMembers",
});

function getLeaderboardEntries(json) {
  if (Array.isArray(json)) return json;
  for (const container of [json, json?.data]) {
    if (Array.isArray(container)) return container;
    if (!isPlainObject(container)) continue;
    for (const [pascal, camel] of Object.entries(LEADERBOARD_ENVELOPE_KEYS)) {
      if (Array.isArray(container[pascal])) return container[pascal];
      if (Array.isArray(container[camel])) return container[camel];
    }
  }
  return [];
}

// Handle comparison only. No IsCurrentUser / IsSelf / IsMe field exists in any
// observed response (re-confirmed against live captures of every board,
// 2026-07-31), so speculatively checking for them only added places for a
// wrong answer to come from.
function isCurrentLeaderboardEntry(entry, currentIdentity) {
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
  // The Nuxt payload is the only source left off the leaderboard page now that
  // the nav profile link is gone (see findNuxtCurrentUserHandle).
  return normalizeHandle(nativeHandle || navHandle || findNuxtCurrentUserHandle());
}

function getCurrentUserDisplayName(navLink) {
  const text = normalizeText(navLink?.textContent || "");
  return text
    .replace(/\bLevel\s+\d+\b/gi, "")
    .replace(/\bArchmage\b/gi, "")
    .trim();
}

// Memoized for the duration of one synchronous burst. A single render pass calls
// this many times (per row, per comparison), and each call ran a querySelectorAll plus
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
    .filter(({ rect }) => rect.top >= 0 && rect.top < TOP_NAV_BAND_PX && rect.right > window.innerWidth / 2)
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

// Boot.dev's top nav no longer renders an <a href="/u/..."> for the signed-in
// user — the avatar is a <button> that opens a menu. Confirmed 2026-07-31: on
// /leaderboard all 195 "/u/" links are leaderboard cards, none in the nav band,
// so findCurrentUserProfileLink now returns null on every route. That left a
// fresh install with no way to learn its own handle unless it happened to open
// /leaderboard (where the gold-glow card still works), and with no handle there
// is no karma baseline, so every Daily Karma comparison read "unavailable".
//
// The signed-in user is in the server-rendered Nuxt payload. Reading it there
// is the documented last resort for a value with no API source — Catalyst has
// no "who am I" endpoint, and /v1/users/public/{handle} needs the handle
// already. Same class of read as findTotalStudents.
//
// Parsed at most once per page load: the payload runs to a few hundred KB and
// the DOM scan ticks every 2 seconds.
let nuxtHandleChecked = false;
function findNuxtCurrentUserHandle() {
  if (nuxtHandleChecked) return "";
  try {
    const raw = document.getElementById("__NUXT_DATA__")?.textContent;
    if (!raw) return ""; // not marked checked: the payload may not be parsed yet
    nuxtHandleChecked = true;
    const parsed = JSON.parse(raw);
    // devalue serializes to a flat array; every field value is an INDEX into it.
    const flat = Array.isArray(parsed) ? parsed : parsed?.data;
    if (!Array.isArray(flat)) return "";
    for (const node of flat) {
      if (!isPlainObject(node) || !("Handle" in node)) continue;
      // Require a field only the signed-in user's own object carries, so a
      // public profile embedded in the same payload can never match.
      if (!("Email" in node) && !("IsAdmin" in node)) continue;
      const handle = normalizeHandle(flat[node.Handle]);
      if (isValidHandle(handle)) return handle;
    }
  } catch (_) {
    nuxtHandleChecked = true;
  }
  return "";
}

function findNativeCurrentUserHandle() {
  // FRAGILE: hashed class, may break on redeploy. Boot.dev marks the signed-in
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
  const karmaStored = await chromeGet(CURRENT_USER_KARMA_KEY);
  if (enhancerStopped) return;
  currentUserHandle = normalizeHandle(stored.handle || stored);
  // The karma series is only valid for the handle it was recorded for, and is
  // repaired on the way in — see dropFabricatedZeros. The repaired copy is
  // persisted by the next observation rather than written back here, so a load
  // stays a load.
  currentUserKarmaSnapshots = dropFabricatedZeros(
    currentUserHandle &&
    isPlainObject(karmaStored) &&
    normalizeHandle(karmaStored.handle) === currentUserHandle &&
    Array.isArray(karmaStored.snapshots)
      ? karmaStored.snapshots
      : []
  );
}

async function rememberCurrentUserHandle(handle) {
  const normalized = normalizeHandle(handle);
  if (!isValidHandle(normalized) || normalized === currentUserHandle) return;

  // A different login invalidates the previous user's karma series.
  if (currentUserHandle) {
    currentUserKarmaSnapshots = [];
    chromeSet(CURRENT_USER_KARMA_KEY, { handle: normalized, snapshots: [] });
  }
  currentUserHandle = normalized;
  await chromeSet(CURRENT_USER_HANDLE_KEY, { handle: normalized, updatedAt: Date.now() });
  if (!isLeaderboardPage()) return;

  renderAllTimeLeaderboard();
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
  if (navHandle) {
    void rememberCurrentUserHandle(navHandle);
    return;
  }
  // Last resort, and since 2026-07-31 the only one that works off the
  // leaderboard page: the signed-in user in the server-rendered Nuxt payload.
  const nuxtHandle = findNuxtCurrentUserHandle();
  if (nuxtHandle) void rememberCurrentUserHandle(nuxtHandle);
}

// ===========================================================================
// FEATURE 1: All-time XP leaderboard section
// ===========================================================================
// Kept and repointed. The timeframe has 400'd since 2026-08-14 so this cannot
// fire today, but if Boot.dev ever restores it the response is the roster's
// best possible source — 25 authoritative rank + XP observations at once — and
// nothing else needs to change.
function handleAllTimeLeaderboard(json) {
  const entries = getLeaderboardEntries(json);
  if (!entries.length) return;
  // A renamed XP would render 25 rows of "0 xp" rather than failing outright.
  reportUsableFields("/v1/leaderboard_xp/alltime", entries, "XP", (e) => readField(e, "XP"));
  markBoardSeen("alltime");
  harvestPersonalSnapshots(entries);
  recordCurrentUserLiveXp(myValueFromEntries(entries, "XP"));

  const now = Date.now();
  let changed = false;
  for (const entry of entries) {
    const handle = normalizeHandle(getHandle(entry));
    if (!isValidHandle(handle)) continue;
    changed = applyRosterObservation(allTimeRoster, {
      handle,
      // Keys are the roster's own observation shape; the values are API reads,
      // so every one goes through readField. This path cannot run today (the
      // alltime timeframe 400s) — which is exactly why it would rot unnoticed.
      Handle: getHandle(entry),
      rank: readField(entry, "Position") ?? entry.Rank,
      rankAt: now,
      XP: readField(entry, "XP"),
      FirstName: readField(entry, "FirstName"),
      LastName: readField(entry, "LastName"),
      Role: readField(entry, "Role"),
      Level: readField(entry, "Level"),
      ProfileImageURL: getAvatarUrl(entry),
      profileAt: now,
    }) || changed;
  }
  if (changed) saveAllTimeRoster();
  renderAllTimeLeaderboard();
}

// My own lifetime XP, observed live. Fed by any response that reveals it: my
// own profile, a league board carrying me, or a restored all-time board.
function recordCurrentUserLiveXp(xp) {
  // A nullish argument means "this response did not contain me", never "my XP
  // is zero". num(null) is 0 — the same trap that made Daily Karma compare
  // against a fabricated zero — and EVERY caller here can legitimately pass
  // null: myValueFromEntries returns null when I am not on that board (I am
  // usually absent from at least one of the league, week, or month XP sources),
  // and readNum returns null when the field is missing.
  //
  // The symptom was distinctive: my own XP read 0, so every All-Time comparison
  // rendered as minus that learner's entire lifetime total, including for the
  // 23 people I am ahead of. It self-healed as soon as any response containing
  // me arrived, which is what made it look intermittent rather than broken.
  const value = observedNum(xp);
  if (value == null) return;
  currentUserLiveXp = value;
}

// Our own value for a given metric. Prefer the actual leaderboard responses
// (which are exactly the numbers shown on those boards) so comparisons always match
// the displayed values; fall back to the saved personal record only when we are
// not present in any cached board.
function getMyValue(kind) {
  const identity = getCurrentUserIdentity();
  if (!normalizeHandle(identity.handle)) return null;

  const fromEntries = (entries, ...fields) => myValueFromEntries(entries, ...fields);

  let value = null;
  if (kind === "xp") {
    // TotalXP has never appeared on a leaderboard entry (full key list checked
    // against live responses 2026-07-31), so it is not carried as a fallback.
    //
    // THE ROSTER IS DELIBERATELY ABSENT FROM THIS CHAIN. Its rows can be days
    // or weeks old, and reading my own row out of it would recreate v0.13.1
    // exactly: a stale "me" silently wrong-footing every All-Time comparison,
    // which is far harder to notice than a missing one. Only values observed
    // THIS SESSION are eligible.
    value = currentUserLiveXp
      ?? fromEntries(cachedLeagueEntries, "XP")
      ?? fromEntries(cachedLeagueDailyEntries, "XP");
  } else if (kind === "daily") {
    // Daily XP earned is universal, so the league-daily response is a valid
    // fallback when we rank outside the global daily top 25 (verified
    // 2026-07-31: the same handle's XPEarned matches on both boards).
    //
    // XP is deliberately NOT a fallback here. It is the LIFETIME total, not the
    // trailing-24h figure, so if XPEarned were ever renamed this would quietly
    // report ~1,266,000 as a "daily" number and compare it against the native
    // board's ~16,000. A missing value is recoverable; a plausible wrong one is
    // the exact failure mode that hid the v0.12.1 regression.
    value = fromEntries(cachedDailyEntries, "XPEarned")
      ?? fromEntries(cachedLeagueDailyEntries, "XPEarned");
  } else if (kind === "karma") {
    // /stats ONLY — never the karma board. Boot.dev's two karma surfaces
    // disagree: measured 2026-09-19, the board read 5-20 higher per person than
    // that person's /stats, and the profile page agrees with /stats. Reading
    // the board for the viewer while every tracked row reads /stats made each
    // comparison wrong by that difference, which is small enough to look like
    // rounding. Personal Leaderboards is therefore /stats on both sides, and
    // matches what a profile page shows.
    const latest = currentUserKarmaSnapshots[currentUserKarmaSnapshots.length - 1];
    value = Array.isArray(latest) ? observedNum(latest[1]) : null;
  } else if (kind === "dailyKarma") {
    // No board reports daily karma; measure it from my own persisted series
    // (same policy as tracked users: gains immediately, a 0 needs 30 min).
    const measured = measuredDailyKarma({ karmaSnapshots: currentUserKarmaSnapshots });
    value = measured ? measured.delta : null;
  }
  if (value != null) return value;

  const record = personalRecords[normalizeHandle(identity.handle)];
  return record ? getPersonalValue(record, kind) : null;
}

// ---------------------------------------------------------------------------
// Comparison helpers (shared by string templates and in-place DOM patching)
// ---------------------------------------------------------------------------
function comparisonParts(myValue, theirValue) {
  if (myValue == null || theirValue == null) return null;
  const amount = myValue - theirValue;
  if (amount === 0) return null;
  return {
    text: `${amount > 0 ? "+" : "−"}${fmtNum(Math.abs(amount))}`,
    cls: amount > 0 ? "be-leader-comparison-ahead" : "be-leader-comparison-behind",
  };
}

// An always-present, possibly empty, comparison span. Empty spans are hidden via
// `.be-comparison:empty`. Keeping the node stable lets us patch text/class in place
// instead of rebuilding the card, which is what eliminates the glow flicker.
function comparisonSpanHTML(myValue, theirValue, unit, skip) {
  const parts = skip ? null : comparisonParts(myValue, theirValue);
  const cls = parts ? ` ${parts.cls}` : "";
  const text = parts ? `${parts.text} ${unit}` : "";
  return `<span class="be-leader-comparison be-comparison${cls}" data-be-comparison>${escapeHtml(text)}</span>`;
}

function patchComparisonEl(el, myValue, theirValue, unit, skip) {
  if (!el) return;
  const parts = skip ? null : comparisonParts(myValue, theirValue);
  const text = parts ? `${parts.text} ${unit}` : "";
  setTextIfChanged(el, text);
  el.classList.toggle("be-leader-comparison-ahead", !!parts && parts.cls === "be-leader-comparison-ahead");
  el.classList.toggle("be-leader-comparison-behind", !!parts && parts.cls === "be-leader-comparison-behind");
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

function renderAllTimeLeaderboard() {
  if (!isFeatureEnabled("allTimeLeaderboard")) {
    removeAllTimeLeaderboard();
    return;
  }
  // Reached from the intake path too, which fires on any relayed profile
  // response — including on a profile page, where the slow path below would
  // otherwise start an 8-second waitFor poll per response.
  if (!isLeaderboardPage()) {
    removeAllTimeLeaderboard();
    return;
  }
  // Nothing known yet (a cleared roster before the seed applies): show nothing
  // rather than an empty skeleton. Absence is the honest state, and it is what
  // v0.13.1 chose deliberately when the endpoint died.
  if (!allTimeRoster || !rosterCoverage(allTimeRoster)) {
    removeAllTimeLeaderboard();
    return;
  }
  // Fast path: if panel already exists skip waitFor to avoid async races.
  const existingPanel = document.getElementById("be-alltime-leaderboard");
  if (existingPanel) {
    if (!isLeaderboardPage()) return;
    _applyAllTimeContent(existingPanel);
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
    _applyAllTimeContent(panel);
  });
}

function _applyAllTimeContent(panel) {
  // Build the static skeleton once; thereafter reconcile the grid in place.
  let grid = panel.querySelector(".be-native-grid");
  if (!grid) {
    panel.innerHTML = `
      <h3 class="be-native-title">Top Observed Learners</h3>
      <p class="be-native-subtitle" data-be-subtitle hidden></p>
      <p class="be-native-subtitle be-alltime-coverage" data-be-coverage hidden></p>
      <div class="be-native-grid-wrap">
        <div class="be-native-grid"></div>
      </div>`;
    grid = panel.querySelector(".be-native-grid");
  }

  const currentIdentity = getCurrentUserIdentity();
  const board = buildAllTimeBoardRows(allTimeRoster, currentIdentity.handle);
  updateAllTimeSubtitle(panel, board);
  const myXP = getMyValue("xp");

  const items = board.rows.map((row) => ({
    ...row,
    displayName: getDisplayName(row.entry, row.handle),
  }));

  reconcileKeyedChildren(
    grid,
    items,
    (it) => it.key,
    (it) => elementFromHTML(allTimeCardHTML(it, myXP)),
    (el, it) => patchAllTimeCard(el, it, myXP)
  );
}

function allTimeCardHTML(it, myXP) {
  return `<div class="be-leader-card${it.isCurrentUser ? " be-current-user" : ""}${it.outsideBoard ? " be-leader-outside" : ""}">
      <a href="${escapeHtml(it.href || "#")}" class="be-leader-link"${allTimeRowTitleAttr(it)}>
        <span class="be-leader-rank">${escapeHtml(allTimePositionText(it))}</span>
        ${renderLeaderAvatar(it.entry, it.displayName)}
        <span class="be-leader-copy">
          <span class="be-leader-name">${escapeHtml(it.displayName)}</span>
          <span class="be-leader-xp">${allTimeXpText(it)}</span>
          ${comparisonSpanHTML(myXP, it.xp, "xp", it.isCurrentUser || it.xp == null || !isComparisonEnabled("comparisonsAllTime"))}
        </span>
      </a>
    </div>`;
}

function patchAllTimeCard(el, it, myXP) {
  el.classList.toggle("be-current-user", it.isCurrentUser);
  el.classList.toggle("be-leader-outside", Boolean(it.outsideBoard));
  const link = el.querySelector(".be-leader-link");
  const href = it.href || "#";
  if (link && link.getAttribute("href") !== href) link.setAttribute("href", href);
  const title = allTimeRowTitle(it);
  if (link) {
    if (title) {
      if (link.getAttribute("title") !== title) link.setAttribute("title", title);
    } else {
      link.removeAttribute("title");
    }
  }
  setTextIfChanged(el.querySelector(".be-leader-rank"), allTimePositionText(it));
  patchLeaderAvatar(el, it.entry, it.displayName);
  setTextIfChanged(el.querySelector(".be-leader-name"), it.displayName);
  setTextIfChanged(el.querySelector(".be-leader-xp"), allTimeXpText(it));
  patchComparisonEl(el.querySelector("[data-be-comparison]"), myXP, it.xp, "xp", it.isCurrentUser || it.xp == null || !isComparisonEnabled("comparisonsAllTime"));
}


// A number here means "Nth highest XP among the learners Catalyst has observed",
// never a Boot.dev position — Boot.dev stopped publishing those on 2026-08-20.
// The viewer's appended row has no position at all, because their standing
// among people Catalyst does not track is exactly what cannot be known.
function allTimePositionText(it) {
  return it.outsideBoard || it.position == null ? "you" : String(it.position);
}

function allTimeXpText(it) {
  return it.xp == null ? "xp unknown" : `${fmtNum(it.xp)} xp`;
}

// Freshness is disclosed per row rather than implied. A row can legitimately be
// weeks old, and saying when it was read is what keeps that honest.
function allTimeRowTitle(it) {
  const parts = [];
  if (it.profileAt) parts.push(`XP read ${describeAge(it.profileAt)}`);
  if (it.rankAt) parts.push(`rank confirmed ${describeAge(it.rankAt)}`);
  return parts.join(" · ");
}

function allTimeRowTitleAttr(it) {
  const title = allTimeRowTitle(it);
  return title ? ` title="${escapeHtml(title)}"` : "";
}

function describeAge(atMs) {
  const ms = Date.now() - (num(atMs) || 0);
  if (ms < 60 * 60 * 1000) return "just now";
  const hours = Math.round(ms / (60 * 60 * 1000));
  if (hours < 24) return `${hours} hour${hours === 1 ? "" : "s"} ago`;
  const days = Math.round(hours / 24);
  return `${days} day${days === 1 ? "" : "s"} ago`;
}

// Two lines. The first mirrors the native boards' "You are in position N of M
// total students" — the position is now the viewer's own
// LeaderboardXPRankAlltime and the count comes from /v1/leaderboard_stats
// (findTotalStudents, which scraped it out of a native subtitle, is gone). The
// second states how much of the board Catalyst actually knows, because the
// panel must not imply a completeness it cannot have.
function updateAllTimeSubtitle(panel, board) {
  const sub = panel.querySelector("[data-be-subtitle]");
  const coverageEl = panel.querySelector("[data-be-coverage]");

  if (sub) {
    // Boot.dev replaced the exact rank with a percentile band on 2026-08-20, so
    // this is the only self-position it still publishes. Shown verbatim and
    // never converted into an estimated rank: one band covers lifetime XP from
    // 930,102 to 1,741,426 (measured), i.e. thousands of positions.
    const percentile = num(allTimeRoster?.self?.percentile);
    const total = getTotalStudents();
    if (percentile == null) {
      sub.hidden = true;
      setTextIfChanged(sub, "");
    } else {
      sub.hidden = false;
      // Raw numbers (no thousands separators) to match the native subtitle exactly.
      setTextIfChanged(sub, total != null
        ? `You are in the top ${percentile}% of ${total} learners`
        : `You are in the top ${percentile}% of learners`);
    }
  }

  if (coverageEl) {
    coverageEl.hidden = false;
    // Says what the board actually is. Boot.dev publishes no positions any more,
    // so these are Catalyst's own observations ordered by lifetime XP — the
    // panel must not imply it is reproducing a Boot.dev ranking.
    //
    // Deliberately NO count. The roster size is not the number of learners
    // Catalyst has observed: simply opening this page shows it a hundred-odd
    // people across the native boards, and the roster only retains the highest
    // XP among them. Printing 28 would understate the observation and overstate
    // its precision at the same time. Counting truthfully would mean keeping a
    // set of every handle ever seen, which is storage spent to print a number
    // nobody needs.
    setTextIfChanged(coverageEl,
      "Ordered by lifetime XP among the top learners Catalyst has observed · updated as you browse");
  }
}

// Default avatar for users with no profile image, matching Boot.dev's native
// look (a generic silhouette) instead of an initial-letter tile. Inline SVG so
// there is no remote dependency: Boot.dev hot-links a third-party image for this,
// which we deliberately avoid (keeps the "transmits nothing off-device" guarantee).
const DEFAULT_AVATAR_MARKUP =
  '<span class="be-leader-avatar-fallback" aria-hidden="true">' +
  '<svg viewBox="0 0 24 24" class="be-leader-avatar-silhouette" focusable="false">' +
  '<circle cx="12" cy="9" r="5.7"/>' +
  '<circle cx="12" cy="24.3" r="10"/>' +
  '</svg></span>';

// A cheap fingerprint of everything renderLeaderAvatar draws, stamped onto the
// element it describes. The in-place patchers (patchPersonalRow /
// patchAllTimeCard) update rank, name, value and comparison but never touched
// the avatar subtree, so a row first drawn before its profile arrived — a fresh
// install, or straight after a backup import, since the backup carries handles
// and snapshots but not profiles — kept its silhouette and its missing frame
// until the page was reloaded. Comparing signatures lets the patchers rebuild
// only that subtree, only when it actually changed.
//
// displayName is part of the signature because the avatar's alt text is the one
// thing inside the subtree no other patch statement covers.
function leaderAvatarSignature(entry, displayName) {
  const name = displayName || getDisplayName(entry, getHandle(entry));
  return [getAvatarUrl(entry), getRoleFrameUrl(entry), getRoleFrameIndex(entry), name].join("|");
}

// Rebuild the avatar subtree in place when its signature changed. Deliberately
// scoped to the avatar span: replacing the row itself would re-mount the node
// carrying the current-user glow, which is exactly what the in-place patching
// exists to avoid.
function patchLeaderAvatar(rowEl, entry, displayName) {
  const existing = rowEl.querySelector(".be-leader-avatar");
  if (!existing) return; // fail open: both row builders always emit one
  const signature = leaderAvatarSignature(entry, displayName);
  if (existing.getAttribute("data-be-avatar-sig") === signature) return;
  const replacement = elementFromHTML(renderLeaderAvatar(entry, displayName));
  if (replacement) existing.replaceWith(replacement);
}

function renderLeaderAvatar(entry, displayName) {
  const avatar = getAvatarUrl(entry);
  const frameUrl = getRoleFrameUrl(entry);
  const name = displayName || getDisplayName(entry, getHandle(entry));
  const avatarMarkup = avatar
    ? `<img src="${escapeHtml(avatar)}" alt="${escapeHtml(name)} avatar" class="be-leader-avatar-img">`
    : DEFAULT_AVATAR_MARKUP;

  // Size the frame and the inner avatar to this tier's ring geometry so combos
  // match across tiers. With no frame (unrecognized tier, or the no-art preview)
  // the avatar fills the box at the combo's overall size instead of the small
  // ring-hole size, so it doesn't look shrunken next to framed rows.
  const frameIndex = getRoleFrameIndex(entry);
  const hasFrame = Boolean(frameUrl);
  let avatarClass = "be-leader-avatar";
  let innerStyle = "";
  let frameStyle = "";
  if (!hasFrame) {
    avatarClass += " be-no-frame";
  } else if (frameIndex >= 0 && frameIndex < FRAME_INNER_PCT.length) {
    innerStyle = ` style="--be-avatar-inner: ${FRAME_INNER_PCT[frameIndex]}%"`;
    frameStyle = ` style="--be-frame-scale: ${FRAME_DISPLAY_SCALE[frameIndex]}"`;
  } else {
    innerStyle = ` style="--be-avatar-inner: ${DEFAULT_INNER_PCT}%"`;
  }

  const frameMarkup = hasFrame
    ? `<img src="${escapeHtml(frameUrl)}" alt="" class="be-leader-frame"${frameStyle} aria-hidden="true">`
    : "";

  return `<span class="${avatarClass}" data-be-avatar-sig="${escapeHtml(leaderAvatarSignature(entry, name))}">
    <span class="be-leader-avatar-inner"${innerStyle}>${avatarMarkup}</span>
    ${frameMarkup}
  </span>`;
}

// ---------------------------------------------------------------------------
// Native section comparison augmentation
// ---------------------------------------------------------------------------
// Boot.dev renders four native leaderboard boards (League daily + standing,
// Global daily + community). We can't read their values from the DOM, so each
// board is matched to the API response that feeds it and a comparison vs. our own
// value is appended into the card's text column, beneath the native value.
// Comparisons are patched in place (never torn down) so they never flicker.

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
  "top observed learners",
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
      value = readNum(entry, field);
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
    const value = readNum(mine, field);
    if (value != null) return value;
  }
  return null;
}

function augmentNativeSection(heading, dataByHandle, myValue, unit) {
  if (!heading || myValue == null) return;
  for (const link of nativeCardsForHeading(heading)) {
    // FRAGILE: positional DOM assumption. Boot.dev's native card lays out as
    // [rank, avatar, textColumn]; we append the comparison into that last text
    // column so it sits beneath the native value. A card-layout change on a
    // redeploy would land the comparison in the wrong place (or nowhere).
    const column = link.lastElementChild;
    if (!column) continue;
    const handle = normalizeHandle(getProfileHandleFromHref(link.getAttribute("href")));
    const theirValue = handle ? dataByHandle[handle] : null;
    applyNativeComparison(column, myValue, theirValue, unit, theirValue == null);
  }
}

function applyNativeComparison(column, myValue, theirValue, unit, skip) {
  let el = column.querySelector(":scope > .be-native-comparison");
  const parts = skip ? null : comparisonParts(myValue, theirValue);
  if (!parts) {
    if (el) el.remove();
    return;
  }
  if (!el) {
    el = document.createElement("span");
    el.className = "be-leader-comparison be-native-comparison";
    column.appendChild(el);
  }
  setTextIfChanged(el, `${parts.text} ${unit}`);
  el.classList.toggle("be-leader-comparison-ahead", parts.cls === "be-leader-comparison-ahead");
  el.classList.toggle("be-leader-comparison-behind", parts.cls === "be-leader-comparison-behind");
}

function augmentNativeLeagueDaily() {
  const heading = findHeadingAfter(findHeadingByText("League Leaderboards"), "Top Daily Learners");
  if (!isComparisonEnabled("comparisonsLeagueDaily")) return stripNativeSection(heading);
  augmentNativeSection(
    heading,
    mapByHandle(cachedLeagueDailyEntries, "XPEarned"),
    // A league is a small pool, so if we aren't on the board we've earned 0 today.
    leagueMyValueOrZero(cachedLeagueDailyEntries, "XPEarned"),
    "xp"
  );
}

function augmentNativeLeagueStanding() {
  const heading = findHeadingAfter(findHeadingByText("League Leaderboards"), "Top League Learners");
  if (!isComparisonEnabled("comparisonsLeagueStanding")) return stripNativeSection(heading);
  augmentNativeSection(
    heading,
    mapByHandle(cachedLeagueEntries, "XPEarned"),
    // Newly assigned to a league with no XP yet -> not listed -> treat as 0.
    leagueMyValueOrZero(cachedLeagueEntries, "XPEarned"),
    "xp"
  );
}

// Our own value on a league board. Absence means 0 (small pool), but only once
// the board data has actually loaded — with an empty cache there are no cards to
// annotate anyway, so returning null there avoids a misleading "0" comparison.
//
// "I am not on this board" and "this field moved" are indistinguishable from a
// single missing read, and only the first is genuinely 0. So if NO entry on a
// non-empty board yields the field, treat it as unreadable and return null:
// otherwise a rename tells the user they are exactly each league-mate's entire
// score behind, which is the plausible-wrong-value failure that is harder to
// notice than a blank.
function leagueMyValueOrZero(entries, ...fields) {
  if (!entries.length) return null;
  const readable = entries.some((entry) => fields.some((field) => readNum(entry, field) != null));
  if (!readable) return null;
  return myValueFromEntries(entries, ...fields) ?? 0;
}

function augmentNativeDailyLeaderboard() {
  const heading = findHeadingAfter(findHeadingByText("Global Leaderboards"), "Top Daily Learners");
  if (!isComparisonEnabled("comparisonsGlobalDaily")) return stripNativeSection(heading);
  augmentNativeSection(
    heading,
    // XPEarned only — see the note in getMyValue: XP here is the lifetime
    // total and would render six-figure "daily" comparisons.
    mapByHandle(cachedDailyEntries, "XPEarned"),
    getMyValue("daily"),
    "xp"
  );
}

// The comparison rendered ON Boot.dev's own karma board is measured against
// that board's own figure for the viewer, because every other number in that
// section came from the same response. The /stats value is the fallback for a
// viewer outside the top 25, where the board has nothing to offer — it is the
// same measure from Boot.dev's other karma surface, which currently reads a
// few points lower (see getMyValue).
function myKarmaForNativeBoard() {
  return myValueFromEntries(cachedKarmaEntries, "Karma") ?? getMyValue("karma");
}

function augmentNativeKarmaLeaderboard() {
  const heading = findHeadingAfter(findHeadingByText("Global Leaderboards"), "Top Community Members");
  if (!isComparisonEnabled("comparisonsGlobalKarma")) return stripNativeSection(heading);
  augmentNativeSection(
    heading,
    mapByHandle(cachedKarmaEntries, "Karma"),
    myKarmaForNativeBoard(),
    "karma"
  );
}

// Remove the comparisons this extension injected into one native board (used when a
// board's comparison toggle is off). The cards themselves are Boot.dev's; we only
// strip our own appended `.be-native-comparison` spans.
function stripNativeSection(heading) {
  if (!heading) return;
  for (const link of nativeCardsForHeading(heading)) {
    link.querySelector(":scope > * > .be-native-comparison")?.remove();
  }
}

// Strip every injected native comparison in one pass (used when the master toggle
// goes off, regardless of which board is in view).
function removeNativeComparisons() {
  document.querySelectorAll(".be-native-comparison").forEach((el) => el.remove());
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
    const meOnBoard = Boolean(allTimeRoster?.entries?.[normalizeHandle(currentIdentity.handle)]);
    if (!allTime || (meOnBoard && !allTime.querySelector(".be-current-user"))) {
      renderAllTimeLeaderboard();
    }
  }

  // Personal: ensure it exists and stays pinned above the native boards.
  if (anyPersonalBoardEnabled()) {
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

// Personal Leaderboards is pinned to the top of the leaderboard content, above
// the native League/Global boards — users care most about their own list, and it
// looked out of place wedged between the Global sections. Native sections are
// separated by <hr> dividers, so we anchor to that sibling level; this keeps the
// panel in the content and can't escape into the nav (a previous walk-to-<main>
// heuristic did exactly that).
function findPersonalLeaderboardInsertionPoint() {
  const heading = findHeadingByText("League Leaderboards") || findHeadingByText("Global Leaderboards");
  if (!heading) return null;
  // FRAGILE: structural assumption. Native leaderboard sections are separated by
  // <hr> elements; we anchor to the section block whose parent also holds those
  // dividers. Anchored to the semantic HR tag (not a hashed class), so it's more
  // durable than class-based anchoring but still depends on that divider layout.
  let node = heading;
  while (node.parentElement && node.parentElement !== document.body) {
    if (Array.from(node.parentElement.children).some((c) => c.tagName === "HR")) {
      return node;
    }
    node = node.parentElement;
  }
  return heading;
}

// Keep [personal panel] [divider] [native boards] in order, idempotently, so the
// 2-second scan never thrashes the DOM once everything is in place.
function ensurePersonalPlacement(panel) {
  const block = findPersonalLeaderboardInsertionPoint();
  if (!block) return;
  const divider = ensurePersonalDivider();
  if (block.previousElementSibling !== divider) {
    block.insertAdjacentElement("beforebegin", divider);
  }
  if (divider.previousElementSibling !== panel) {
    divider.insertAdjacentElement("beforebegin", panel);
  }
}

// A gray rule matching the native section dividers (<hr class="mx-8 border-gray-600">).
function ensurePersonalDivider() {
  let divider = document.getElementById("be-personal-divider");
  if (!divider) {
    divider = document.createElement("hr");
    divider.id = "be-personal-divider";
    divider.className = "be-section-divider";
  }
  return divider;
}

// ===========================================================================
// FEATURE 4: Manual personal leaderboards
// ===========================================================================
// Harvest total-XP snapshots for tracked users from any leaderboard response.
// With `backdate` (daily boards only), each sighting also yields a second,
// backdated point: XPEarned is the trailing-24h XP as of the response, so the
// user's total exactly 24h ago was XP - XPEarned. That single sighting gives a
// near-full measurement window even after the user drops off the board. Never
// backdate an alltime board — there XPEarned equals XP, which would fabricate
// a zero-XP point 24h ago. `asOf` is when the response was received; it anchors
// the snapshot timestamps when harvesting a board cached earlier in the session.
function harvestPersonalSnapshots(entries, { backdate = false, asOf = 0 } = {}) {
  let changed = false;
  const now = Date.now();
  const at = asOf || now;

  for (const entry of entries) {
    const handle = normalizeHandle(getHandle(entry));
    if (!handle || !isPersonalHandle(handle)) continue;

    const total = readNum(entry, "XP");
    if (total == null) continue;

    const record = ensurePersonalRecord(handle);
    recordXpSnapshot(record, total, at);
    if (backdate) {
      const earned = readNum(entry, "XPEarned");
      if (earned != null && earned >= 0 && earned <= total) {
        recordXpSnapshot(record, total - earned, at - DAY_WINDOW_MS);
      }
    }
    record.updatedAt = now;
    changed = true;
  }

  if (changed) {
    savePersonalCache();
    schedulePersonalLeaderboardRender();
  }
}

// Re-harvest every board response received this session. Run when a handle is
// added: the per-response harvests only cover handles tracked at arrival time,
// so without this a new user already sitting on a cached board (a league-mate
// especially) would show an estimate until the next page load refetches.
//
// The all-time board is absent here on purpose. Snapshots are timestamped
// observations, and the roster holds stored values of unknown age — replaying
// them with a fresh timestamp is exactly how the measured daily-XP tier gets
// poisoned. Roster refreshes reach the snapshot store the correct way, at
// arrival time, through updatePersonalUserData.
function harvestCachedBoardSnapshots() {
  if (boardSeenAt.daily) harvestPersonalSnapshots(cachedDailyEntries, { backdate: true, asOf: boardSeenAt.daily });
  if (boardSeenAt.leagueDaily) harvestPersonalSnapshots(cachedLeagueDailyEntries, { backdate: true, asOf: boardSeenAt.leagueDaily });
  if (boardSeenAt.league) harvestPersonalSnapshots(cachedLeagueEntries, { asOf: boardSeenAt.league });

}

// Persist a distilled handle->XPEarned lookup for a daily board so the exact
// tier survives a page refresh (see DAILY_BOARD_PERSIST_TTL_MS).
function persistDailyBoardLookup(boardKey, entries) {
  const byHandle = {};
  for (const entry of entries) {
    const handle = normalizeHandle(getHandle(entry));
    const earned = readNum(entry, "XPEarned");
    if (handle && earned != null) byHandle[handle] = earned;
  }
  persistedDailyBoards[boardKey] = { byHandle, seenAt: Date.now() };
  chromeSet(DAILY_BOARD_CACHE_KEY, persistedDailyBoards);
}

function handleDailyXpLeaderboard(json) {
  const entries = getLeaderboardEntries(json);
  // An unreadable response must not overwrite what is already known. Without
  // this, persistDailyBoardLookup stores an empty map and markBoardSeen makes
  // dailyBoardXpFor skip the persisted fallback, so one bad response costs the
  // exact daily tier for the rest of the session. Matches handleKarmaLeaderboard.
  if (!entries.length) return;
  reportUsableFields("/v1/leaderboard_xp/day", entries, "XPEarned", (e) => readField(e, "XPEarned"));
  cachedDailyEntries = entries;
  markBoardSeen("daily");
  persistDailyBoardLookup("daily", entries);
  harvestPersonalSnapshots(entries, { backdate: true });
  noteAllTimeBoardEntries(entries);
  if (isLeaderboardPage()) augmentNativeDailyLeaderboard();
}

function handleKarmaLeaderboard(json) {
  const entries = getLeaderboardEntries(json);
  if (!entries.length) return;
  // Karma has no second source, so a rename here shows up as a permanent
  // "Not enough data yet" — indistinguishable from a normal cold start.
  reportUsableFields("/v1/leaderboard_karma/alltime", entries, "Karma", (e) => readField(e, "Karma"));
  cachedKarmaEntries = entries;
  markBoardSeen("karma");
  // The board no longer feeds the karma snapshot series, for the viewer or for
  // tracked users. It reads a few points higher than the same person's /stats,
  // so alternating sources put steps into a series whose whole purpose is
  // measuring change — a phantom gain or loss of the size of the discrepancy,
  // in a feature that already fabricated a value three times by other means.
  // The series advances on /stats refreshes, which run on every leaderboard
  // visit for every tracked handle.
  // The karma board is the single most productive discovery source a typical
  // install has: it surfaced 4 of the top 25 on its own (2026-08-14).
  noteAllTimeBoardEntries(entries);
  if (isLeaderboardPage()) augmentNativeKarmaLeaderboard();
}

// Record an observation of my own karma total. Persisted (with the handle it
// belongs to) so the measured window survives reloads, like tracked users'.
function recordCurrentUserKarma(karma, atMs = Date.now()) {
  if (!currentUserHandle) return;
  const snaps = updateSnapshotSeries(currentUserKarmaSnapshots, karma, atMs);
  if (!snaps) return;
  currentUserKarmaSnapshots = snaps;
  void mergeWrite(CURRENT_USER_KARMA_KEY, (stored) => {
    // Only the same user's series can be merged; a different handle stored here
    // belongs to a previous login and is replaced, as it is on a handle change.
    const sameUser = isPlainObject(stored) && normalizeHandle(stored.handle) === currentUserHandle;
    const merged = sameUser
      ? mergeObservedSeries(snaps, stored.snapshots, atMs)
      : snaps;
    currentUserKarmaSnapshots = merged;
    return { handle: currentUserHandle, snapshots: merged };
  });
  schedulePersonalLeaderboardRender();
}

// My own lifetime XP, refreshed on its own schedule rather than as part of the
// Observed board's pass. It backs every All-Time XP comparison, and while it
// lived inside requestAllTimeRosterRefresh it was skipped entirely whenever
// that board was switched off — leaving the league boards as the only source,
// which do not always carry the viewer. currentUserLiveXp stays session-only
// and is never restored from storage (v0.13.1: a stored copy of "me" silently
// wrong-footed every comparison), so this is what refills it.
const CURRENT_USER_XP_TTL_MS = 10 * 60 * 1000;
let currentUserXpFetchedAt = 0;

async function refreshCurrentUserXp() {
  if (!currentUserHandle) return;
  const now = Date.now();
  if (now - currentUserXpFetchedAt < CURRENT_USER_XP_TTL_MS) return;
  currentUserXpFetchedAt = now;
  const result = await fetchApiJsonWithAuthRetry(
    `https://api.boot.dev/v1/users/public/${encodeURIComponent(currentUserHandle)}`
  );
  if (result.status < 200 || result.status >= 300) {
    currentUserXpFetchedAt = 0; // a failure must not hold the TTL open
    return;
  }
  const data = result.json?.data ?? result.json;
  recordCurrentUserLiveXp(readNum(data, "XP"));
}

// My own stats request, issued alongside the tracked-handle refreshes: my
// karma is otherwise only visible when I'm on the top-25 karma board, and the
// Daily Karma comparisons need a baseline of me to compare against.
async function refreshCurrentUserKarma() {
  if (!currentUserHandle) return;
  const result = await fetchApiJsonWithAuthRetry(
    `https://api.boot.dev/v1/users/public/${encodeURIComponent(currentUserHandle)}/stats`
  );
  if (result.status < 200 || result.status >= 300) return;
  const data = result.json?.data ?? result.json;
  recordCurrentUserKarma(readField(data, "Karma"));
}

// harvestPersonalKarmaSnapshots was removed in v0.15.1 with its last consumer.
// It recorded karma snapshots for tracked users from the all-time karma board;
// that board is no longer a source for the series (see handleKarmaLeaderboard),
// because it and /stats disagree and a series must come from one of them.

// /v1/leaderboard_xp/{week,month}: no longer available — confirmed returning
// 400 "Invalid timeframe" on 2026-09-19; the date they stopped working is
// unknown, so nothing requests these any more — see the discovery note in
// allTimeRoster.js. The handler is kept anyway, on the same reasoning that kept
// the all-time board's: if Boot.dev restores either timeframe, its response is
// already relayed and routed, and the roster starts learning from it again with
// no further change. DISCOVERY AND LIFETIME XP ONLY —
// XPEarned here covers 7 or 30 days, so it must never reach computeDailyXpView,
// the daily comparisons, or a backdated snapshot, where XP - XPEarned would
// fabricate a total from a week ago and hand it to the 24-hour window. A plain
// non-backdated harvest is correct and useful, exactly as for the league
// standing board.
function handleXpDiscoveryBoard(json) {
  const entries = getLeaderboardEntries(json);
  if (!entries.length) return;
  harvestPersonalSnapshots(entries);
  noteAllTimeBoardEntries(entries);
  recordCurrentUserLiveXp(myValueFromEntries(entries, "XP"));
}

function handleLeagueDailyLeaderboard(json) {
  const entries = getLeaderboardEntries(json);
  if (!entries.length) return; // see handleDailyXpLeaderboard
  reportUsableFields("/v1/league_leaderboard_xp/day", entries, "XPEarned", (e) => readField(e, "XPEarned"));
  cachedLeagueDailyEntries = entries;
  markBoardSeen("leagueDaily");
  persistDailyBoardLookup("leagueDaily", cachedLeagueDailyEntries);
  harvestPersonalSnapshots(cachedLeagueDailyEntries, { backdate: true });
  noteAllTimeBoardEntries(cachedLeagueDailyEntries);
  recordCurrentUserLiveXp(myValueFromEntries(cachedLeagueDailyEntries, "XP"));
  if (isLeaderboardPage()) {
    augmentNativeLeagueDaily();
    augmentNativeDailyLeaderboard(); // league-daily is a fallback for our own daily value
  }
}

function handleLeagueLeaderboard(json) {
  const entries = getLeaderboardEntries(json);
  reportUsableFields("/v1/league_leaderboard_xp/alltime", entries, "XPEarned", (e) => readField(e, "XPEarned"));
  cachedLeagueEntries = entries;
  markBoardSeen("league");
  harvestPersonalSnapshots(cachedLeagueEntries);
  noteAllTimeBoardEntries(cachedLeagueEntries);
  recordCurrentUserLiveXp(myValueFromEntries(cachedLeagueEntries, "XP"));
  if (isLeaderboardPage()) augmentNativeLeagueStanding();
}

function updatePersonalUserData(username, isStats, json) {
  const requestedHandle = normalizeHandle(username);
  const data = json?.data ?? json;
  const responseHandle = normalizeHandle(readField(data, "Handle"));
  // Every per-user response is an all-time observation too, whoever asked for
  // it — Boot.dev's own profile-page fetches included. Runs before the personal
  // handling below because it is independent of whether this handle is tracked.
  noteAllTimeObservation(responseHandle || requestedHandle, isStats, json);
  if (!isStats && (responseHandle || requestedHandle) === normalizeHandle(currentUserHandle)) {
    recordCurrentUserLiveXp(readNum(data, "XP"));
  }
  // My own stats response feeds the current-user karma series even when I'm not
  // a tracked handle. Both branches route through here, but only /stats carries
  // a karma field (the public profile has none), so the profile branch is a
  // harmless no-op — recordCurrentUserKarma ignores a non-numeric value.
  if ((responseHandle || requestedHandle) === currentUserHandle) {
    recordCurrentUserKarma(readField(data, "Karma"));
  }
  const handle = isPersonalHandle(responseHandle) ? responseHandle : requestedHandle;
  if (!handle || !isPersonalHandle(handle)) return;

  const record = ensurePersonalRecord(handle);
  record.handle = readField(data, "Handle") || record.handle || handle;
  if (isStats) {
    record.stats = data;
    recordKarmaSnapshot(record, readField(data, "Karma"));
  } else {
    // No karma snapshot here: the public profile response has no karma field
    // (see getPersonalValue). A tracked user's karma series advances on /stats
    // refreshes and karma-board sightings only.
    record.profile = data;
    recordXpSnapshot(record, readField(data, "XP"));
  }
  record.updatedAt = Date.now();

  savePersonalCache();
  schedulePersonalLeaderboardRender();
}

async function loadPersonalLeaderboard() {
  const storedHandles = (await chromeGet(PERSONAL_HANDLES_KEY)) || {};
  const storedCache = (await chromeGet(PERSONAL_CACHE_KEY)) || {};
  const storedBoards = await chromeGet(DAILY_BOARD_CACHE_KEY);
  if (enhancerStopped) return;
  persistedDailyBoards = isPlainObject(storedBoards) ? storedBoards : {};
  const rawHandles = Array.isArray(storedHandles)
    ? storedHandles
    : Array.isArray(storedHandles.handles)
      ? storedHandles.handles
      : [];

  personalHandles = uniqueHandles(rawHandles).filter(isValidHandle);
  personalRecords = isPlainObject(storedCache.records) ? storedCache.records : {};
  for (const handle of personalHandles) ensurePersonalRecord(handle);

  // Drop fields from the pre-0.6.1 single-baseline daily model (replaced by
  // xpSnapshots) so stale values can't leak into the new display ladder.
  let droppedLegacyFields = false;
  for (const record of Object.values(personalRecords)) {
    for (const key of ["dailyXp", "dailyBaselineDate", "dailyBaselineXp", "dailyObservedXp"]) {
      if (key in record) {
        delete record[key];
        droppedLegacyFields = true;
      }
    }
  }

  if (personalHandles.length !== rawHandles.length) {
    savePersonalHandles();
    savePersonalCache();
  } else if (droppedLegacyFields) {
    savePersonalCache();
  }
}

// True when at least one saved handle has no fetched profile yet, i.e. we'd need
// to pull data. Used to skip refetching when re-enabling a feature whose data is
// already in memory (records persist through storage cache across sessions).
function personalDataMissing() {
  return personalHandles.some((handle) => !personalRecords[normalizeHandle(handle)]?.profile);
}

// True when any native-board data is already cached (turning comparisons back on
// then needs no fetch).
function hasNativeComparisonData() {
  return Boolean(
    cachedDailyEntries.length ||
    cachedKarmaEntries.length ||
    cachedLeagueDailyEntries.length ||
    cachedLeagueEntries.length
  );
}

function requestPersonalLeaderboardData() {
  if (!anyPersonalBoardEnabled()) return;
  if (!isLeaderboardPage() || !personalHandles.length) return;

  // The daily board is requested by requestNativeLeaderboardData, which always
  // runs on the leaderboard page; no need to re-request it here.
  void refreshCurrentUserKarma();
  for (const handle of personalHandles) {
    void refreshPersonalHandle(handle);
  }
}

// Source data for native-section comparisons (karma + league boards). Independent of
// personal handles so comparisons show even with no saved handles, and useful when the
// extension loads into an already-open leaderboard page Boot.dev won't re-fetch.
function requestNativeLeaderboardData() {
  if (!isLeaderboardPage()) return;
  // These boards exist only to compute comparisons; with the master toggle off
  // nothing consumes them, so skip the four requests entirely.
  if (!isFeatureEnabled("comparisons")) return;
  // Skip a board Boot.dev just fetched (we caught it passively) to avoid the
  // initial-load double-fetch; a stale open page has no recent data and refetches.
  if (!boardFresh("daily")) requestApiJson(DAILY_LEADERBOARD_URL);
  if (!boardFresh("karma")) requestApiJson(KARMA_LEADERBOARD_URL);
  if (!boardFresh("leagueDaily")) requestApiJson(LEAGUE_DAILY_LEADERBOARD_URL);
  if (!boardFresh("league")) requestApiJson(LEAGUE_LEADERBOARD_URL);
}

function schedulePersonalLeaderboardRender() {
  if (!isLeaderboardPage()) return;
  clearTrackedTimeout(personalRenderTimer);
  personalRenderTimer = setTrackedTimeout(renderPersonalLeaderboards, 50);
}

function renderPersonalLeaderboards() {
  personalRenderTimer = null;
  if (!anyPersonalBoardEnabled()) {
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

// Static board definitions: which kind of value each board shows, its unit,
// and the per-board settings flag (see PERSONAL_BOARD_TOGGLES in the schema).
const PERSONAL_BOARDS = [
  { title: "Daily XP", kind: "daily", unit: "xp", settingKey: "personalBoardDailyXp" },
  { title: "All-Time XP", kind: "xp", unit: "xp", settingKey: "personalBoardAllTimeXp" },
  { title: "Daily Karma", kind: "dailyKarma", unit: "karma", settingKey: "personalBoardDailyKarma" },
  { title: "All-Time Karma", kind: "karma", unit: "karma", settingKey: "personalBoardAllTimeKarma" },
];

// True when the Personal Leaderboards section has anything to show: the master
// toggle AND at least one of the four boards. All boards off hides the whole
// section (and stops its data requests) until one is re-enabled.
function anyPersonalBoardEnabled() {
  return PERSONAL_BOARDS.some((b) => isPersonalBoardEnabled(b.settingKey));
}

// Build the persistent panel skeleton once. The form, chips container, message
// slot, and per-board row containers stay mounted across renders so that data
// refreshes patch text in place rather than recreating the glowing cards.
function ensurePersonalSkeleton(panel) {
  if (panel.querySelector(".be-personal-shell")) return;

  const boards = PERSONAL_BOARDS
    .map((b) => `
      <section class="be-personal-board" data-board-key="${b.settingKey}">
        <h4>${escapeHtml(b.title)}</h4>
        <div class="be-personal-rows" data-kind="${b.kind}" data-unit="${b.unit}"></div>
      </section>`)
    .join("");

  panel.innerHTML = `
    <h3 class="be-personal-heading">Personal Leaderboards</h3>
    <div class="be-personal-shell">
      <form id="be-personal-form" class="be-personal-form">
        <input id="be-personal-handle" type="text" autocomplete="off" spellcheck="false" placeholder="Boot.dev handle or profile URL" aria-label="Boot.dev handle or profile URL">
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

  // Rows: reconcile each enabled board in place so unchanged rows are never
  // rebuilt. A toggled-off board is hidden, freeing its grid column so the
  // remaining boards stretch.
  for (const boardEl of panel.querySelectorAll(".be-personal-board")) {
    const enabled = isPersonalBoardEnabled(boardEl.getAttribute("data-board-key"));
    boardEl.hidden = !enabled;
    if (!enabled) continue;
    const rowsEl = boardEl.querySelector(".be-personal-rows");
    if (!rowsEl) continue;
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

function personalValueText(row, unit) {
  if (row.value == null) return row.loading ? "loading" : row.nullText || "unavailable";
  return `${fmtNum(row.value)} ${unit}`;
}

function personalRowHTML(it) {
  const { row, rank, unit, myValue } = it;
  const valueText = personalValueText(row, unit);
  const isCurrentUser = isCurrentLeaderboardEntry(row, getCurrentUserIdentity());
  const skipComparison = isCurrentUser || row.loading || row.value == null || !isComparisonEnabled("comparisonsPersonal");

  return `
    <a class="be-personal-row${isCurrentUser ? " be-current-user" : ""}" href="/u/${encodeURIComponent(row.handle)}">
      <span class="be-personal-rank">${rank}</span>
      ${renderLeaderAvatar(row, row.name)}
      <span class="be-personal-copy">
        <span class="be-personal-name">${escapeHtml(row.name)}</span>
        <span class="be-personal-handle">@${escapeHtml(row.displayHandle)}</span>
      </span>
      <span class="be-personal-value-col"${row.tooltip ? ` title="${escapeHtml(row.tooltip)}"` : ""}>
        <span class="be-personal-value-line">
          <span class="be-personal-value-note">${escapeHtml(row.note)}</span>
          <span class="be-personal-value">${escapeHtml(valueText)}</span>
        </span>
        ${comparisonSpanHTML(myValue, row.value, unit, skipComparison)}
      </span>
    </a>`;
}

function patchPersonalRow(el, it) {
  const { row, rank, unit, myValue } = it;
  const isCurrentUser = isCurrentLeaderboardEntry(row, getCurrentUserIdentity());
  const skipComparison = isCurrentUser || row.loading || row.value == null || !isComparisonEnabled("comparisonsPersonal");
  const valueText = personalValueText(row, unit);

  el.classList.toggle("be-current-user", isCurrentUser);
  const href = `/u/${encodeURIComponent(row.handle)}`;
  if (el.getAttribute("href") !== href) el.setAttribute("href", href);
  setTextIfChanged(el.querySelector(".be-personal-rank"), String(rank));
  patchLeaderAvatar(el, row, row.name);
  setTextIfChanged(el.querySelector(".be-personal-name"), row.name);
  setTextIfChanged(el.querySelector(".be-personal-handle"), `@${row.displayHandle}`);
  setTextIfChanged(el.querySelector(".be-personal-value"), valueText);
  setTextIfChanged(el.querySelector(".be-personal-value-note"), row.note);
  const valueCol = el.querySelector(".be-personal-value-col");
  if (valueCol) {
    if (row.tooltip) {
      if (valueCol.getAttribute("title") !== row.tooltip) valueCol.setAttribute("title", row.tooltip);
    } else {
      valueCol.removeAttribute("title");
    }
  }
  patchComparisonEl(el.querySelector("[data-be-comparison]"), myValue, row.value, unit, skipComparison);
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

  // Delegate on the persistent chips container: the chip buttons are swapped in
  // via innerHTML after this runs, so a per-button handler bound here would never
  // attach. One listener on the container survives every chip re-render.
  const chips = panel.querySelector(".be-personal-chips");
  if (chips) {
    chips.onclick = (event) => {
      const button = event.target.closest("[data-be-remove-handle]");
      if (button) removePersonalHandle(button.getAttribute("data-be-remove-handle"));
    };
  }
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

  const canonical = normalizeHandle(readField(profile, "Handle") || normalized);
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
  record.handle = readField(profile, "Handle") || canonical;
  record.profile = profile;
  record.profileError = null;
  recordXpSnapshot(record, readField(profile, "XP"));
  // No karma here — the profile response has none; refreshPersonalStats below
  // is what opens the karma series.
  // The new handle may already sit on a board received earlier this session
  // (league-daily especially) — harvest those now so the exact/measured tiers
  // apply immediately instead of after the next page load.
  harvestCachedBoardSnapshots();

  if (await savePersonalHandles()) {
    savePersonalCache();
    setPersonalFeedback(`Added @${record.handle}`, "success");
  } else {
    setPersonalFeedback("Could not save user", "error");
  }

  personalPendingHandle = null;
  schedulePersonalLeaderboardRender();
  void refreshPersonalStats(canonical);
  void refreshPersonalHeatmap(canonical);
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
      const view = kind === "daily"
        ? computeDailyXpView(record)
        : kind === "dailyKarma"
          ? computeDailyKarmaView(record)
          : null;
      return {
        handle,
        displayHandle: getPersonalDisplayHandle(handle),
        name: getDisplayName(profile, getPersonalDisplayHandle(handle)),
        avatar: getAvatarUrl(profile),
        Handle: record.handle || handle,
        Level: readField(profile, "Level"),
        Role: readField(profile, "Role"),
        value: view ? view.value : getPersonalValue(record, kind),
        note: view?.note || "",
        tooltip: view?.tooltip || "",
        nullText: view ? "–" : "",
        loading: personalPendingHandle === handle,
      };
    })
    .sort((a, b) => (b.value ?? -1) - (a.value ?? -1) || a.displayHandle.localeCompare(b.displayHandle));
}

function getPersonalValue(record, kind) {
  if (kind === "daily") return computeDailyXpView(record).value;
  if (kind === "dailyKarma") return computeDailyKarmaView(record).value;
  // Karma comes from /stats only. The public profile response carries no karma
  // field in any casing (full key list checked 2026-07-31), so reading it from
  // record.profile was a fallback that could never fire.
  if (kind === "karma") return readNum(record.stats, "Karma");
  return readNum(record.profile, "XP");
}

// ---------------------------------------------------------------------------
// Daily-XP view ladder. The native daily board is a rolling 24h window with no
// per-user API, so accuracy degrades in tiers:
//   1. exact       — the user is on a currently-cached daily board (XPEarned)
//   2. measured    — diff of our own total-XP snapshots inside the 24h window
//   3. estimated   — heatmap completions x avg XP + bonuses (labeled "est.")
//   4. unavailable — "–"
// A short measured window understates the day (it misses XP earned before we
// started watching), so below FULL_WINDOW_TRUST_MS a larger heatmap estimate
// outranks it; at/above that the measurement covers the day and wins.
// ---------------------------------------------------------------------------
function computeDailyXpView(record) {
  const exact = dailyBoardXpFor(record);
  if (exact != null) {
    return { value: exact, note: "", tooltip: "From the live daily leaderboard." };
  }

  const measured = measuredDailyXp(record);
  const estimate = heatmapDailyEstimate(record);

  if (measured && measured.windowMs >= FULL_WINDOW_TRUST_MS) return measuredDailyView(measured);
  if (estimate && estimate.value > 0 && (!measured || estimate.value > measured.delta)) {
    return estimateDailyView(estimate, measured);
  }
  if (measured && measured.delta > 0) return measuredDailyView(measured);
  if (estimate) {
    // Zero-activity heatmap (and no larger measurement): confidently ~0.
    return estimateDailyView(estimate, measured);
  }
  if (measured) return measuredDailyView(measured); // measured 0 with no heatmap signal

  return {
    value: null,
    note: "",
    tooltip: "Not enough data yet. Catalyst accumulates XP observations for tracked users as you browse.",
  };
}

// Exact daily XP when the user is on a currently-cached daily board. The
// league-daily board counts too: XP earned is universal, so a league-mate's
// XPEarned there is exactly what the global daily board would report. Until a
// board has been received this session, the recently-persisted copy of its
// lookup stands in, so a page refresh doesn't flash the measured tier while
// the boards re-fetch. Once live data arrives it is authoritative for that
// board, including the user's absence from it.
function dailyBoardXpFor(record) {
  const handle = normalizeHandle(record.handle);
  if (!handle) return null;

  for (const { entries, key } of [
    { entries: cachedDailyEntries, key: "daily" },
    { entries: cachedLeagueDailyEntries, key: "leagueDaily" },
  ]) {
    if (boardSeenAt[key]) {
      for (const entry of entries) {
        if (normalizeHandle(getHandle(entry)) === handle) {
          const earned = readNum(entry, "XPEarned");
          if (earned != null) return earned;
        }
      }
      continue;
    }
    const persisted = persistedDailyBoards[key];
    const earned = num(persisted?.byHandle?.[handle]);
    if (earned != null && Date.now() - (num(persisted.seenAt) || 0) <= DAILY_BOARD_PERSIST_TTL_MS) {
      return earned;
    }
  }
  return null;
}

// XP measured between our oldest and newest snapshot inside the rolling 24h
// window. A lower bound on the user's true daily XP: exact when the window
// spans the full day (e.g. seeded by a backdated board sighting). Reads with
// the same slack the pruner keeps, so a backdated point at exactly now-24h
// stays usable instead of aging out of the window the moment it's written;
// the display caps the labeled hours at 24.
function measuredDailyXp(record) {
  const measured = measuredDailyDelta(record.xpSnapshots);
  // A window narrower than SNAPSHOT_MIN_WINDOW_MS says nothing about the day;
  // fall through to the heatmap estimate instead of confidently showing "0 xp".
  if (!measured || measured.windowMs < SNAPSHOT_MIN_WINDOW_MS) return null;
  return measured;
}

// Karma has no estimate tier to fall back on, so unlike XP an observed *gain*
// is shown no matter how narrow the window — the gain really happened, and the
// note/tooltip disclose how little of the day was watched. Only a zero delta
// needs the minimum window before it's shown as a confident 0.
function measuredDailyKarma(record) {
  const measured = measuredDailyDelta(record.karmaSnapshots);
  if (!measured) return null;
  if (measured.delta <= 0 && measured.windowMs < SNAPSHOT_MIN_WINDOW_MS) return null;
  return measured;
}

// Delta between the oldest and newest snapshot inside the rolling 24h window.
// Window-width policy (when a measurement is trustworthy enough to show)
// belongs to the per-metric callers above.
function measuredDailyDelta(snapshots) {
  const windowStart = Date.now() - SNAPSHOT_MAX_AGE_MS;
  const snaps = (Array.isArray(snapshots) ? snapshots : []).filter(
    (s) => Array.isArray(s) && num(s[0]) != null && num(s[1]) != null && s[0] >= windowStart
  );
  if (snaps.length < 2) return null;

  const oldest = snaps[0];
  const newest = snaps[snaps.length - 1];
  const windowMs = newest[0] - oldest[0];
  const delta = newest[1] - oldest[1];
  if (delta < 0) return null;

  return { delta, windowMs, sinceMs: Date.now() - oldest[0] };
}

function heatmapDailyEstimate(record) {
  const heatmap = record.heatmap;
  // Only today's distillate is usable — yesterday's lesson count says nothing
  // about today.
  if (!heatmap || heatmap.dayKey !== localDateKey()) return null;

  const lessons = num(heatmap.lessonsToday) || 0;
  const streakPct = Math.min(num(heatmap.streakDays) || 0, STREAK_BONUS_CAP) / 100;
  const value = lessons > 0
    ? Math.round(DAILY_FIRST_CLEAR_BONUS_XP + lessons * ESTIMATED_XP_PER_LESSON * (1 + streakPct))
    : 0;
  return { value, lessons };
}

function measuredDailyView(measured, what = "XP") {
  const hours = Math.min(24, Math.max(1, Math.round(measured.sinceMs / 3_600_000)));
  const subHour = measured.sinceMs < 3_600_000;
  const span = subHour ? "less than an hour" : `${hours} hour${hours === 1 ? "" : "s"}`;
  return {
    value: measured.delta,
    note: subHour ? "past <1hr" : `past ${hours}hr`,
    tooltip: hours >= 22
      ? `${what} observed by Catalyst over the past ${span}.`
      : `${what} observed by Catalyst over the past ${span}. ${what} earned earlier in the day isn't visible.`,
  };
}

function estimateDailyView(estimate, measured) {
  const floor = measured && measured.delta > 0
    ? ` At least ${fmtNum(measured.delta)} xp was directly observed.`
    : "";
  return {
    value: estimate.value,
    note: "est.",
    tooltip: estimate.lessons > 0
      ? `Estimated from ${fmtNum(estimate.lessons)} lesson/challenge completion${estimate.lessons === 1 ? "" : "s"} today (resubmits count but give no XP, so this can overestimate).${floor}`
      : "No lessons or challenges completed today (per activity heatmap).",
  };
}

// ---------------------------------------------------------------------------
// Daily-karma view ladder. Karma has no daily leaderboard, no per-day API, and
// no backdating source (nothing like the daily board's XPEarned), so there are
// only two tiers:
//   1. measured    — diff of our own karma snapshots inside the 24h window
//   2. unavailable — "–"
// The window opens at Catalyst's first karma observation of the user, so
// values firm up the longer the leaderboard page has been visited that day.
// ---------------------------------------------------------------------------
function computeDailyKarmaView(record) {
  const measured = measuredDailyKarma(record);
  if (measured) return measuredDailyView(measured, "Karma");

  return {
    value: null,
    note: "",
    tooltip: "Not enough data yet. Catalyst accumulates karma observations for tracked users as you browse.",
  };
}

async function refreshPersonalHandle(handle) {
  const normalized = normalizeHandle(handle);
  if (!isValidHandle(normalized) || !isPersonalHandle(normalized)) return;

  const profile = await loadPublicUserProfile(normalized, { removeMissing: true });
  if (!profile || !isPersonalHandle(normalized)) return;

  const record = ensurePersonalRecord(normalized);
  record.handle = readField(profile, "Handle") || record.handle || normalized;
  record.profile = profile;
  record.profileError = null;
  recordXpSnapshot(record, readField(profile, "XP"));
  // Karma comes from the /stats refresh below, not from the profile response.
  savePersonalCache();
  schedulePersonalLeaderboardRender();

  await refreshPersonalStats(normalized);
  await refreshPersonalHeatmap(normalized);
}

async function refreshPersonalStats(handle) {
  const normalized = normalizeHandle(handle);
  if (!isValidHandle(normalized) || !isPersonalHandle(normalized)) return;

  const result = await fetchApiJsonWithAuthRetry(`https://api.boot.dev/v1/users/public/${encodeURIComponent(normalized)}/stats`);
  if (result.status >= 200 && result.status < 300) {
    const record = ensurePersonalRecord(normalized);
    record.stats = result.json?.data ?? result.json;
    recordKarmaSnapshot(record, readField(record.stats, "Karma"));
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

// The activity heatmap is the only public per-day activity source for another
// user: completion counts per calendar day (0-XP resubmits included) plus a
// separate GitHub-commit series that never grants XP but does extend streaks.
// It powers the estimate tier of computeDailyXpView.
async function refreshPersonalHeatmap(handle) {
  const normalized = normalizeHandle(handle);
  if (!isValidHandle(normalized) || !isPersonalHandle(normalized)) return;

  const existing = personalRecords[normalized]?.heatmap;
  if (
    existing?.fetchedAt &&
    Date.now() - existing.fetchedAt < HEATMAP_REFRESH_MS &&
    existing.dayKey === localDateKey()
  ) {
    return;
  }

  const timezone = Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC";
  const result = await fetchApiJsonWithAuthRetry(
    `https://api.boot.dev/v1/users/public/${encodeURIComponent(normalized)}/activity_heatmap?timezone=${encodeURIComponent(timezone)}`
  );
  if (result.status < 200 || result.status >= 300) return;
  handlePersonalHeatmap(normalized, result.json);
}

// Router entry (also fed passively when the viewer browses someone's profile).
function handlePersonalHeatmap(username, json) {
  const normalized = normalizeHandle(username);
  if (!isPersonalHandle(normalized)) return;

  const distilled = distillHeatmap(json);
  if (!distilled) return;

  const record = ensurePersonalRecord(normalized);
  record.heatmap = distilled;
  record.updatedAt = Date.now();
  savePersonalCache();
  schedulePersonalLeaderboardRender();
}

// Store only today's completion count and the streak length — the raw calendar
// is ~350 entries per user and everything else it says is derivable again.
function distillHeatmap(json) {
  const data = json?.data ?? json;
  const calendarField = readField(data, "Calendar");
  const calendar = Array.isArray(calendarField) ? calendarField : null;
  if (!calendar) return null;
  const commitsField = readField(data, "GithubCommits");
  const commits = Array.isArray(commitsField) ? commitsField : [];

  // Dates arrive as "YYYY-MM-DDT00:00:00Z" but are bucketed by the timezone we
  // requested (the viewer's), so the YYYY-MM-DD prefix compares against the
  // viewer's local date key.
  const today = localDateKey();
  const activeDays = new Set();
  let lessonsToday = 0;
  let readable = 0; // entries that yielded BOTH a date and a numeric count
  for (const entry of calendar) {
    const key = String(readField(entry, "Date") || "").slice(0, 10);
    const count = readNum(entry, "Count");
    if (key && count != null) readable += 1;
    if (!key || !count) continue;
    activeDays.add(key);
    if (key === today) lessonsToday = count;
  }

  // "No lessons today" and "I could not read this response" produce identical
  // numbers here, and the estimate tier renders the first as a confident
  // "0 xp / est." with a tooltip saying so. If a non-empty calendar yields
  // nothing readable, the fields moved — report no heatmap rather than a
  // fabricated zero, and say so once.
  if (calendar.length && !readable) {
    warnOnce(
      "heatmap-fields",
      `activity heatmap returned ${calendar.length} days and none had a readable Date/Count — ` +
      "Boot.dev likely renamed those fields. See distillHeatmap() in leaderboard.js."
    );
    return null;
  }
  for (const entry of commits) {
    const key = String(readField(entry, "Date") || "").slice(0, 10);
    if (key && readNum(entry, "Count")) activeDays.add(key);
  }

  // Streak = consecutive active days ending today, or ending yesterday when
  // today has no activity yet (the streak isn't broken until the day ends).
  let streakDays = 0;
  let cursor = activeDays.has(today) ? today : shiftDateKey(today, -1);
  while (activeDays.has(cursor)) {
    streakDays++;
    cursor = shiftDateKey(cursor, -1);
  }

  return { dayKey: today, lessonsToday, streakDays, fetchedAt: Date.now() };
}

function shiftDateKey(key, days) {
  const date = new Date(`${key}T00:00:00Z`);
  if (Number.isNaN(date.getTime())) return "";
  date.setUTCDate(date.getUTCDate() + days);
  return date.toISOString().slice(0, 10);
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
  if (!isPlainObject(profile) || !isValidHandle(readField(profile, "Handle") || normalized)) {
    setPersonalFeedback("Invalid username", "error");
    return null;
  }

  return profile;
}

// Record an observed lifetime-XP total for a tracked user, as a [t, xp] pair.
// Snapshots are the only way to measure the rolling-24h "daily XP" of someone
// outside the top-25 daily board: measured daily XP = newest total minus the
// oldest total observed inside the 24h window. `atMs` may lie in the past —
// a daily-board sighting yields a backdated point (XP - XPEarned at now-24h).
function recordXpSnapshot(record, xp, atMs = Date.now()) {
  const snaps = updateSnapshotSeries(record.xpSnapshots, xp, atMs);
  if (snaps) record.xpSnapshots = snaps;
}

// Karma twin of recordXpSnapshot. Karma has no daily board at all, so measuring
// snapshot deltas is the *only* daily-karma source (there is no exact tier and
// no backdating — a sighting only ever yields the present total).
function recordKarmaSnapshot(record, karma, atMs = Date.now()) {
  const snaps = updateSnapshotSeries(record.karmaSnapshots, karma, atMs);
  if (snaps) record.karmaSnapshots = snaps;
}

// Shared series updater for observed running totals ([t, value] pairs; XP and
// karma). Prunes points past the window, repairs contradictions, dedupes flat
// runs, and caps length. Returns the new array, or null when `value` isn't a
// usable total (caller keeps its existing series).
function updateSnapshotSeries(existing, value, atMs) {
  // A nullish observation means "not observed", never "observed as zero".
  // num(null) is 0 — the documented trap in this codebase — so without this
  // guard a caller that legitimately found nothing writes a real 0 point.
  // myValueFromEntries returns null when I am not on a board, and being absent
  // from the top-25 karma board means "below 25th", not "zero karma". That
  // fabricated 0 then anchors the 24-hour window, and the next genuine reading
  // is reported as a same-day GAIN of the entire lifetime total: the Daily
  // Karma comparison read the viewer's whole all-time karma (measured
  // 2026-08-20, present since v0.14.1).
  const total = observedNum(value);
  if (total == null || total < 0) return null;

  const cutoff = Date.now() - SNAPSHOT_MAX_AGE_MS;
  let snaps = (Array.isArray(existing) ? existing : []).filter(
    (s) => Array.isArray(s) && num(s[0]) != null && num(s[1]) != null && s[0] >= cutoff
  );

  // Totals never decrease. If the new point contradicts stored ones (in
  // either timeline direction — API glitch, or window skew on a backdated
  // point), dropping the contradicting points is the cheapest safe repair.
  snaps = snaps.filter((s) => (s[0] <= atMs ? s[1] <= total : s[1] >= total));

  const insertAt = snaps.findIndex((s) => s[0] > atMs);
  if (insertAt === -1) {
    const last = snaps[snaps.length - 1];
    const prev = snaps[snaps.length - 2];
    if (last && last[0] === atMs && last[1] === total) {
      // exact duplicate, nothing to do
    } else if (last && prev && last[1] === total && prev[1] === total) {
      // Run-length dedupe: a flat stretch only needs its first and latest
      // point for a sliding window boundary to still read the right total.
      last[0] = atMs;
    } else {
      snaps.push([atMs, total]);
    }
  } else {
    snaps.splice(insertAt, 0, [atMs, total]);
  }

  if (snaps.length > SNAPSHOT_CAP) {
    // Thin interior points, keeping the endpoints (they carry the window).
    snaps = snaps.filter((s, i, arr) => i === 0 || i === arr.length - 1 || i % 2 === 1);
  }
  return snaps;
}

// One-off repair for series poisoned by the num(null) trap before
// updateSnapshotSeries guarded against it. A running total of 0 sitting beside
// a positive total in the same 24-hour window would mean the user earned their
// entire lifetime karma today; in reality it is a fabricated zero. Dropping it
// costs at most one measurement window, which rebuilds within ~30 minutes.
//
// An all-zero series is left alone, so a genuinely zero-karma user still gets
// an honest measured "0 karma today" rather than being pushed to "unavailable".
// Idempotent, so it can run on every load and needs no migration flag.
function dropFabricatedZeros(snapshots) {
  const snaps = Array.isArray(snapshots) ? snapshots : [];
  if (!snaps.some((s) => Array.isArray(s) && num(s[1]) > 0)) return snaps;
  return snaps.filter((s) => Array.isArray(s) && num(s[1]) !== 0);
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

// Union of two observation series, for the cross-tab merges below. Mirrors
// mergeSnapshotSeries in backup.js — keep the two in sync; that one handles the
// same collision arriving from a file instead of from another tab.
//
// A series is append-only history, so two tabs each holding part of it must be
// combined rather than one replacing the other: dropping the other tab's points
// would shorten the measured window, and a shorter window is exactly what makes
// computeDailyXpView fall through to a weaker tier.
function mergeObservedSeries(a, b, now = Date.now()) {
  const cutoff = now - SNAPSHOT_MAX_AGE_MS;
  const pairs = [];
  for (const source of [a, b]) {
    if (!Array.isArray(source)) continue;
    for (const point of source) {
      if (!Array.isArray(point)) continue;
      const at = observedNum(point[0]);
      const value = observedNum(point[1]);
      if (at == null || value == null || value < 0) continue;
      if (at < cutoff || at > now + 60_000) continue; // tolerate a little clock skew
      pairs.push([at, value]);
    }
  }
  pairs.sort((x, y) => x[0] - y[0] || x[1] - y[1]);

  let out = [];
  for (const point of pairs) {
    const last = out[out.length - 1];
    if (last && last[0] === point[0] && last[1] === point[1]) continue; // exact duplicate
    if (last && point[1] < last[1]) continue; // contradiction: keep the higher run
    out.push(point);
  }
  while (out.length > SNAPSHOT_CAP) {
    out = out.filter((point, i, arr) => i === 0 || i === arr.length - 1 || i % 2 === 1);
  }
  return out;
}

// Merge one tracked user's record with another tab's copy of it. The profile
// and stats blocks describe a moment, so the newer one wins whole; the series
// are history and are combined.
function mergePersonalRecords(mine, theirs, now = Date.now()) {
  if (!isPlainObject(theirs)) return mine;
  if (!isPlainObject(mine)) return theirs;
  const newer = (observedNum(theirs.updatedAt) || 0) > (observedNum(mine.updatedAt) || 0) ? theirs : mine;
  const older = newer === mine ? theirs : mine;
  return {
    ...older,
    ...newer,
    xpSnapshots: mergeObservedSeries(mine.xpSnapshots, theirs.xpSnapshots, now),
    karmaSnapshots: mergeObservedSeries(mine.karmaSnapshots, theirs.karmaSnapshots, now),
  };
}

function savePersonalCache() {
  const records = {};
  for (const handle of personalHandles.filter(isValidHandle)) {
    if (isPlainObject(personalRecords[handle])) records[handle] = personalRecords[handle];
  }
  const now = Date.now();
  // Merged rather than replaced: another tab may hold observations this one
  // never saw, and overwriting them shortens every measured window.
  void mergeWrite(PERSONAL_CACHE_KEY, (stored) => {
    const theirs = isPlainObject(stored?.records) ? stored.records : {};
    const merged = {};
    for (const handle of personalHandles.filter(isValidHandle)) {
      const mine = records[handle];
      const other = theirs[handle];
      const result = mergePersonalRecords(mine, other, now);
      if (isPlainObject(result)) {
        merged[handle] = result;
        personalRecords[handle] = result;
      }
    }
    return { records: merged, updatedAt: now };
  });
}

function removePersonalLeaderboards() {
  document.getElementById("be-personal-leaderboards")?.remove();
  document.getElementById("be-personal-divider")?.remove();
}

// Test hook: scripts/check_leaderboard_avatar.mjs predefines this global before
// evaluating the file. Never defined on the real page.
if (typeof window !== "undefined" && window.__BOOTDEV_ENHANCER_TEST__) {
  window.__BOOTDEV_ENHANCER_TEST__.leaderboard = {
    leaderAvatarSignature,
    mergeObservedSeries,
    mergePersonalRecords,
    renderLeaderAvatar,
    getRoleFrameIndex,
    getRoleFrameUrl,
    getAvatarUrl,
    getLeaderboardEntries,
    getHandle,
    getDisplayName,
    mapByHandle,
    leagueMyValueOrZero,
    distillHeatmap,
  };
}
