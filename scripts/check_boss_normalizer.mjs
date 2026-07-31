#!/usr/bin/env node
// Unit checks for the boss-event casing normalizer and the event-activity
// guards, exercised against the REAL shipped code: bootdev-extension/src/boss.js
// is evaluated in a vm sandbox with a stubbed window, and the helpers are
// pulled off the __BOOTDEV_ENHANCER_TEST__ hook (which is inert in production
// because that global never exists on the real page).
//
// Run from anywhere:  node scripts/check_boss_normalizer.mjs
// Exits non-zero on any failure (same spirit as the node --check gate).
//
// Why this exists: /v1/boss_events_progress is mid-migration. The live-event
// capture (2026-06-26) is PascalCase; between-events captures on 2026-07-16 and
// 2026-07-31 are entirely camelCase. The normalizer used to bail out whenever
// `Event` was present, so a MIXED response would slip through untouched and
// silently freeze the tracker's aura %. These checks pin that down.

import { readFileSync, existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import vm from "node:vm";

const BOSS = new URL("../bootdev-extension/src/boss.js", import.meta.url);
const CAPTURES = new URL("../reference_data/http_responses_from_api_endpoints/", import.meta.url);
const AUDIT_BODIES = new URL(
  "../reference_data/catalyst_versions/v0.12.2_api_casing_audit/api/responses/api_bodies_v3_2026-07-31.json",
  import.meta.url
);

// --- evaluate boss.js in a sandbox ------------------------------------------

const testHook = {};
const sandbox = {
  window: { __BOOTDEV_ENHANCER_TEST__: testHook },
  document: { addEventListener() {}, removeEventListener() {}, getElementById: () => null },
  location: { pathname: "/" },
  console,
  setInterval: () => 0,
  clearInterval() {},
  setTimeout: () => 0,
  clearTimeout() {},
};
// boss.js reads a few helpers from the shared content-script scope. Loading
// utils.js whole would drag in chrome.* globals, so provide just those.
vm.createContext(sandbox);
vm.runInContext(
  `function isPlainObject(v){return Boolean(v)&&typeof v==="object"&&!Array.isArray(v);}
   function num(v){const n=Number(v);return Number.isFinite(n)?n:null;}
   function pct(v){const n=num(v);if(n==null)return null;return n>0&&n<=1?n*100:n;}
   function clamp(v,a,b){return Math.min(b,Math.max(a,Number(v)));}
   function fmtPct(v){return v==null?"-":Math.round(v)+"%";}
   function fmtNum(v){return v==="?"||v==null?"?":Number(v).toLocaleString();}
   function escapeHtml(s){return String(s);}
   function waitFor(){return Promise.resolve(null);}
   function toast(){}
   function chromeGet(){return Promise.resolve(undefined);}
   function chromeSet(){return Promise.resolve(true);}
   function setTrackedTimeout(){return 0;}
   function setTrackedInterval(){return 0;}
   function clearTrackedTimeout(){}
   function isFeatureEnabled(){return false;}
   function setFeatureEnabled(){return Promise.resolve(true);}
   function handleAsyncError(){}
   function requestApiJson(){return false;}
   function markBossAuthUnavailable(){}
   let enhancerStopped = false;`,
  sandbox
);
vm.runInContext(readFileSync(BOSS, "utf8"), sandbox, { filename: fileURLToPath(BOSS) });

const boss = testHook.boss;
if (!boss) {
  console.error("FAIL: boss.js did not expose test hooks");
  process.exit(1);
}
const { pickField, normalizeBossProgressJson, hasBossEventIdentity, isBossEventActive, getBossRewards, getNextChestAt } = boss;

// --- tiny assert ------------------------------------------------------------

let failures = 0;
let checks = 0;
function check(label, actual, expected) {
  checks += 1;
  const a = JSON.stringify(actual);
  const e = JSON.stringify(expected);
  if (a !== e) {
    failures += 1;
    console.error(`FAIL: ${label}\n  expected ${e}\n  got      ${a}`);
  }
}

// --- pickField --------------------------------------------------------------

check("pickField prefers PascalCase", pickField({ XPBonus: 1, xpBonus: 2 }, "XPBonus", "xpBonus"), 1);
check("pickField falls back to camelCase", pickField({ xpBonus: 2 }, "XPBonus", "xpBonus"), 2);
check("pickField reads a legitimate 0", pickField({ xpBonus: 0 }, "XPBonus", "xpBonus"), 0);
check("pickField reads a legitimate false", pickField({ isUnlocked: false }, "IsUnlocked", "isUnlocked"), false);
check("pickField on a non-object", pickField(null, "A", "a"), undefined);
check("pickField with neither spelling", pickField({ other: 1 }, "A", "a"), undefined);

// --- the S3 regression: a MIXED response must still normalize ----------------
// The old gate was `if (json.Event) return json` — with Event present but the
// scalars renamed, XPBonus read undefined, the `!= null` guard in
// handleBossProgress skipped the write, and the panel froze on its last aura.

const mixed = {
  Event: { UUID: "e1", ExpiresAt: "2099-01-01T00:00:00Z", healthPoints: 500 },
  xpBonus: 0.4,
  xpTotal: 1234,
  rewards: [{ xpThreshold: 10, isUnlocked: false }],
};
const nm = normalizeBossProgressJson(mixed);
check("mixed: PascalCase Event survives", nm.Event.UUID, "e1");
check("mixed: camelCase healthPoints is mapped", nm.Event.HealthPoints, 500);
check("mixed: camelCase xpBonus is mapped (S3 regression)", nm.XPBonus, 0.4);
check("mixed: camelCase xpTotal is mapped", nm.XPTotal, 1234);
check("mixed: camelCase rewards are mapped", nm.Rewards[0].XPThreshold, 10);
check("mixed: reward booleans survive", nm.Rewards[0].IsUnlocked, false);
check("mixed: still reads as an identifiable event", hasBossEventIdentity(nm), true);
check("mixed: still reads as active", isBossEventActive(nm), true);

// --- fully camelCase and fully PascalCase both normalize --------------------

const camel = {
  event: { uuid: "c1", startsAt: "2026-01-01T00:00:00Z", expiresAt: "2099-01-01T00:00:00Z", healthPoints: 9, boss: { uuid: "b", name: "Malcolm" } },
  xpBonus: 0.25,
  rewards: [{ uuid: "r", chestUUID: "c", xpThreshold: 5, userXPThreshold: 1, isUnlocked: true, isUnlockedByUser: true }],
};
const nc = normalizeBossProgressJson(camel);
check("camel: Event.UUID", nc.Event.UUID, "c1");
check("camel: Event.ExpiresAt", nc.Event.ExpiresAt, "2099-01-01T00:00:00Z");
check("camel: Event.HealthPoints", nc.Event.HealthPoints, 9);
check("camel: Boss.Name", nc.Event.Boss.Name, "Malcolm");
check("camel: XPBonus", nc.XPBonus, 0.25);
check("camel: Rewards[0].IsUnlockedByUser", nc.Rewards[0].IsUnlockedByUser, true);
check("camel: identity", hasBossEventIdentity(nc), true);

const pascal = {
  Event: { UUID: "p1", StartsAt: "2026-01-01T00:00:00Z", ExpiresAt: "2099-01-01T00:00:00Z", HealthPoints: 7 },
  XPBonus: 0.5,
  Rewards: [{ UUID: "r", XPThreshold: 3, IsUnlocked: true, IsUnlockedByUser: false }],
};
const np = normalizeBossProgressJson(pascal);
check("pascal: Event.UUID unchanged", np.Event.UUID, "p1");
check("pascal: XPBonus unchanged", np.XPBonus, 0.5);
check("pascal: Rewards unchanged", np.Rewards[0].XPThreshold, 3);
check("pascal: IsUnlockedByUser false survives", np.Rewards[0].IsUnlockedByUser, false);

// --- shapes that carry no event ---------------------------------------------

check("error body is handed back untouched", normalizeBossProgressJson({ error: "nope" }), { error: "nope" });
check("error body has no event identity", hasBossEventIdentity(normalizeBossProgressJson({ error: "nope" })), false);
check("error body is not active", isBossEventActive(normalizeBossProgressJson({ error: "nope" })), false);
check("empty object is not active", isBossEventActive(normalizeBossProgressJson({})), false);
check("null passes through", normalizeBossProgressJson(null), null);
check("array passes through", normalizeBossProgressJson([1]), [1]);

// An unreadable event must NEVER look active: that fail-open was the root cause
// of the phantom reminder toasts fixed in v0.10.0.
check(
  "unreadable event is inactive even with no expiry",
  isBossEventActive(normalizeBossProgressJson({ xpBonus: 0.3 })),
  false
);
check(
  "readable event with no expiry fails OPEN to active",
  isBossEventActive(normalizeBossProgressJson({ event: { uuid: "x" } })),
  true
);
check(
  "expired event is inactive",
  isBossEventActive(normalizeBossProgressJson({ event: { uuid: "x", expiresAt: "2020-01-01T00:00:00Z" } })),
  false
);

// --- real capture fixtures (skipped when reference_data is absent) ----------

let fixturesRun = 0;
function runFixture(label, json, expected) {
  fixturesRun += 1;
  const n = normalizeBossProgressJson(json);
  const rewards = getBossRewards(n);
  check(`${label}: event identity readable`, hasBossEventIdentity(n), true);
  check(`${label}: Event.UUID`, n.Event.UUID, expected.uuid);
  check(`${label}: XPBonus is a number`, typeof n.XPBonus, "number");
  check(`${label}: HealthPoints`, n.Event.HealthPoints, expected.hp);
  check(`${label}: rewards sorted and readable`, rewards.length, expected.rewards);
  check(`${label}: thresholds ascending`, rewards.map((r) => r.XPThreshold), expected.thresholds);
  // Depends on IsUnlocked surviving normalization — the reward booleans are the
  // easiest thing to lose to a casing flip, and losing them is only visible as
  // a stale "to next chest" number.
  check(`${label}: next chest threshold`, getNextChestAt(rewards), expected.nextChestAt);
  check(`${label}: active`, isBossEventActive(n), expected.active);
}

const liveUrl = new URL("boss_events_progress.json", CAPTURES);
if (existsSync(liveUrl)) {
  runFixture("live PascalCase capture 2026-06-26", JSON.parse(readFileSync(liveUrl, "utf8")), {
    uuid: "dcfcb7af-184b-4e81-a176-0bd95f21afee",
    hp: 120000000,
    rewards: 4,
    thresholds: [30000000, 60000000, 90000000, 120000000],
    nextChestAt: 60000000, // the first chest with IsUnlocked false
    active: false, // ExpiresAt 2026-06-29 is in the past now
  });
}
const betweenUrl = new URL("boss_events_progress_between_events.json", CAPTURES);
if (existsSync(betweenUrl)) {
  runFixture("between-events camelCase capture 2026-07-16", JSON.parse(readFileSync(betweenUrl, "utf8")), {
    uuid: "dcfcb7af-184b-4e81-a176-0bd95f21afee",
    hp: 120000000,
    rewards: 4,
    thresholds: [30000000, 60000000, 90000000, 120000000],
    nextChestAt: 120000000, // three unlocked by the time the event ended
    active: false,
  });
}
if (existsSync(AUDIT_BODIES)) {
  const bodies = JSON.parse(readFileSync(AUDIT_BODIES, "utf8"))?.bodies;
  if (bodies?.boss) {
    runFixture("audit camelCase capture 2026-07-31", bodies.boss, {
      uuid: "dcfcb7af-184b-4e81-a176-0bd95f21afee",
      hp: 120000000,
      rewards: 4,
      thresholds: [30000000, 60000000, 90000000, 120000000],
      nextChestAt: 120000000,
      active: false,
    });
  }
}
if (!fixturesRun) {
  console.log("note: reference_data fixtures not present; skipped capture checks");
}

// -----------------------------------------------------------------------------

if (failures) {
  console.error(`\n${failures}/${checks} checks FAILED`);
  process.exit(1);
}
console.log(`ok — ${checks} checks passed${fixturesRun ? ` (incl. ${fixturesRun} capture fixtures)` : ""}`);
