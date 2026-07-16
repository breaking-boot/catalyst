// trainingGrounds.js
// Training Grounds (Challenge Catalog) difficulty filter. Injects a Catalyst
// "Difficulty" section into Boot.dev's filter popover, persists the selected
// tiers, pushes them into the page context (injected.js filters the
// challenges/search response before Vue consumes it, so the native list,
// count, and pagination stay correct), and commits selection changes by
// asking the page to refresh its own search.
//
// Evidence and design decisions: reference_data/catalyst_versions/
// v0.10.0_challenge_difficulty_filter/difficulty_filter_plan.md

const CHALLENGE_FILTER_KEY = "be_challenge_filter";
const CHALLENGE_FILTER_FEATURE = "challengeDifficulty";
// Also written into the page URL by injected.js on refresh; adopted back on
// load so shared search URLs carry the difficulty between Catalyst users.
const CHALLENGE_DIFF_URL_PARAM = "diff";
// Keep ids/bounds in sync with DIFFICULTY_TIERS in injected.js. The bounds
// mirror boot.dev's own difficulty icon tiers (easy/medium/hard filenames).
const CHALLENGE_TIERS = [
  { id: "easy", label: "Easy", range: "1-4" },
  { id: "medium", label: "Medium", range: "5-7" },
  { id: "hard", label: "Hard", range: "8-10" },
];

let challengeFilterTiers = []; // selected tier ids, canonical order
let lastChallengeSearch = null; // what the page currently renders (from relay)
let lastChallengeRefreshSignature = null; // one refresh per selection; no loops
let lastSeenChallengeDiffParam = null; // URL adoption fires on value change only

function isTrainingGroundsPage() {
  // The catalog lands on /training-grounds; executing a search navigates the
  // SPA to /training-grounds/search?q=...
  return /^\/training-grounds(?:\/search)?\/?$/.test(location.pathname);
}

// ---------------------------------------------------------------------------
// Selection state
// ---------------------------------------------------------------------------

function normalizeChallengeTiers(value) {
  const list = Array.isArray(value) ? value : [];
  return CHALLENGE_TIERS.map((t) => t.id).filter((id) => list.includes(id));
}

function challengeTiersEqual(a, b) {
  return a.length === b.length && a.every((tier, i) => tier === b[i]);
}

// 1-2 tiers filter; none or all three means "all difficulties" (no filtering).
function challengeSelectionActive() {
  return challengeFilterTiers.length >= 1 && challengeFilterTiers.length < CHALLENGE_TIERS.length;
}

async function loadChallengeFilterState() {
  const raw = await chromeGet(CHALLENGE_FILTER_KEY);
  challengeFilterTiers = normalizeChallengeTiers(raw && raw.tiers);
  adoptChallengeTiersFromUrl();
}

function persistChallengeTiers() {
  chromeSet(CHALLENGE_FILTER_KEY, { tiers: challengeFilterTiers.slice() });
}

// A pasted /training-grounds/search?...&diff=easy,medium URL arms the filter
// to match. Only reacts when the param's value changes, so Catalyst's own
// refresh pushes (which write the current selection) are no-ops here.
function adoptChallengeTiersFromUrl() {
  let raw = null;
  try {
    raw = new URLSearchParams(location.search).get(CHALLENGE_DIFF_URL_PARAM);
  } catch (_) {}
  if (raw === lastSeenChallengeDiffParam) return;
  lastSeenChallengeDiffParam = raw;
  if (raw === null) return;
  const tiers = normalizeChallengeTiers(raw.split(","));
  if (!tiers.length || challengeTiersEqual(tiers, challengeFilterTiers)) return;
  challengeFilterTiers = tiers;
  persistChallengeTiers();
  pushChallengeFilterToPage();
  syncChallengeFilterUi();
}

// Another tab moved the selection (storage.onChanged). Adoption never writes
// storage, so our own writes round-tripping through onChanged are no-ops.
function adoptChallengeFilterChange(newValue) {
  const tiers = normalizeChallengeTiers(newValue && newValue.tiers);
  if (challengeTiersEqual(tiers, challengeFilterTiers)) return;
  challengeFilterTiers = tiers;
  pushChallengeFilterToPage();
  syncChallengeFilterUi();
  maybeCommitChallengeSelection();
}

// ---------------------------------------------------------------------------
// Page-context messaging
// ---------------------------------------------------------------------------

function pushChallengeFilterToPage() {
  if (enhancerStopped) return;
  window.postMessage(
    {
      source: TAG,
      command: "BE_SET_CHALLENGE_FILTER",
      payload: {
        enabled: isFeatureEnabled(CHALLENGE_FILTER_FEATURE),
        tiers: challengeFilterTiers.slice(),
      },
    },
    window.location.origin
  );
}

function requestChallengeSearchRefresh() {
  if (enhancerStopped) return;
  window.postMessage(
    { source: TAG, command: "BE_REFRESH_CHALLENGE_SEARCH", payload: {} },
    window.location.origin
  );
}

// Router handler: record what the page now renders, then settle any pending
// difficulty commit (also heals the mount race — an unfiltered first search
// while a selection is armed gets one refresh).
function handleChallengeSearch(json, catalyst) {
  if (!Array.isArray(json)) return;
  lastChallengeSearch = {
    at: Date.now(),
    shownCount: json.length,
    originalCount: Number.isFinite(catalyst?.originalCount) ? catalyst.originalCount : json.length,
    filtered: catalyst?.filtered === true,
    appliedTiers: normalizeChallengeTiers(catalyst?.appliedTiers),
  };
  console.debug("[catalyst] challenge search", lastChallengeSearch);
  ensureChallengeFilterDot();
  maybeCommitChallengeSelection();
}

// Refresh the rendered results iff they don't reflect the current selection.
// The signature guard makes every distinct selection worth at most one
// automatic refresh, so a lost state push can never cause a refresh loop.
function maybeCommitChallengeSelection() {
  if (enhancerStopped || !isTrainingGroundsPage()) return;
  if (!isFeatureEnabled(CHALLENGE_FILTER_FEATURE)) return;
  if (!lastChallengeSearch) return; // nothing rendered yet; next search applies it
  if (findChallengeFilterPopover()) return; // still open; commit on close
  const effective = challengeSelectionActive() ? challengeFilterTiers : [];
  const applied = lastChallengeSearch.filtered ? lastChallengeSearch.appliedTiers : [];
  if (challengeTiersEqual(effective, applied)) {
    lastChallengeRefreshSignature = null;
    return;
  }
  const signature = effective.join(",");
  if (signature === lastChallengeRefreshSignature) return;
  lastChallengeRefreshSignature = signature;
  pushChallengeFilterToPage(); // re-sync first in case a push was lost
  requestChallengeSearchRefresh();
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

// Idempotent per-tick ensure: called on route change, the 2s DOM scan, and
// (delayed) after clicks. Self-tears-down off-route or when disabled.
function ensureTrainingGroundsUiState() {
  if (enhancerStopped) return;
  if (!isTrainingGroundsPage() || !isFeatureEnabled(CHALLENGE_FILTER_FEATURE)) {
    removeTrainingGroundsUi();
    if (!isTrainingGroundsPage()) {
      lastChallengeSearch = null;
      lastChallengeRefreshSignature = null;
      lastSeenChallengeDiffParam = null;
    }
    return;
  }
  adoptChallengeTiersFromUrl();
  ensureChallengeFilterDot();
  ensureDifficultySection();
  maybeCommitChallengeSelection(); // Esc-close backstop
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
  label.textContent = "Difficulty";

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
    const on = challengeFilterTiers.includes(btn.dataset.beTier);
    btn.setAttribute("aria-pressed", on ? "true" : "false");
  }
}

function syncChallengeFilterUi() {
  const section = document.getElementById("be-tg-difficulty");
  if (section) syncDifficultyPills(section);
  ensureChallengeFilterDot();
}

function toggleChallengeTier(id) {
  challengeFilterTiers = challengeFilterTiers.includes(id)
    ? challengeFilterTiers.filter((tier) => tier !== id)
    : normalizeChallengeTiers([...challengeFilterTiers, id]);
  persistChallengeTiers();
  pushChallengeFilterToPage();
  syncChallengeFilterUi();
  // No refresh here: the commit happens when the popover closes.
}

function clearChallengeTiers() {
  if (!challengeFilterTiers.length) return;
  challengeFilterTiers = [];
  persistChallengeTiers();
  pushChallengeFilterToPage();
  syncChallengeFilterUi();
}

// Small gold dot on the filter button while a filtering selection is armed —
// visible even with the popover closed, without duplicating any counts.
function ensureChallengeFilterDot() {
  const btn = findChallengeFilterButton();
  const existing = document.getElementById("be-tg-filter-dot");
  const want =
    Boolean(btn) &&
    isTrainingGroundsPage() &&
    isFeatureEnabled(CHALLENGE_FILTER_FEATURE) &&
    challengeSelectionActive();
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

// One delegated listener (capture phase, so page handlers can't swallow it).
// Covers: opening the popover (inject after Vue renders it), native
// "Clear filters" (clears difficulty too), and closing by button/outside
// click (commit). Esc-close is caught by the 2s scan.
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
      clearChallengeTiers();
    }
  }

  // Re-ensure after Vue reacts to the click: once quickly for the common
  // case, once later for slow renders. Both are idempotent.
  setTrackedTimeout(ensureTrainingGroundsUiState, 50);
  setTrackedTimeout(ensureTrainingGroundsUiState, 400);
}

function bindTrainingGroundsEvents() {
  document.addEventListener("click", handleTrainingGroundsClick, true);
}

function unbindTrainingGroundsEvents() {
  document.removeEventListener("click", handleTrainingGroundsClick, true);
}

// Live-apply of the feature toggle (from applyFeatureSettings).
function applyChallengeFilterSetting(before, after) {
  if (!before || !after) return;
  const was = before[CHALLENGE_FILTER_FEATURE] !== false;
  const now = after[CHALLENGE_FILTER_FEATURE] !== false;
  if (was === now) return;
  pushChallengeFilterToPage(); // carries the new enabled flag
  if (!now) {
    removeTrainingGroundsUi();
    // Restore the unfiltered view the user is looking at right now.
    if (isTrainingGroundsPage() && lastChallengeSearch?.filtered) {
      lastChallengeRefreshSignature = null;
      requestChallengeSearchRefresh();
    }
  } else {
    ensureTrainingGroundsUiState();
  }
}
