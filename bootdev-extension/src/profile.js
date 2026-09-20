// profile.js
// Cumulative XP display on public user profile pages (/u/<username>).
// Handles: handleProfileStats (and any related helpers).

function isProfilePage() {
  return /^\/u\/[^/]+\/?$/.test(location.pathname);
}

// The handle whose profile is on screen, read from the URL. Every render is
// gated on it: see handlePublicUserResponse.
function currentProfileHandle() {
  try {
    return normalizeHandle(decodeURIComponent(location.pathname.split("/")[2] || "").trim());
  } catch (_) {
    return "";
  }
}

// True for anything in the page's own chrome. The badge must never attach
// here: on the rebuilt profile page (2026-09-18) the only element whose text
// is "Level <n>" is the SIGNED-IN USER'S level display in the nav, so a
// document-wide anchor search reliably found the header and injected the badge
// over it — with, when the response was for someone else, that other person's
// numbers. Both halves of that are fixed; this is the belt.
function isPageChrome(el) {
  return Boolean(el && el.closest("nav, header, #mobile-menu"));
}

// ===========================================================================
// FEATURE 2: Cumulative XP on profiles
// ===========================================================================
// Last non-stats public-user response, kept so the badge can be re-rendered when
// its toggle flips back on (no fresh API call happens on a settings change).
let lastProfileStatsJson = null;

// EVERY /v1/users/public/{handle} response reaches here, whoever asked for it:
// Boot.dev's own page fetch, Nuxt's link prefetch when a menu item is hovered,
// and Catalyst's own background sweeps (the roster XP refresh and the
// tracked-handle refreshes relay through the same router). Until v0.15.1 all of
// them repainted whatever profile page happened to be open, because the render
// checked only isProfilePage() and never that the response described the person
// on screen.
//
// Measured 2026-09-19: hovering "Profile" in the avatar menu prefetched the
// signed-in user's profile and repainted a stranger's page with the signed-in
// user's XP, level progress and tracked-state — and, because none of that
// person's text is on the page, the anchor search widened and landed in the
// header. The roster sweep did the same thing without any hover at all.
//
// So the render is bound to the URL. Off-page responses still update the
// roster and the personal records through updatePersonalUserData above; they
// just no longer touch the screen.
function handlePublicUserResponse(username, isStats, json) {
  updatePersonalUserData(username, isStats, json);
  if (isStats) return;

  const data = json?.data ?? json;
  const responseHandle = normalizeHandle(readField(data, "Handle") || username);
  const pageHandle = currentProfileHandle();
  if (!pageHandle || responseHandle !== pageHandle) return;

  lastProfileStatsJson = json;
  handleProfileStats(json);
}

// Re-run the profile injection from cached data (used by applyFeatureSettings so
// toggling Profile XP / Personal Leaderboards back on takes effect immediately).
function reapplyProfileStats() {
  if (isProfilePage() && lastProfileStatsJson) handleProfileStats(lastProfileStatsJson);
}

// Cold page loads (F5 / direct URL) server-render the profile without firing
// the public-user API call this feature listens for — same class of issue as
// the Training Grounds cold loads — so the badge never appeared until an SPA
// navigation caused a real fetch. When the page shows a profile but nothing
// is injected and nothing usable is cached, request the data explicitly (the
// path is already relay-allowlisted and routed). Re-asks at most every 30s
// while data is missing; stops as soon as the badge exists.
const PROFILE_REQUEST_RETRY_MS = 30_000;
let lastProfileDataRequest = null; // { handle, at }

function ensureProfileUiState() {
  if (enhancerStopped) return;
  if (!isProfilePage()) {
    lastProfileDataRequest = null;
    return;
  }
  if (!isFeatureEnabled("profileXp") && !isFeatureEnabled("personalLeaderboards")) return;

  let rawHandle = "";
  try {
    rawHandle = decodeURIComponent(location.pathname.split("/")[2] || "").trim();
  } catch (_) {}
  const handle = normalizeHandle(rawHandle);
  if (!isValidHandle(handle)) return;

  // Rendered elements are stamped with the handle they describe. Checking only
  // that they EXIST treated a profile-to-profile navigation as already done,
  // which is one of the ways the badge could sit there describing someone else.
  if (renderedProfileHandle() === handle) return;

  // A cached response for this same profile just needs a re-render.
  const cached = lastProfileStatsJson?.data ?? lastProfileStatsJson;
  if (normalizeHandle(readField(cached, "Handle")) === handle) {
    handleProfileStats(lastProfileStatsJson);
    return;
  }

  if (
    lastProfileDataRequest &&
    lastProfileDataRequest.handle === handle &&
    Date.now() - lastProfileDataRequest.at < PROFILE_REQUEST_RETRY_MS
  ) {
    return;
  }
  lastProfileDataRequest = { handle, at: Date.now() };
  // Request with the URL's original casing; only comparisons are normalized.
  requestApiJson(`https://api.boot.dev/v1/users/public/${encodeURIComponent(rawHandle)}`);
}

// Renders are versioned because several can be in flight at once: each one
// waits for an anchor, and the page refetches the profile repeatedly (five
// times in 25 seconds, measured 2026-09-19). Without this, an older wait could
// resolve after a newer render and re-anchor the badge underneath it.
let profileRenderVersion = 0;

// The handle the currently-rendered elements describe, or "" when nothing is
// rendered. Stamped at render time; read by ensureProfileUiState.
function renderedProfileHandle() {
  const el = document.getElementById("be-total-xp") || document.getElementById("be-profile-personal-add");
  return el ? normalizeHandle(el.getAttribute("data-be-handle")) : "";
}

function handleProfileStats(json) {
  if (!isProfilePage()) return;

  const profile = json?.data ?? json;
  const totalXp = readField(profile, "XP") ?? null;
  if (totalXp == null) return;

  // Belt to handlePublicUserResponse's braces: reapplyProfileStats and the
  // ensureProfileUiState cache path both re-render from a stored response, and
  // neither should be able to paint a profile the user has since navigated away
  // from.
  const handle = normalizeHandle(readField(profile, "Handle"));
  if (!handle || handle !== currentProfileHandle()) return;

  const wantBadge = isFeatureEnabled("profileXp");
  const wantAddButton = isFeatureEnabled("personalLeaderboards");
  if (!wantBadge && !wantAddButton) {
    removeProfileXpBadge();
    return;
  }

  const version = ++profileRenderVersion;
  waitFor(() => findProfileBadgeAnchor(profile)).then((anchor) => {
    const card = findProfileCard(profile);
    if (version !== profileRenderVersion) return; // superseded
    if (!isProfilePage() || handle !== currentProfileHandle()) return;
    if (!anchor) {
      // Graceful degradation is what makes a rename invisible: with no anchor
      // this feature renders nothing and looks exactly like being switched off,
      // which is how the 2026-09-18 page rebuild went unnoticed. One line per
      // session is the whole counterweight.
      warnOnce(
        "profile:anchor",
        "Profile page: no anchor resolved inside the profile card, so the XP badge " +
        "and the Personal Leaderboards button cannot be placed. Boot.dev may have " +
        "rebuilt the card. See findProfileCard() in profile.js."
      );
      return;
    }

    let badge = null;
    if (wantBadge) {
      badge = document.getElementById("be-total-xp");
      if (!badge) {
        badge = document.createElement("div");
        badge.id = "be-total-xp";
        badge.className = "be-profile-total-xp";
      }
      const progress = getLevelProgress(profile);
      // Total XP stays even though the rebuilt page has an "XP EARNED" tile:
      // that tile row is a PRIORITY LIST, not a fixed set. A profile with
      // several completed paths renders PATH COMPLETED tiles instead, and shows
      // no cumulative XP anywhere (observed 2026-09-19). Remaining is never
      // shown natively at all.
      //
      // The current/needed pair IS shown natively, at the ends of the progress
      // bar. The badge states it as one line and hides those two — so the page
      // shows it once, not twice, and only when the badge is actually placed
      // under the bar.
      const underProgressBar = anchor === findProfileProgressRow(card);
      const progressMarkup = progress
        ? `${underProgressBar ? `<div class="be-profile-level-xp">${fmtNum(progress.current)} / ${fmtNum(progress.total)} XP</div>` : ""}
           <div class="be-profile-remaining-xp">Remaining: <strong>${fmtNum(progress.remaining)} XP</strong></div>`
        : "";
      badge.innerHTML = `<div>Total XP: <strong>${fmtNum(totalXp)}</strong></div>${progressMarkup}`;
      badge.setAttribute("data-be-handle", handle);
      // INSIDE the level block, not after it. The block is one item in the
      // card's flex row, so a sibling inserted after it becomes another item,
      // wraps to a new line and renders full width at the bottom of the card —
      // which is where the badge and the button landed, with the button
      // stretched across the whole card.
      if (underProgressBar) {
        if (badge.parentElement !== anchor) anchor.appendChild(badge);
      } else {
        anchor.insertAdjacentElement("afterend", badge);
      }
      if (underProgressBar && progress) hideNativeLevelXpLabels(card, progress);
      else restoreNativeLevelXpLabels();
    } else {
      document.getElementById("be-total-xp")?.remove();
      restoreNativeLevelXpLabels();
    }

    // The add button anchors after the badge when present, otherwise after the
    // profile anchor, so it still works when only personal leaderboards are on.
    if (wantAddButton) {
      renderProfilePersonalAddButton(profile, badge || anchor);
    } else {
      document.getElementById("be-profile-personal-add")?.remove();
    }
  });
}

function getLevelProgress(profile) {
  const current = readNum(profile, "XPForLevel");
  const total = readNum(profile, "XPTotalForLevel");
  if (current == null || total == null || total <= 0) return null;

  return {
    current,
    total,
    remaining: Math.max(0, total - current),
  };
}

// THE CARD, then the anchor inside it — in that order, and never the other way
// round. Every lookup here is rendered text, because no API tells Catalyst
// where to inject; the ordering is what keeps a text match from escaping into
// the page chrome.
//
// The 2026-09-18 rebuild broke the previous approach completely, and measuring
// it (probe 16, three runs) is what this is built from:
//   * the card carries no "@handle" text node at all — the "@" is an icon — and
//     renders the level as separate "LEVEL" and "209" elements, so the old
//     scope lookup, which needed name + handle + "Level <n>" in one element,
//     matched nothing on any profile;
//   * with no scope, the level lookup searched the whole document, where the
//     only "Level <n>" text is the signed-in user's own level in the nav;
//   * the name heading resolved correctly on every run, inside the card's
//     <section>, which is where the badge is wanted anyway.
const PROFILE_CARD_MAX_TEXT = 650;

function depthOf(el) {
  let depth = 0;
  for (let node = el.parentElement; node; node = node.parentElement) depth += 1;
  return depth;
}

function findProfileCard(profile) {
  const fullName = getProfileFullName(profile);
  const handle = normalizeHandle(readField(profile, "Handle"));
  if (!fullName && !handle) return null;

  const candidates = [];
  for (const el of document.querySelectorAll("main section, main article, #__nuxt section, #__nuxt article")) {
    if (isPageChrome(el)) continue;
    const text = normalizeText(el.textContent);
    if (!text || text.length > PROFILE_CARD_MAX_TEXT) continue; // skip page-level wrappers
    const matches = (fullName && text.includes(fullName)) ||
      (handle && text.toLowerCase().includes(handle));
    if (matches) candidates.push({ el, len: text.length, depth: depthOf(el) });
  }
  if (!candidates.length) return null;

  // Tightest match wins, so a wrapper that merely contains the card loses to
  // the card — but a wrapper holding ONLY the card has identical text, so a
  // length comparison ties and the deeper element has to win the tie. Without
  // that, document order hands back the ancestor and the badge is injected a
  // level too high.
  candidates.sort((a, b) => (a.len - b.len) || (b.depth - a.depth));
  const best = candidates[0];
  // Corroborator, among the equally tight ones only: the level progress bar
  // carries role="progressbar" and lives in the same section as the name.
  const tied = candidates.filter((c) => c.len === best.len);
  const withBar = tied.find(({ el }) => el.querySelector('[role="progressbar"]'));
  return (withBar || best).el;
}

// Preferred placement is directly under the level progress bar, because that is
// where the figures the badge carries belong: the bar shows progress toward the
// next level and its own labels state the same two numbers the badge
// consolidates. The bar is found by role and aria-label rather than by text,
// which makes it the most stable anchor on the page.
//
// The name heading stays as the fallback, so a card that drops the bar still
// gets a badge rather than none.
function findProfileProgressRow(card) {
  const bar = card.querySelector('[role="progressbar"]');
  if (!bar) return null;
  // The bar's own parent holds the bar and its two XP labels, so inserting
  // after it puts the badge below the whole level block.
  const row = bar.parentElement || bar;
  return isPageChrome(row) ? null : row;
}

function findProfileBadgeAnchor(profile) {
  const card = findProfileCard(profile);
  if (!card) return null;

  const progressRow = findProfileProgressRow(card);
  if (progressRow) return progressRow;

  const fullName = getProfileFullName(profile);
  const headings = Array.from(card.querySelectorAll("h1,h2,h3,[role='heading']"));
  const named = fullName
    ? headings.find((el) => normalizeText(el.textContent) === fullName)
    : null;
  const anchor = named || headings[0] || null;
  // The card was already excluded from the chrome, but the anchor is what gets
  // an element inserted next to it, so it is checked on its own terms.
  return anchor && !isPageChrome(anchor) ? anchor : null;
}

function getProfileFullName(profile) {
  return [readField(profile, "FirstName"), readField(profile, "LastName")]
    .filter(Boolean)
    .join(" ")
    .trim();
}

function removeProfileXpBadge() {
  document.getElementById("be-total-xp")?.remove();
  document.getElementById("be-profile-personal-add")?.remove();
  restoreNativeLevelXpLabels();
}

// The progress bar labels its ends with "<current> XP" and "<needed> XP" as two
// separate elements. When the badge sits under the bar it states the same pair
// as one line, so the native two are HIDDEN rather than removed.
//
// Hidden, specifically, and this is the whole point: the previous version of
// this feature DELETED the native line, and removing a child from markup Vue
// hydrated and patches is the same hazard that corrupted the nav — structural
// edits to someone else's list are what shift positions. Setting display:none
// changes no structure, is reversible when the feature is switched off, and
// fails visibly (a duplicate) rather than destructively (a missing bar) if the
// text ever stops matching.
//
// Re-applied on every render because Vue restores its own elements when it
// re-renders the card, which it does often.
function hideNativeLevelXpLabels(card, progress) {
  if (!card || !progress) return;
  const wanted = new Set([
    `${fmtNum(progress.current)} xp`,
    `${fmtNum(progress.total)} xp`,
  ]);
  for (const el of card.querySelectorAll("span, p, div")) {
    if (el.children.length) continue; // leaf labels only
    if (el.closest("#be-total-xp")) continue; // never our own
    if (!wanted.has(normalizeText(el.textContent).toLowerCase())) continue;
    if (el.getAttribute("data-be-hidden") === "1" && el.style.display === "none") continue;
    el.setAttribute("data-be-hidden", "1");
    el.style.display = "none";
  }
}

// Put back everything hideNativeLevelXpLabels hid — on teardown, and whenever
// the badge is not being rendered. Switching the feature off has to leave the
// page exactly as Boot.dev drew it.
function restoreNativeLevelXpLabels() {
  for (const el of document.querySelectorAll('[data-be-hidden="1"]')) {
    el.style.display = "";
    el.removeAttribute("data-be-hidden");
  }
}

function renderProfilePersonalAddButton(profile, anchor) {
  const handle = normalizeHandle(readField(profile, "Handle"));
  if (!isValidHandle(handle) || !anchor) return;

  let button = document.getElementById("be-profile-personal-add");
  if (!button) {
    button = document.createElement("button");
    button.id = "be-profile-personal-add";
    button.className = "be-profile-personal-add";
    button.type = "button";
  }
  button.setAttribute("data-be-handle", handle);

  const added = isPersonalHandle(handle);
  button.disabled = added;
  button.textContent = added ? "In Personal Leaderboards" : "Add to Personal Leaderboards";
  button.onclick = added
    ? null
    : async () => {
        button.disabled = true;
        button.textContent = "Adding...";
        await addPersonalHandle(handle);
        const message = personalFeedback?.text || (isPersonalHandle(handle) ? `Added @${handle}` : "Could not add user");
        toast(message);
        renderProfilePersonalAddButton(profile, anchor);
      };

  anchor.insertAdjacentElement("afterend", button);
}

// Test hook: scripts/check_profile_anchor.mjs predefines this global before
// evaluating the file. Never defined on the real page.
if (typeof window !== "undefined" && window.__BOOTDEV_ENHANCER_TEST__) {
  window.__BOOTDEV_ENHANCER_TEST__.profile = {
    findProfileCard,
    findProfileBadgeAnchor,
    findProfileProgressRow,
    isPageChrome,
    getLevelProgress,
    getProfileFullName,
    constants: { PROFILE_CARD_MAX_TEXT },
  };
}
