// trainingGrounds.js
// Training Grounds (Challenge Catalog) difficulty filter. Injects a Catalyst
// "Difficulty" section into Boot.dev's filter popover; injected.js filters the
// challenges/search response before Vue consumes it, so the native list,
// count, and pagination stay correct.
//
// Interaction model deliberately mirrors the native filter pills (2026-07-15
// live QA): pill clicks — and "Clear filters" — are pending/visual only until
// Boot.dev's Search button commits them; the committed state travels in the
// page URL (`diff=easy,hard`); each tab is independent and nothing is stored.
// Committed tiers are handed to injected.js through a DOM attribute
// (`data-be-diff` on <html>) — a synchronous channel, so the fetch a Search
// click triggers already sees the just-committed state.
//
// Cold loads (F5 / pasted URL) server-render the results with NO API call, so
// a diff-armed load needs one self-triggered refresh before the filter shows.
//
// Evidence and design decisions: reference_data/catalyst_versions/
// v0.10.0_challenge_difficulty_filter/difficulty_filter_plan.md

const CHALLENGE_FILTER_FEATURE = "challengeDifficulty";
const CHALLENGE_DIFF_URL_PARAM = "diff";
// Keep both in sync with injected.js.
const CHALLENGE_DIFF_ATTR = "data-be-diff";
const CHALLENGE_REFRESH_NONCE_PARAM = "be_r";
// Tier ids/bounds mirror boot.dev's own difficulty icons; keep in sync with
// DIFFICULTY_TIERS in injected.js.
const CHALLENGE_TIERS = [
  { id: "easy", label: "Easy", range: "1-4" },
  { id: "medium", label: "Medium", range: "5-7" },
  { id: "hard", label: "Hard", range: "8-10" },
];
// How long after a commit / route entry to wait for a search response before
// concluding Boot.dev skipped the request and triggering our own refresh.
const CHALLENGE_COMMIT_VERIFY_MS = 1000;
const CHALLENGE_ENTRY_HEAL_MS = 1500;

let pendingChallengeTiers = []; // popover selection, not yet applied
let committedChallengeTiers = []; // applied by the last Search in this tab
let lastChallengeSearch = null; // what the page currently renders (from relay)
let lastChallengeRefreshSignature = null; // backstop refreshes: one per selection
let challengeCommitVerifyTimer = null;
let challengeEntryHealTimer = null;
let onTrainingGroundsRoute = false;

function isTrainingGroundsPage() {
  // The catalog lands on /training-grounds; executing a search navigates the
  // SPA to /training-grounds/search?q=...
  return /^\/training-grounds(?:\/search)?\/?$/.test(location.pathname);
}

// ---------------------------------------------------------------------------
// Tier state
// ---------------------------------------------------------------------------

function normalizeChallengeTiers(value) {
  const list = Array.isArray(value) ? value : [];
  return CHALLENGE_TIERS.map((t) => t.id).filter((id) => list.includes(id));
}

function challengeTiersEqual(a, b) {
  return a.length === b.length && a.every((tier, i) => tier === b[i]);
}

// 1-2 tiers filter; none or all three means "all difficulties" (no filtering).
function committedChallengeActive() {
  return (
    committedChallengeTiers.length >= 1 &&
    committedChallengeTiers.length < CHALLENGE_TIERS.length
  );
}

function readChallengeTiersFromUrl() {
  try {
    const raw = new URLSearchParams(location.search).get(CHALLENGE_DIFF_URL_PARAM);
    if (raw !== null) return normalizeChallengeTiers(raw.split(","));
  } catch (_) {}
  return [];
}

// The synchronous state channel to injected.js: attribute present = filter
// these tiers; absent = feature off / nothing committed.
function syncChallengeFilterAttr() {
  try {
    const root = document.documentElement;
    if (
      onTrainingGroundsRoute &&
      isFeatureEnabled(CHALLENGE_FILTER_FEATURE) &&
      committedChallengeActive()
    ) {
      root.setAttribute(CHALLENGE_DIFF_ATTR, committedChallengeTiers.join(","));
    } else {
      root.removeAttribute(CHALLENGE_DIFF_ATTR);
    }
  } catch (_) {}
}

// ---------------------------------------------------------------------------
// Route entry/leave (per-tab, URL-derived — like the native filters)
// ---------------------------------------------------------------------------

function enterTrainingGroundsRoute() {
  onTrainingGroundsRoute = true;
  lastChallengeSearch = null;
  lastChallengeRefreshSignature = null;
  committedChallengeTiers = readChallengeTiersFromUrl();
  pendingChallengeTiers = committedChallengeTiers.slice();
  syncChallengeFilterAttr();

  // Cold loads server-render the results without an API call; if this entry
  // arrived diff-armed and no search response shows up, trigger one refresh
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
  pendingChallengeTiers = [];
  committedChallengeTiers = [];
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
  if (!onTrainingGroundsRoute) enterTrainingGroundsRoute();
  ensureChallengeFilterDot();
  ensureDifficultySection();
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

// Do the currently rendered results reflect the committed tiers?
function resultsMatchCommitted() {
  const effective = committedChallengeActive() ? committedChallengeTiers : [];
  const applied = lastChallengeSearch?.filtered ? lastChallengeSearch.appliedTiers : [];
  return challengeTiersEqual(effective, applied);
}

// Capture-phase form-submit listener: fires for the Search button and for
// Enter in the search box, before Boot.dev's own handler runs — so the
// attribute write below is visible to the fetch that handler may start.
function handleTrainingGroundsSubmit(event) {
  if (enhancerStopped || !isTrainingGroundsPage()) return;
  if (!isFeatureEnabled(CHALLENGE_FILTER_FEATURE)) return;
  const form = event.target;
  if (!(form instanceof Element)) return;
  if (!form.querySelector('input[aria-label="Search Challenges"]')) return;
  commitChallengeSelection();
}

function commitChallengeSelection() {
  committedChallengeTiers = pendingChallengeTiers.slice();
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
    filtered: catalyst?.filtered === true,
    appliedTiers: normalizeChallengeTiers(catalyst?.appliedTiers),
  };
  console.debug("[catalyst] challenge search", lastChallengeSearch);
  syncChallengeSearchUrl();
  ensureChallengeFilterDot();

  // Backstop: if what rendered doesn't match the committed tiers (e.g. a
  // fetch raced the commit), refresh once per distinct selection — the
  // signature guard makes a loop impossible even if refreshes stop working.
  if (resultsMatchCommitted()) {
    lastChallengeRefreshSignature = null;
    return;
  }
  const signature = (committedChallengeActive() ? committedChallengeTiers : []).join(",");
  if (signature === lastChallengeRefreshSignature) return;
  lastChallengeRefreshSignature = signature;
  requestChallengeSearchRefresh();
}

// Keep the address bar honest after every search: strip the refresh nonce,
// and add/remove `diff=` to match what is actually filtering the results
// (native searches rebuild the URL and drop it). history.replaceState only
// repaints the address bar — Vue's router is not involved.
function syncChallengeSearchUrl() {
  if (!isTrainingGroundsPage()) return;
  try {
    const url = new URL(location.href);
    url.searchParams.delete(CHALLENGE_REFRESH_NONCE_PARAM);
    const applied = lastChallengeSearch?.filtered ? lastChallengeSearch.appliedTiers : [];
    if (applied.length && applied.length < CHALLENGE_TIERS.length) {
      url.searchParams.set(CHALLENGE_DIFF_URL_PARAM, applied.join(","));
    } else {
      url.searchParams.delete(CHALLENGE_DIFF_URL_PARAM);
    }
    const next = url.pathname + url.search + url.hash;
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

function ensureDifficultySection() {
  const popover = findChallengeFilterPopover();
  if (!popover) return;
  let section = popover.querySelector("#be-tg-difficulty");
  if (!section) {
    section = buildDifficultySection();
    // Native sections (Language/Type) share a container; append after them.
    // In the "Select a language first" state no <section> exists — append to
    // the popover itself, after its header row.
    const nativeSection = popover.querySelector("section");
    if (nativeSection && nativeSection.parentElement) {
      nativeSection.parentElement.appendChild(section);
    } else {
      popover.appendChild(section);
    }
  }
  syncDifficultyPills(section);
}

function buildDifficultySection() {
  const section = document.createElement("section");
  section.id = "be-tg-difficulty";
  section.className = "be-tg-section";

  const label = document.createElement("div");
  label.className = "be-tg-section-label";
  // Lucide-style "//" glyph to match the native <> LANGUAGE and >_ TYPE icons.
  label.innerHTML =
    '<svg xmlns="http://www.w3.org/2000/svg" width="24" height="24" viewBox="0 0 24 24"' +
    ' fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"' +
    ' stroke-linejoin="round" aria-hidden="true"><path d="m11 4-4 16"></path>' +
    '<path d="m17 4-4 16"></path></svg><span>Difficulty</span>';

  const pills = document.createElement("div");
  pills.className = "be-tg-pills";
  for (const tier of CHALLENGE_TIERS) {
    const btn = document.createElement("button");
    btn.type = "button";
    btn.className = "be-tg-pill";
    btn.dataset.beTier = tier.id;
    btn.textContent = tier.label;
    btn.title = `Difficulty ${tier.range}`;
    btn.setAttribute("aria-pressed", "false");
    btn.addEventListener("click", () => toggleChallengeTier(tier.id));
    pills.appendChild(btn);
  }

  section.append(label, pills);
  return section;
}

function syncDifficultyPills(section) {
  for (const btn of section.querySelectorAll(".be-tg-pill")) {
    const on = pendingChallengeTiers.includes(btn.dataset.beTier);
    btn.setAttribute("aria-pressed", on ? "true" : "false");
  }
}

function syncChallengeFilterUi() {
  const section = document.getElementById("be-tg-difficulty");
  if (section) syncDifficultyPills(section);
  ensureChallengeFilterDot();
}

// Pending only — nothing applies until Boot.dev's Search commits it, exactly
// like the native pills.
function toggleChallengeTier(id) {
  pendingChallengeTiers = pendingChallengeTiers.includes(id)
    ? pendingChallengeTiers.filter((tier) => tier !== id)
    : normalizeChallengeTiers([...pendingChallengeTiers, id]);
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
  document.getElementById("be-tg-difficulty")?.remove();
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
    if (
      btn &&
      !btn.closest("#be-tg-difficulty") &&
      normalizeText(btn.textContent).toLowerCase() === "clear filters"
    ) {
      pendingChallengeTiers = [];
      syncChallengeFilterUi();
    }
  }

  // Re-ensure after Vue reacts to the click: once quickly for the common
  // case, once later for slow renders. Both are idempotent.
  setTrackedTimeout(ensureTrainingGroundsUiState, 50);
  setTrackedTimeout(ensureTrainingGroundsUiState, 400);
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
      document.documentElement.removeAttribute(CHALLENGE_DIFF_ATTR);
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
