// trainingGrounds.js
// Training Grounds (Challenge Catalog) difficulty LEVEL filter. Injects a
// Catalyst "Level" section into Boot.dev's filter popover; injected.js filters
// the challenges/search response before Vue consumes it, so the native list,
// its "Showing X-Y of Z" line, and pagination all stay correct.
//
// Boot.dev shipped its own Easy/Medium/Hard filter on 2026-08-01 (`d=hard` in
// the query, filtered server-side), which made Catalyst's own tier pills
// redundant. Catalyst now refines that instead of duplicating it: pick a tier
// natively and Catalyst offers the exact levels inside it (Hard -> 8/9/10), so
// you can ask for only level 10. With no native tier selected, no levels are
// offered at all — an unfiltered search spreads ~46 records across all ten
// levels, so a single-level pick there would look broken while working.
//
// Interaction model deliberately mirrors the native filter pills (2026-07-15
// live QA): pill clicks — and "Clear filters" — are pending/visual only until
// Boot.dev's Search button commits them; the committed state travels in the
// page URL (`dl=8,10`, alongside Boot.dev's own `d=hard`); each tab is
// independent and nothing is stored. Committed levels are handed to
// injected.js through a DOM attribute (`data-be-dl` on <html>) — a synchronous
// channel, so the fetch a Search click triggers already sees the
// just-committed state.
//
// Cold loads (F5 / pasted URL) server-render the results with NO API call, so
// a dl-armed load needs one self-triggered refresh before the filter shows.
//
// Evidence and design decisions: reference_data/catalyst_versions/
// v0.13.0_challenge_level_filter/implementation_plan.md

const CHALLENGE_FILTER_FEATURE = "challengeDifficulty";
const CHALLENGE_LEVEL_URL_PARAM = "dl";
// Boot.dev's own tier param. Catalyst reads it and never writes it.
const NATIVE_DIFFICULTY_URL_PARAM = "d";
// Keep both in sync with injected.js.
const CHALLENGE_LEVEL_ATTR = "data-be-dl";
const CHALLENGE_REFRESH_NONCE_PARAM = "be_r";
// Tier -> the exact levels inside it. Confirmed against four tier-filtered
// captures (2026-08-01): easy 1-4, medium 5-7, hard 8-10, zero leakage in any
// of them. This is now the ONLY copy — injected.js filters on exact levels and
// needs no tier bounds at all.
const CHALLENGE_TIERS = [
  { id: "easy", label: "Easy", levels: [1, 2, 3, 4] },
  { id: "medium", label: "Medium", levels: [5, 6, 7] },
  { id: "hard", label: "Hard", levels: [8, 9, 10] },
];
// How long after a commit / route entry to wait for a search response before
// concluding Boot.dev skipped the request and triggering our own refresh.
const CHALLENGE_COMMIT_VERIFY_MS = 1000;
const CHALLENGE_ENTRY_HEAL_MS = 1500;

let pendingNativeTier = null; // native tier the offered levels are scoped to
let committedNativeTier = null; // the tier the committed levels belong to
let pendingChallengeLevels = []; // popover selection, not yet applied
let committedChallengeLevels = []; // applied by the last Search in this tab
let lastChallengeSearch = null; // what the page currently renders (from relay)
let lastChallengeRefreshSignature = null; // backstop refreshes: one per selection
let challengeCommitVerifyTimer = null;
let challengeEntryHealTimer = null;
let onTrainingGroundsRoute = false;
let lastTrainingGroundsPath = null;

function isTrainingGroundsPage() {
  // The catalog lands on /training-grounds; executing a search navigates the
  // SPA to /training-grounds/search?q=...
  return /^\/training-grounds(?:\/search)?\/?$/.test(location.pathname);
}

// ---------------------------------------------------------------------------
// Level state
// ---------------------------------------------------------------------------

function tierById(id) {
  return CHALLENGE_TIERS.find((t) => t.id === id) || null;
}

function levelsForTier(id) {
  return tierById(id)?.levels || [];
}

// Levels are only ever meaningful inside a tier, so normalizing intersects with
// what that tier offers. This is also the guard against a stale selection: a
// `dl=10` committed under Hard normalizes to [] the moment the tier becomes
// Easy, instead of filtering an all-1-4 response down to nothing.
function normalizeChallengeLevels(value, tierId) {
  const allowed = new Set(levelsForTier(tierId));
  const list = Array.isArray(value) ? value : [];
  const seen = new Set();
  for (const raw of list) {
    const n = Number(raw);
    if (Number.isInteger(n) && allowed.has(n)) seen.add(n);
  }
  return [...seen].sort((a, b) => a - b);
}

function challengeLevelsEqual(a, b) {
  return a.length === b.length && a.every((level, i) => level === b[i]);
}

// Selecting every level the tier offers is the same as the native tier filter
// on its own, so that counts as inactive — the same rule the tier version used
// for "all three tiers selected".
function committedChallengeActive() {
  const offered = levelsForTier(committedNativeTier);
  return (
    committedChallengeLevels.length >= 1 &&
    committedChallengeLevels.length < offered.length
  );
}

function readChallengeLevelsFromUrl() {
  try {
    const raw = new URLSearchParams(location.search).get(CHALLENGE_LEVEL_URL_PARAM);
    if (raw !== null) return raw.split(",");
  } catch (_) {}
  return [];
}

// Boot.dev's committed tier. Always available (it drives the page's own
// server-side filter), which is what makes route entry, cold loads, and shared
// links work without reading any DOM.
function nativeTierFromUrl() {
  try {
    const raw = new URLSearchParams(location.search).get(NATIVE_DIFFICULTY_URL_PARAM);
    const id = String(raw || "").toLowerCase();
    return tierById(id) ? id : null;
  } catch (_) {}
  return null;
}

// The native Difficulty section, by its header text. Catalyst's own section is
// deliberately labelled "Level" so this can never match it.
function findNativeDifficultySection(popover) {
  for (const section of popover.querySelectorAll("section")) {
    for (const span of section.querySelectorAll("span")) {
      if (normalizeText(span.textContent).toLowerCase() === "difficulty") return section;
    }
  }
  return null;
}

// The PENDING native tier — the one clicked but not yet Searched. Selection is
// not on the pills themselves: the 2026-08-01 popover diff showed it lives only
// in Tailwind color utilities (border-gray-200 vs border-gray-600), which would
// be a color-value dependency. What does change is the section header icon,
// which swaps its generic <svg> for the tier's own artwork. Match the authored
// filename stem only — the build hash in the middle is never matched.
function nativeTierFromPopover(section) {
  for (const img of section.querySelectorAll("img")) {
    const match = /difficulty_(easy|medium|hard)_icon/.exec(img.getAttribute("src") || "");
    if (match) return match[1];
  }
  return null;
}

// While the popover is open the section is authoritative INCLUDING its negative
// answer: clicking a selected tier off leaves `d=` stale in the URL, and
// falling back to it would keep offering levels the user just dismissed. When
// the popover is closed (or its markup moved) the URL is all there is.
function resolveNativeTier() {
  const popover = findChallengeFilterPopover();
  if (popover) {
    const section = findNativeDifficultySection(popover);
    if (section) return nativeTierFromPopover(section);
  }
  return nativeTierFromUrl();
}

// The synchronous state channel to injected.js: attribute present = filter to
// these levels; absent = feature off / nothing committed.
function syncChallengeFilterAttr() {
  try {
    const root = document.documentElement;
    if (
      onTrainingGroundsRoute &&
      isFeatureEnabled(CHALLENGE_FILTER_FEATURE) &&
      committedChallengeActive()
    ) {
      root.setAttribute(CHALLENGE_LEVEL_ATTR, committedChallengeLevels.join(","));
    } else {
      root.removeAttribute(CHALLENGE_LEVEL_ATTR);
    }
  } catch (_) {}
}

// ---------------------------------------------------------------------------
// Route entry/leave (per-tab, URL-derived — like the native filters)
// ---------------------------------------------------------------------------

function enterTrainingGroundsRoute() {
  onTrainingGroundsRoute = true;
  lastTrainingGroundsPath = location.pathname;
  lastChallengeSearch = null;
  lastChallengeRefreshSignature = null;
  // Adopt the URL, scoped to whatever tier Boot.dev committed. An incoherent
  // shared link (`d=easy&dl=10`) normalizes to no levels and therefore filters
  // nothing, which is the right fail-open answer rather than an empty page.
  committedNativeTier = nativeTierFromUrl();
  committedChallengeLevels = normalizeChallengeLevels(
    readChallengeLevelsFromUrl(),
    committedNativeTier
  );
  pendingNativeTier = committedNativeTier;
  pendingChallengeLevels = committedChallengeLevels.slice();
  syncChallengeFilterAttr();

  // Cold loads server-render the results without an API call; if this entry
  // arrived level-armed and no search response shows up, trigger one refresh
  // so the filter actually applies. One attempt only — a failure leaves the
  // native unfiltered content (fail-open).
  clearTrackedTimeout(challengeEntryHealTimer);
  challengeEntryHealTimer = null;
  if (committedChallengeActive()) {
    challengeEntryHealTimer = setTrackedTimeout(() => {
      if (!lastChallengeSearch && onTrainingGroundsRoute) {
        requestChallengeSearchRefresh();
      }
    }, CHALLENGE_ENTRY_HEAL_MS);
  }
}

function leaveTrainingGroundsRoute() {
  onTrainingGroundsRoute = false;
  lastTrainingGroundsPath = null;
  pendingNativeTier = null;
  committedNativeTier = null;
  pendingChallengeLevels = [];
  committedChallengeLevels = [];
  lastChallengeSearch = null;
  lastChallengeRefreshSignature = null;
  clearTrackedTimeout(challengeCommitVerifyTimer);
  clearTrackedTimeout(challengeEntryHealTimer);
  challengeCommitVerifyTimer = null;
  challengeEntryHealTimer = null;
  syncChallengeFilterAttr(); // removes the attribute
}

// Idempotent per-tick ensure: called on route change, the 2s DOM scan, and
// (delayed) after clicks. Handles entry/leave transitions itself.
function ensureTrainingGroundsUiState() {
  if (enhancerStopped) return;
  if (!isTrainingGroundsPage() || !isFeatureEnabled(CHALLENGE_FILTER_FEATURE)) {
    if (onTrainingGroundsRoute) leaveTrainingGroundsRoute();
    removeTrainingGroundsUi();
    return;
  }
  if (!onTrainingGroundsRoute) {
    enterTrainingGroundsRoute();
  } else if (location.pathname !== lastTrainingGroundsPath) {
    // Internal navigation (landing <-> search): boot.dev remembers and
    // re-runs its own search, so the committed filter stays — but
    // uncommitted pill picks reset to the committed state, exactly like the
    // native pending pills do on a remount.
    lastTrainingGroundsPath = location.pathname;
    pendingNativeTier = committedNativeTier;
    pendingChallengeLevels = committedChallengeLevels.slice();
    syncChallengeFilterUi();
  }
  ensureChallengeFilterDot();
  ensureLevelSection();
}

// ---------------------------------------------------------------------------
// Commit (Search click) and refresh
// ---------------------------------------------------------------------------

function requestChallengeSearchRefresh() {
  if (enhancerStopped) return;
  window.postMessage(
    { source: TAG, command: "BE_REFRESH_CHALLENGE_SEARCH", payload: {} },
    window.location.origin
  );
}

// Do the currently rendered results reflect the committed levels?
function resultsMatchCommitted() {
  const effective = committedChallengeActive() ? committedChallengeLevels : [];
  const applied = lastChallengeSearch?.filtered ? lastChallengeSearch.appliedLevels : [];
  return challengeLevelsEqual(effective, applied);
}

// Is this the challenge-catalog search form? The /training-grounds/search page
// labels its box `aria-label="Search Challenges"`, but the search field
// Boot.dev added to the landing page (2026-07-30) words it differently
// ("Search existing challenges"), so a single exact string missed it and
// difficulty picks made on the landing page were dropped. Match the
// search+challenge word pair in the label or placeholder instead.
function isChallengeSearchForm(form) {
  for (const input of form.querySelectorAll("input")) {
    const text = `${input.getAttribute("aria-label") || ""} ${input.placeholder || ""}`;
    if (/search/i.test(text) && /challenge/i.test(text)) return true;
  }
  return false;
}

// Capture-phase form-submit listener: fires for the Search button and for
// Enter in the search box, before Boot.dev's own handler runs — so the
// attribute write below is visible to the fetch that handler may start.
function handleTrainingGroundsSubmit(event) {
  if (enhancerStopped || !isTrainingGroundsPage()) return;
  if (!isFeatureEnabled(CHALLENGE_FILTER_FEATURE)) return;
  const form = event.target;
  if (!(form instanceof Element)) return;
  if (!isChallengeSearchForm(form)) return;
  commitChallengeSelection();
}

function commitChallengeSelection() {
  // Re-resolve rather than trust the last tick: the Search click can land
  // before an ensure pass has seen a just-changed native tier.
  pendingNativeTier = resolveNativeTier();
  pendingChallengeLevels = normalizeChallengeLevels(pendingChallengeLevels, pendingNativeTier);
  committedNativeTier = pendingNativeTier;
  committedChallengeLevels = pendingChallengeLevels.slice();
  syncChallengeFilterAttr();
  ensureChallengeFilterDot();

  // Boot.dev skips the refetch when q/t/l are unchanged. If no response has
  // arrived shortly after this commit and the shown results don't match it,
  // ask the page to re-run the search itself.
  const committedAt = Date.now();
  clearTrackedTimeout(challengeCommitVerifyTimer);
  challengeCommitVerifyTimer = setTrackedTimeout(() => {
    if (!onTrainingGroundsRoute) return;
    if (lastChallengeSearch && lastChallengeSearch.at >= committedAt) return;
    if (resultsMatchCommitted()) return;
    requestChallengeSearchRefresh();
  }, CHALLENGE_COMMIT_VERIFY_MS);
}

// Router handler for /v1/challenges/search relays.
function handleChallengeSearch(json, catalyst) {
  if (!Array.isArray(json) || !isTrainingGroundsPage()) return;
  if (!onTrainingGroundsRoute) ensureTrainingGroundsUiState();
  lastChallengeSearch = {
    at: Date.now(),
    shownCount: json.length,
    originalCount: Number.isFinite(catalyst?.originalCount) ? catalyst.originalCount : json.length,
    resolvedCount: Number.isFinite(catalyst?.resolvedCount) ? catalyst.resolvedCount : null,
    filtered: catalyst?.filtered === true,
    appliedLevels: normalizeChallengeLevels(catalyst?.appliedLevels, committedNativeTier),
  };
  console.debug("[catalyst] challenge search", lastChallengeSearch);
  warnIfNoDifficultiesResolved(lastChallengeSearch);
  syncChallengeSearchUrl();
  // A relay can land while Vue is still settling its own URL push (internal
  // landing -> search transitions), which then overwrites ours — re-sync
  // once the dust settles.
  setTrackedTimeout(syncChallengeSearchUrl, 300);
  ensureChallengeFilterDot();

  // Backstop: if what rendered doesn't match the committed tiers (e.g. a
  // fetch raced the commit), refresh once per distinct selection — the
  // signature guard makes a loop impossible even if refreshes stop working.
  if (resultsMatchCommitted()) {
    lastChallengeRefreshSignature = null;
    return;
  }
  const signature = (committedChallengeActive() ? committedChallengeLevels : []).join(",");
  if (signature === lastChallengeRefreshSignature) return;
  lastChallengeRefreshSignature = signature;
  requestChallengeSearchRefresh();
}

// The v0.12.1 tripwire. Filtering deliberately keeps any record whose level it
// cannot read, so a renamed difficulty field produces a perfectly healthy-
// looking feature that filters nothing: pills toggle, `dl=` reaches the URL,
// and the relay still reports filtered:true. The one number that gives it away
// is how many records yielded a level — 0 out of N means the field moved again.
function warnIfNoDifficultiesResolved(search) {
  if (!search.filtered || search.resolvedCount === null) return;
  if (search.originalCount <= 0 || search.resolvedCount > 0) return;
  warnOnce(
    "tg:level-field",
    `level filter read ${search.originalCount} challenges and could not read a level from any of them — ` +
    "Boot.dev likely renamed the difficulty field again. See challengeDifficulty() in injected.js."
  );
}

// Keep the address bar honest after every search: strip the refresh nonce,
// and add/remove `dl=` to match what is actually filtering the results
// (native searches rebuild the URL and drop it). Boot.dev's own `d=` is never
// touched. history.replaceState only repaints the address bar — Vue's router
// is not involved.
function syncChallengeSearchUrl() {
  if (!isTrainingGroundsPage()) return;
  try {
    const url = new URL(location.href);
    url.searchParams.delete(CHALLENGE_REFRESH_NONCE_PARAM);
    const applied = lastChallengeSearch?.filtered ? lastChallengeSearch.appliedLevels : [];
    if (applied.length && applied.length < levelsForTier(committedNativeTier).length) {
      url.searchParams.set(CHALLENGE_LEVEL_URL_PARAM, applied.join(","));
    } else {
      url.searchParams.delete(CHALLENGE_LEVEL_URL_PARAM);
    }
    // Commas are legal in query values; undo URLSearchParams' %2C so shared
    // dl= URLs stay readable.
    const next = (url.pathname + url.search + url.hash).replace(/%2C/gi, ",");
    const current = location.pathname + location.search + location.hash;
    if (next !== current) history.replaceState(history.state, "", next);
  } catch (_) {}
}

// ---------------------------------------------------------------------------
// DOM: popover section + filter-button dot
// ---------------------------------------------------------------------------

function findChallengeFilterButton() {
  return document.querySelector('button[aria-label="Filter challenges"]');
}

// The popover is v-if'd out of the DOM while closed; when open it is the
// filter button's next sibling. Verified by the "Filters" text landmark,
// never by class names.
function findChallengeFilterPopover() {
  const btn = findChallengeFilterButton();
  if (!btn || btn.getAttribute("aria-expanded") !== "true") return null;
  const popover = btn.nextElementSibling;
  if (!popover) return null;
  return normalizeText(popover.textContent).toLowerCase().includes("filters") ? popover : null;
}

function ensureLevelSection() {
  const popover = findChallengeFilterPopover();
  if (!popover) return;
  let section = popover.querySelector("#be-tg-level");
  if (!section) {
    section = buildLevelSection();
    // Native sections (Language/Type/Difficulty) share a container; append
    // after them so Level reads as a refinement of Difficulty. In the "Select
    // a language first" state no <section> exists — append to the popover
    // itself, after its header row.
    const nativeSection = popover.querySelector("section");
    if (nativeSection && nativeSection.parentElement) {
      nativeSection.parentElement.appendChild(section);
    } else {
      popover.appendChild(section);
    }
  }
  syncLevelSection(section);
}

function buildLevelSection() {
  const section = document.createElement("section");
  section.id = "be-tg-level";
  section.className = "be-tg-section";

  const label = document.createElement("div");
  label.className = "be-tg-section-label";
  // Lucide-style "//" glyph to match the native <> LANGUAGE and >_ TYPE icons.
  label.innerHTML =
    '<svg xmlns="http://www.w3.org/2000/svg" width="24" height="24" viewBox="0 0 24 24"' +
    ' fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"' +
    ' stroke-linejoin="round" aria-hidden="true"><path d="m10 4-5 16"></path>' +
    '<path d="m19 4-5 16"></path></svg><span>Level</span>';

  const pills = document.createElement("div");
  pills.className = "be-tg-pills";

  // Mirrors the native Type section's "Select a language first" state — the
  // section stays visible and says why it is empty rather than vanishing.
  const empty = document.createElement("div");
  empty.className = "be-tg-empty";
  empty.textContent = "Select a difficulty first";

  section.append(label, pills, empty);
  return section;
}

// Rebuilds the pill row whenever the offered levels change, then reflects the
// pending selection. Also the point where a native tier change drops levels
// that no longer belong to it.
function syncLevelSection(section) {
  const tier = resolveNativeTier();
  if (tier !== pendingNativeTier) {
    pendingNativeTier = tier;
    pendingChallengeLevels = normalizeChallengeLevels(pendingChallengeLevels, tier);
  }

  const pills = section.querySelector(".be-tg-pills");
  const empty = section.querySelector(".be-tg-empty");
  const offered = levelsForTier(tier);

  if (section.dataset.beTier !== (tier || "")) {
    section.dataset.beTier = tier || "";
    pills.textContent = "";
    for (const level of offered) {
      const btn = document.createElement("button");
      btn.type = "button";
      btn.className = "be-tg-pill";
      btn.dataset.beLevel = String(level);
      btn.textContent = String(level);
      btn.title = `Difficulty ${level}`;
      btn.setAttribute("aria-pressed", "false");
      btn.addEventListener("click", () => toggleChallengeLevel(level));
      pills.appendChild(btn);
    }
  }

  pills.hidden = !offered.length;
  empty.hidden = Boolean(offered.length);
  syncLevelPills(section);
}

function syncLevelPills(section) {
  for (const btn of section.querySelectorAll(".be-tg-pill")) {
    const on = pendingChallengeLevels.includes(Number(btn.dataset.beLevel));
    btn.setAttribute("aria-pressed", on ? "true" : "false");
  }
}

function syncChallengeFilterUi() {
  const section = document.getElementById("be-tg-level");
  if (section) syncLevelSection(section);
  ensureChallengeFilterDot();
}

// Pending only — nothing applies until Boot.dev's Search commits it, exactly
// like the native pills.
function toggleChallengeLevel(level) {
  pendingChallengeLevels = pendingChallengeLevels.includes(level)
    ? pendingChallengeLevels.filter((n) => n !== level)
    : normalizeChallengeLevels([...pendingChallengeLevels, level], pendingNativeTier);
  syncChallengeFilterUi();
}

// Small gold dot on the filter button while a committed selection is actually
// filtering results — visible with the popover closed, without duplicating
// any counts. Pending (uncommitted) picks don't show it, matching how native
// pending pills have no indicator either.
function ensureChallengeFilterDot() {
  const btn = findChallengeFilterButton();
  const existing = document.getElementById("be-tg-filter-dot");
  const want =
    Boolean(btn) &&
    isTrainingGroundsPage() &&
    isFeatureEnabled(CHALLENGE_FILTER_FEATURE) &&
    committedChallengeActive();
  if (!want) {
    existing?.remove();
    return;
  }
  if (existing && existing.parentElement === btn) return;
  existing?.remove();
  const dot = document.createElement("span");
  dot.id = "be-tg-filter-dot";
  dot.className = "be-tg-filter-dot";
  btn.appendChild(dot);
}

function removeTrainingGroundsUi() {
  document.getElementById("be-tg-level")?.remove();
  document.getElementById("be-tg-filter-dot")?.remove();
}

// ---------------------------------------------------------------------------
// Events + settings
// ---------------------------------------------------------------------------

// Delegated capture-phase click listener: (re)inject after the popover opens
// or re-renders, and mirror the native "Clear filters" (which is also only
// pending until Search).
function handleTrainingGroundsClick(event) {
  if (enhancerStopped || !isTrainingGroundsPage()) return;
  if (!isFeatureEnabled(CHALLENGE_FILTER_FEATURE)) return;
  const target = event.target instanceof Element ? event.target : null;
  if (!target) return;

  const popover = findChallengeFilterPopover();
  if (popover && popover.contains(target)) {
    const btn = target.closest("button");
    if (btn && !btn.closest("#be-tg-level")) {
      if (normalizeText(btn.textContent).toLowerCase() === "clear filters") {
        pendingChallengeLevels = [];
        syncChallengeFilterUi();
      }
      watchNativeTierClick(btn, popover);
    }
  }

  // Re-ensure after Vue reacts to the click: once quickly for the common
  // case, once later for slow renders. Both are idempotent.
  setTrackedTimeout(ensureTrainingGroundsUiState, 50);
  setTrackedTimeout(ensureTrainingGroundsUiState, 400);
}

// Tripwire for the one anchor outside the documented priority list: the tier
// is read from the section header icon's filename, so if Boot.dev stops
// swapping that icon the level pills quietly stop following the native
// selection while everything still looks fine. Checking on every tick would
// false-positive constantly (no icon is the correct answer most of the time),
// so this only fires on the unambiguous case: the user just clicked a tier
// that was NOT already selected, and shortly after the icon still doesn't
// report it. Deselecting a tier is excluded, since no icon is then correct.
function watchNativeTierClick(btn, popover) {
  const section = findNativeDifficultySection(popover);
  if (!section || !section.contains(btn)) return;
  const label = normalizeText(btn.textContent).toLowerCase();
  const tier = CHALLENGE_TIERS.find((t) => t.label.toLowerCase() === label);
  if (!tier || tier.id === nativeTierFromPopover(section)) return;
  setTrackedTimeout(() => {
    const current = findChallengeFilterPopover();
    const now = current ? findNativeDifficultySection(current) : null;
    if (!now || nativeTierFromPopover(now) === tier.id) return;
    warnOnce(
      "tg:tier-icon",
      `selecting the native ${tier.label} difficulty did not update the filter popover's ` +
      "difficulty icon — Boot.dev may have changed it, so Catalyst's level pills will " +
      "only follow the tier after a search. See nativeTierFromPopover() in trainingGrounds.js."
    );
  }, 400);
}

function bindTrainingGroundsEvents() {
  document.addEventListener("click", handleTrainingGroundsClick, true);
  document.addEventListener("submit", handleTrainingGroundsSubmit, true);
}

function unbindTrainingGroundsEvents() {
  document.removeEventListener("click", handleTrainingGroundsClick, true);
  document.removeEventListener("submit", handleTrainingGroundsSubmit, true);
}

// Live-apply of the feature toggle (from applyFeatureSettings).
function applyChallengeFilterSetting(before, after) {
  if (!before || !after) return;
  const was = before[CHALLENGE_FILTER_FEATURE] !== false;
  const now = after[CHALLENGE_FILTER_FEATURE] !== false;
  if (was === now) return;
  if (!now) {
    // Restore the unfiltered view first (the relay it produces is still
    // handled), then let the ensure pass tear the rest down.
    const needRestore = isTrainingGroundsPage() && lastChallengeSearch?.filtered;
    try {
      document.documentElement.removeAttribute(CHALLENGE_LEVEL_ATTR);
    } catch (_) {}
    removeTrainingGroundsUi();
    if (needRestore) {
      lastChallengeRefreshSignature = null;
      requestChallengeSearchRefresh();
    }
  } else {
    // Re-enter so the URL's diff= (if any) is adopted under the new flag.
    onTrainingGroundsRoute = false;
    ensureTrainingGroundsUiState();
  }
}
