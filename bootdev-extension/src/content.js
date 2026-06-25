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
  if (!msg || msg.source !== TAG || !msg.payload) return;
  routeResponse(msg.payload);
});

// ---------------------------------------------------------------------------
// 3. Route responses to handlers by URL.
// ---------------------------------------------------------------------------
function routeResponse({ url, method, status, json }) {
  if (status < 200 || status >= 300) return;
  try {
    const path = new URL(url).pathname;

    if (path === "/v1/league_leaderboard_xp/alltime" ||
        path === "/v1/leaderboard_xp/alltime") {
      handleAllTimeLeaderboard(json);
    } else if (/\/v1\/users\/public\/[^/]+$/.test(path) ||
        /\/v1\/users\/public\/[^/]+\/stats$/.test(path)) {
      handleProfileStats(json);
    } else if (path === "/v1/boss_events_progress") {
      handleBossProgress(json);
    }
  } catch (e) {
    console.warn("[Boot.dev Enhancer] routing error", e);
  }
}

// ===========================================================================
// FEATURE 1: All-time XP leaderboard section
// ===========================================================================
function handleAllTimeLeaderboard(json) {
  const entries = getLeaderboardEntries(json);
  if (!entries.length) return;

  // The leaderboard page is an SPA route; wait for a stable container to exist.
  waitFor(() => findLeaderboardAnchor() || document.querySelector("main") || document.body).then((host) => {
    if (!host) return;
    let panel = document.getElementById("be-alltime-leaderboard");
    if (!panel) {
      panel = document.createElement("section");
      panel.id = "be-alltime-leaderboard";
      panel.className = "be-card";
      if (host.matches?.("h1,h2,h3,[role='heading']")) {
        host.insertAdjacentElement("afterend", panel);
      } else if (host.parentElement && !["MAIN", "BODY"].includes(host.tagName)) {
        host.insertAdjacentElement("afterend", panel);
      } else {
        host.prepend(panel);
      }
    }
    const rows = entries
      .slice(0, 25)
      .map((e, i) => {
        const name = e.Handle || "unknown";
        const xp = e.XPEarned ?? e.XP ?? 0;
        return `<li class="be-row">
            <span class="be-rank">${e.Position ?? i + 1}</span>
            <span class="be-name">${escapeHtml(name)}</span>
            <span class="be-xp">${Number(xp).toLocaleString()} XP</span>
          </li>`;
      })
      .join("");
    const title = json?.LeagueName
      ? `${escapeHtml(json.LeagueName)} all-time XP leaders`
      : "All-time XP leaders";
    panel.innerHTML = `
      <h2 class="be-title">${title}</h2>
      <ol class="be-list">${rows}</ol>`;
  });
}

// ===========================================================================
// FEATURE 2: Cumulative XP on profiles
// ===========================================================================
function handleProfileStats(json) {
  const profile = json?.data ?? json;
  const totalXp = profile?.XP ?? null;
  if (totalXp == null) return;

  waitFor(() => findProfileAnchor(profile) || document.querySelector("main") || document.body).then((anchor) => {
    if (!anchor) return;
    let badge = document.getElementById("be-total-xp");
    if (!badge) {
      badge = document.createElement("div");
      badge.id = "be-total-xp";
      badge.className = "be-badge";
      if (anchor.matches?.("h1,h2,h3,[role='heading']")) {
        anchor.insertAdjacentElement("afterend", badge);
      } else if (anchor.parentElement && !["MAIN", "BODY"].includes(anchor.tagName)) {
        anchor.insertAdjacentElement("afterend", badge);
      } else {
        anchor.prepend(badge);
      }
    }
    badge.textContent = `Total XP: ${Number(totalXp).toLocaleString()}`;
  });
}

// ===========================================================================
// FEATURE 3: Boss-event tracker (the stateful one)
// ===========================================================================
const BOSS_KEY = "be_boss_state";
const NEAR_HIGH_THRESHOLD = 0.95; // notify when current >= 95% of event high

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

  // Auto-detect a new event: eventId changed -> reset per-event stats.
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

function renderBossPanel(s) {
  waitFor(() => document.body).then(() => {
    let panel = document.getElementById("be-boss-panel");
    if (!panel) {
      panel = document.createElement("div");
      panel.id = "be-boss-panel";
      panel.className = "be-boss-panel";
      document.body.appendChild(panel);
    }
    const deltaToHigh =
      s.eventHigh > 0 ? (s.eventHigh - s.current).toFixed(0) : "0";
    const toNextChest =
      s.nextChestAt > 0 ? Math.max(0, s.nextChestAt - s.damage) : "?";
    const toDefeat =
      s.bossMaxHp > 0 ? Math.max(0, s.bossMaxHp - s.damage) : "?";

    panel.innerHTML = `
      <div class="be-boss-head">
        <span>Boss event</span>
        <button id="be-boss-reset" title="Reset stats for a new event">reset</button>
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
      </div>`;

    panel.querySelector("#be-boss-reset").onclick = async () => {
      const fresh = newEventState(s.eventId);
      fresh.allTimeHigh = s.allTimeHigh; // keep the all-time record
      await chromeSet(BOSS_KEY, { state: fresh });
      renderBossPanel(fresh);
    };
  });
}

function maybeNotifyNearHigh(s) {
  if (!s.eventHigh) return;
  const ratio = s.current / s.eventHigh;
  // Only fire when we're near the high AND haven't already notified for
  // this particular high value (avoid spamming on every poll).
  if (ratio >= NEAR_HIGH_THRESHOLD && s.notifiedHigh !== s.eventHigh) {
    toast(`Boots Aura at ${fmtPct(s.current)} — near event high (${fmtPct(s.eventHigh)}). Good time to submit.`);
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

// ---------------------------------------------------------------------------
// Small helpers
// ---------------------------------------------------------------------------
function getLeaderboardEntries(json) {
  if (Array.isArray(json)) return json;
  if (Array.isArray(json?.LeagueMembers)) return json.LeagueMembers;
  if (Array.isArray(json?.data)) return json.data;
  if (Array.isArray(json?.data?.LeagueMembers)) return json.data.LeagueMembers;
  return [];
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
function findLeaderboardAnchor() {
  // Boot.dev exposes no stable id/data hook for these sections; use visible
  // heading landmarks instead of brittle hashed Vue/Tailwind classes.
  const heading =
    findHeadingByText("Top League Learners") ||
    findHeadingByText("League Leaderboards") ||
    findHeadingByText("Global Leaderboards");
  return heading?.parentElement || heading;
}
function findProfileAnchor(profile) {
  const fullName = [profile?.FirstName, profile?.LastName]
    .filter(Boolean)
    .join(" ")
    .trim();
  return (
    (fullName && findHeadingByText(fullName)) ||
    (profile?.Handle && findElementByText(`@ ${profile.Handle}`)) ||
    null
  );
}
function findHeadingByText(text) {
  const target = normalizeText(text).toLowerCase();
  return Array.from(document.querySelectorAll("h1,h2,h3,[role='heading']")).find(
    (el) => normalizeText(el.textContent).toLowerCase() === target
  );
}
function findElementByText(text) {
  const target = normalizeText(text).toLowerCase();
  return Array.from(document.querySelectorAll("main *, #__nuxt *")).find(
    (el) => normalizeText(el.textContent).toLowerCase() === target
  );
}
function normalizeText(s) {
  return String(s || "").replace(/\s+/g, " ").trim();
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
