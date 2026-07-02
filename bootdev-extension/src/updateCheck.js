// updateCheck.js
// Opt-in GitHub release check (default OFF, gated by the `versionCheck` setting).
// When enabled, fetches the latest release tag at most once per 24h and toasts if
// a newer version exists. The GitHub REST API sends Access-Control-Allow-Origin:
// *, so this works from the content script under standard CORS with NO host
// permission — the extension still requests only `storage` + www.boot.dev. Fails
// silently when offline or rate-limited. When the setting is off, a single
// one-time toast nudges the user that the opt-in exists.

const UPDATE_CHECK_STATE_KEY = "be_update_check";
const UPDATE_OPTIN_INTRO_KEY = "be_update_optin_introduced";
const UPDATE_CHECK_INTERVAL_MS = 24 * 60 * 60 * 1000; // throttle: at most daily
const LATEST_RELEASE_URL = "https://api.github.com/repos/breaking-boot/catalyst/releases/latest";
const RELEASES_PAGE_URL = "https://github.com/breaking-boot/catalyst/releases";

function currentExtensionVersion() {
  try {
    return chrome.runtime.getManifest().version;
  } catch (_) {
    return "0.0.0";
  }
}

function parseVersion(value) {
  return String(value || "")
    .replace(/^v/i, "")
    .split(".")
    .map((n) => parseInt(n, 10) || 0);
}

// >0 when a is newer than b, <0 when older, 0 when equal.
function compareVersions(a, b) {
  const pa = parseVersion(a);
  const pb = parseVersion(b);
  const len = Math.max(pa.length, pb.length);
  for (let i = 0; i < len; i++) {
    const diff = (pa[i] || 0) - (pb[i] || 0);
    if (diff !== 0) return diff > 0 ? 1 : -1;
  }
  return 0;
}

async function maybeRunVersionCheck() {
  if (enhancerStopped) return;
  if (!isFeatureEnabled("versionCheck")) {
    await maybeNudgeVersionOptIn();
    return;
  }

  const state = (await chromeGet(UPDATE_CHECK_STATE_KEY)) || {};
  if (enhancerStopped) return;

  const now = Date.now();
  // Within the throttle window: don't hit the network, but still re-surface a
  // known-available update we haven't yet told the user about.
  if (state.checkedAt && now - state.checkedAt < UPDATE_CHECK_INTERVAL_MS) {
    notifyIfBehind(state.latest, state.notifiedVersion);
    return;
  }

  let latest = null;
  try {
    const res = await fetch(LATEST_RELEASE_URL, { headers: { accept: "application/vnd.github+json" } });
    if (res.ok) {
      const data = await res.json();
      const tag = String(data?.tag_name || "").replace(/^v/i, "");
      latest = tag || null;
    }
  } catch (_) {
    // Offline or rate-limited: keep the previous state, try again next window.
  }

  const next = {
    checkedAt: now,
    latest: latest || state.latest || null,
    notifiedVersion: state.notifiedVersion || null,
  };
  await chromeSet(UPDATE_CHECK_STATE_KEY, next);
  if (enhancerStopped) return;
  notifyIfBehind(next.latest, next.notifiedVersion);
}

function notifyIfBehind(latest, notifiedVersion) {
  if (!latest || enhancerStopped) return;
  const current = currentExtensionVersion();
  if (compareVersions(latest, current) <= 0) return; // up to date
  if (notifiedVersion === latest) return; // already announced this one

  toast(`Catalyst v${latest} is available (you have v${current}). Get it at ${RELEASES_PAGE_URL}`);
  chromeSet(UPDATE_CHECK_STATE_KEY, { checkedAt: Date.now(), latest, notifiedVersion: latest });
}

// One-time nudge, shown only after the settings intro so the two first-run toasts
// never collide. Points users at the opt-in without any network activity.
async function maybeNudgeVersionOptIn() {
  const introSeen = await chromeGet(SETTINGS_INTRO_KEY);
  if (!introSeen || enhancerStopped) return;
  const nudged = await chromeGet(UPDATE_OPTIN_INTRO_KEY);
  if (nudged || enhancerStopped) return;
  await chromeSet(UPDATE_OPTIN_INTRO_KEY, { shownAt: Date.now() });
  if (enhancerStopped) return;
  toast("Tip: turn on automatic update checks in Catalyst's options (right-click the toolbar icon → Options).");
}
