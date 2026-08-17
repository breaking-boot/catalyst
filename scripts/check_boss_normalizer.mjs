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

import { readFileSync, existsSync, readdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import vm from "node:vm";

const BOSS = new URL("../bootdev-extension/src/boss.js", import.meta.url);
const UTILS = new URL("../bootdev-extension/src/utils.js", import.meta.url);
const CAPTURES = new URL("../reference_data/http_responses_from_api_endpoints/", import.meta.url);
const AUDIT_BODIES = new URL(
  "../reference_data/catalyst_versions/v0.12.2_api_casing_audit/api/responses/api_bodies_v3_2026-07-31.json",
  import.meta.url
);
// The v0.14.0 captures are named <account>_<label>_<timestamp>.json by probe
// 01d, so they are located by PREFIX — the timestamp is evidence, not an API
// contract, and a re-filed capture must not break the checks.
const REDESIGN_BODIES = new URL(
  "../reference_data/catalyst_versions/v0.14.0_boss_event_redesign/api/responses/",
  import.meta.url
);
function loadProbeBody(prefix) {
  try {
    const names = readdirSync(REDESIGN_BODIES)
      .filter((n) => n.startsWith(prefix) && n.endsWith(".json"))
      .sort();
    if (!names.length) return null;
    // Probe 01d wraps the response under `json`, alongside account/label/etc.
    return JSON.parse(readFileSync(new URL(names[names.length - 1], REDESIGN_BODIES), "utf8"))?.json ?? null;
  } catch (_) {
    return null;
  }
}

// --- evaluate boss.js in a sandbox ------------------------------------------

// pickField lives in utils.js as of v0.13.1 (nextLesson.js is its second
// consumer). Evaluate the REAL utils.js in its own context and lift the
// function across, so these checks still exercise shipped code rather than a
// stand-in. utils.js touches chrome.* only inside function bodies, so it loads
// cleanly here.
const utilsSandbox = { console, window: {}, document: {}, chrome: {} };
vm.createContext(utilsSandbox);
vm.runInContext(readFileSync(UTILS, "utf8"), utilsSandbox, { filename: fileURLToPath(UTILS) });

const testHook = {};
const sandbox = {
  window: { __BOOTDEV_ENHANCER_TEST__: testHook },
  document: { addEventListener() {}, removeEventListener() {}, getElementById: () => null },
  location: { pathname: "/" },
  console,
  // boss.js resolves the panel texture at load (BOSS_TEXTURE_URL).
  chrome: { runtime: { getURL: (path) => `chrome-extension://catalyst-test/${path}` } },
  // Lifted from the REAL utils.js, not stubbed: the render checks assert on
  // formatted output ("2,689 / 10,000 XP") and on escaping, and an identity
  // stub for escapeHtml would have made the XSS check pass vacuously.
  pickField: utilsSandbox.pickField,
  escapeHtml: utilsSandbox.escapeHtml,
  fmtNum: utilsSandbox.fmtNum,
  fmtPct: utilsSandbox.fmtPct,
  num: utilsSandbox.num,
  pct: utilsSandbox.pct,
  clamp: utilsSandbox.clamp,
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
   function warnOnce(){}
   function reportUsableFields(){return null;}
   let enhancerStopped = false;`,
  sandbox
);
vm.runInContext(readFileSync(BOSS, "utf8"), sandbox, { filename: fileURLToPath(BOSS) });

const boss = testHook.boss;
if (!boss) {
  console.error("FAIL: boss.js did not expose test hooks");
  process.exit(1);
}
const {
  pickField,
  normalizeBossProgressJson,
  hasBossEventIdentity,
  isBossEventActive,
  getPersonalChestState,
  selectBossGuild,
  migrateBossState,
  renderPersonalFight,
  renderGuildFight,
  updateAuraStats,
  auraMean,
  chooseAuraAlert,
} = boss;

// Builds the same state handleBossProgress would write, so the render checks
// run against real captures rather than hand-made state.
function stateFromCapture(body, pinnedGuildId = null) {
  const n = normalizeBossProgressJson(body);
  const chests = getPersonalChestState(n);
  const picked = selectBossGuild(n.Guilds, pinnedGuildId);
  return {
    xpUser: chests?.xpUser ?? null,
    personalTarget: chests?.target ?? null,
    chestsEarned: chests?.earned ?? null,
    chestTotal: chests?.total ?? null,
    nextThreshold: chests?.nextThreshold ?? null,
    nextTier: chests?.nextTier ?? null,
    guild: picked.guild,
    guildRewardGranted: n.GuildRewardGranted ?? null,
    pinnedGuildId: picked.pinnedGuildId,
  };
}
const has = (html, text) => String(html).includes(text);

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

// --- the 2026-08-14 event redesign: guilds ----------------------------------
// guilds[] and guildRewardGranted arrived in this same response. They are read
// per field like everything else, so a casing flip on the guild DTO alone (the
// way /v1/challenges/search flipped in v0.12.1) cannot silently empty the block.

const guildCamel = normalizeBossProgressJson({
  event: { uuid: "g1", expiresAt: "2099-01-01T00:00:00Z" },
  xpBonus: 0.3,
  xpUser: 3045,
  rewards: [{ userXPThreshold: 2500 }],
  guilds: [
    {
      guildUUID: "u1", name: "Byte Club", handle: "byteclub",
      memberCount: 2, contributorCount: 2, xp: 263032, xpThreshold: 20000, isCompleted: true,
    },
  ],
  guildRewardGranted: true,
});
check("guilds: camelCase guildUUID", guildCamel.Guilds[0].GuildUUID, "u1");
check("guilds: camelCase memberCount", guildCamel.Guilds[0].MemberCount, 2);
check("guilds: camelCase contributorCount", guildCamel.Guilds[0].ContributorCount, 2);
check("guilds: camelCase xp", guildCamel.Guilds[0].XP, 263032);
check("guilds: camelCase xpThreshold", guildCamel.Guilds[0].XPThreshold, 20000);
check("guilds: camelCase isCompleted", guildCamel.Guilds[0].IsCompleted, true);
check("guilds: camelCase guildRewardGranted", guildCamel.GuildRewardGranted, true);

// A MIXED response — PascalCase Event beside camelCase guilds — is the shape
// that would slip past a whole-response casing gate.
const guildMixed = normalizeBossProgressJson({
  Event: { UUID: "g2", ExpiresAt: "2099-01-01T00:00:00Z" },
  XPUser: 100,
  Rewards: [{ UserXPThreshold: 2500 }],
  guilds: [{ guildUUID: "u2", name: "Mixed", memberCount: 2, contributorCount: 0, xp: 0, xpThreshold: 20000, isCompleted: false }],
  guildRewardGranted: false,
});
check("guilds: mixed response still maps the guild entry", guildMixed.Guilds[0].XPThreshold, 20000);
check("guilds: mixed response maps a false isCompleted", guildMixed.Guilds[0].IsCompleted, false);
check("guilds: mixed response maps a false guildRewardGranted", guildMixed.GuildRewardGranted, false);

// A response with no guilds key must not grow one — a user in no guild is
// normal, and an invented empty array would look like a rename.
const noGuilds = normalizeBossProgressJson({ event: { uuid: "g3" }, xpBonus: 0.1 });
check("guilds: absent key stays absent", Array.isArray(noGuilds.Guilds), false);

// --- personal chest ladder ---------------------------------------------------

const ladder = (xpUser, thresholds = [2500, 5000, 7500, 10000]) =>
  getPersonalChestState(
    normalizeBossProgressJson({
      event: { uuid: "p", healthPoints: 10000 },
      xpUser,
      rewards: thresholds.map((t) => ({ userXPThreshold: t, xpThreshold: t })),
    })
  );

check("ladder: zero progress earns nothing", ladder(0).earned, 0);
check("ladder: zero progress points at the first chest", ladder(0).nextTier, "Common");
check("ladder: exactly on a threshold counts as earned", ladder(2500).earned, 1);
check("ladder: exactly on a threshold advances the next tier", ladder(2500).nextTier, "Uncommon");
check("ladder: between thresholds", ladder(2689).earned, 1);
check("ladder: remaining XP to the next chest", ladder(2689).remaining, 2311);
check("ladder: target is the top of the ladder", ladder(2689).target, 10000);
check("ladder: not defeated mid-ladder", ladder(2689).defeated, false);
check("ladder: every chest earned", ladder(253180).earned, 4);
check("ladder: defeated at the top", ladder(253180).defeated, true);
check("ladder: no next chest at the top", ladder(253180).nextThreshold, null);
check("ladder: remaining is 0 at the top", ladder(253180).remaining, 0);
// Ladder unreadable -> fall back to Event.HealthPoints for the target only.
check(
  "ladder: unreadable thresholds fall back to HealthPoints",
  getPersonalChestState(normalizeBossProgressJson({ event: { uuid: "p", healthPoints: 10000 }, xpUser: 500, rewards: [] }))?.target,
  10000
);
// XPUser ABSENT (not 0) yields no personal state at all: a rename must hide the
// block, never render a confident 0. pickField preserves a legitimate 0.
check(
  "ladder: absent XPUser yields no state",
  getPersonalChestState(normalizeBossProgressJson({ event: { uuid: "p" }, rewards: [{ userXPThreshold: 2500 }] })),
  null
);
check("ladder: a legitimate 0 still yields state", ladder(0).xpUser, 0);

// --- guild selection and the per-event pin -----------------------------------

const G = (uuid, over = {}) => ({
  GuildUUID: uuid, Name: uuid, MemberCount: 2, ContributorCount: 2,
  XP: 0, XPThreshold: 20000, IsCompleted: false, ...over,
});

check("guild: no guilds selects nothing", selectBossGuild([]).guild, null);
check("guild: no guilds clears any pin", selectBossGuild([], "gone").pinnedGuildId, null);
check("guild: a non-array is handled", selectBossGuild(undefined).guild, null);

const race = [G("a", { XP: 5000 }), G("b", { XP: 12000 })];
check("guild: closest to completing wins", selectBossGuild(race).guild.name, "b");
check("guild: a live 'closest' pick is NOT pinned", selectBossGuild(race).pinnedGuildId, null);

const oneDone = [G("a", { XP: 5000 }), G("b", { XP: 21000, IsCompleted: true })];
check("guild: a completed guild wins", selectBossGuild(oneDone).guild.name, "b");
check("guild: a completed guild is pinned", selectBossGuild(oneDone).pinnedGuildId, "b");

// The whole point of the pin: a second guild completing later must not move the
// display off the one the user already saw.
const bothDone = [G("a", { XP: 30000, IsCompleted: true }), G("b", { XP: 21000, IsCompleted: true })];
check("guild: the pin survives a second completion", selectBossGuild(bothDone, "b").guild.name, "b");
check("guild: the pin is kept as-is", selectBossGuild(bothDone, "b").pinnedGuildId, "b");
// Deterministic first choice when two are already complete at first sight.
check("guild: two completed at once -> most XP", selectBossGuild(bothDone).guild.name, "a");
check("guild: ties break by UUID", selectBossGuild([G("b", { IsCompleted: true }), G("a", { IsCompleted: true })]).guild.name, "a");

// A pin naming a guild that is gone (the user left it) falls back to the rule.
check("guild: a stale pin falls back to the rule", selectBossGuild(race, "gone").guild.name, "b");
check("guild: a stale pin is cleared", selectBossGuild(race, "gone").pinnedGuildId, null);

// Eligibility: a 1-member guild is ineligible and loses to any eligible guild,
// but is still shown (without a bar) when it is all the user has.
const mixedEligibility = [G("solo", { MemberCount: 1, XPThreshold: 20000 }), G("pair", { XP: 100 })];
check("guild: an eligible guild beats an ineligible one", selectBossGuild(mixedEligibility).guild.name, "pair");
check("guild: an ineligible guild is still selectable alone", selectBossGuild([G("solo", { MemberCount: 1 })]).guild.name, "solo");
check("guild: ineligible is flagged", selectBossGuild([G("solo", { MemberCount: 1 })]).guild.eligible, false);
// Guild XP is suppressed until two members qualify — the panel needs to say so.
check("guild: xpPending below 2 qualified", selectBossGuild([G("x", { ContributorCount: 1 })]).guild.xpPending, true);
check("guild: not pending at 2 qualified", selectBossGuild([G("x", { ContributorCount: 2 })]).guild.xpPending, false);
// An unreadable threshold must not win "closest to completing" by default.
check(
  "guild: an unreadable threshold sorts last",
  selectBossGuild([G("broken", { XPThreshold: undefined }), G("ok", { XP: 1 })]).guild.name,
  "ok"
);

// --- migrating a stored record to the v0.14.0 shape --------------------------
// A v0.13.1 record carries damage/bossMaxHp/nextChestAt from the community
// model — one real example read "82,949,113 damage" against a 10,000 HP boss
// once healthPoints changed meaning. The aura history must survive; the rest
// must not be reinterpreted.

const legacy = migrateBossState({
  eventId: "old-event",
  current: 32,
  eventHigh: 66.15,
  eventHighAt: 1755043790000,
  allTimeHigh: 66.15,
  damage: 82949113,
  bossMaxHp: 10000,
  nextChestAt: 2500,
  lastChestTier: "Mythic",
  nextChestTier: null,
  notifiedHigh: 66.15,
  updatedAt: 1755043790000,
});
check("migrate: eventId survives", legacy.eventId, "old-event");
check("migrate: aura history survives", [legacy.current, legacy.eventHigh, legacy.allTimeHigh], [32, 66.15, 66.15]);
check("migrate: eventHighAt survives", legacy.eventHighAt, 1755043790000);
check("migrate: community damage is dropped", legacy.damage, undefined);
check("migrate: bossMaxHp is dropped", legacy.bossMaxHp, undefined);
check("migrate: nextChestAt is dropped", legacy.nextChestAt, undefined);
check("migrate: lastChestTier is dropped", legacy.lastChestTier, undefined);
// A record from before v0.14.0 cannot say when its observation window began,
// and claiming one starting now would misrepresent the recorded high.
check("migrate: observedSince stays unknown", legacy.observedSince, null);
check("migrate: personal fields start empty", [legacy.xpUser, legacy.chestsEarned], [null, null]);
check("migrate: guild fields start empty", [legacy.guild, legacy.pinnedGuildId], [null, null]);
check("migrate: nothing stored yields nothing", migrateBossState(null), null);
check("migrate: an all-time high below the event high is corrected",
  migrateBossState({ eventId: "e", eventHigh: 80, allTimeHigh: 10 }).allTimeHigh, 80);

const current = migrateBossState({
  eventId: "new-event",
  observedSince: 1755300000000,
  eventHigh: 71,
  allTimeHigh: 100,
  xpUser: 2689,
  chestsEarned: 1,
  nextTier: "Uncommon",
  pinnedGuildId: "a838d70b",
  guild: { name: "Byte Club", xp: 263032 },
  guildRewardGranted: true,
});
check("migrate: a v0.14.0 record keeps its window", current.observedSince, 1755300000000);
check("migrate: it keeps personal progress", [current.xpUser, current.chestsEarned, current.nextTier], [2689, 1, "Uncommon"]);
check("migrate: it keeps the guild pin", current.pinnedGuildId, "a838d70b");
check("migrate: it keeps the selected guild", current.guild.name, "Byte Club");
check("migrate: it keeps the reward flag", current.guildRewardGranted, true);

// --- aura statistics ---------------------------------------------------------
// A TIME-weighted mean over OBSERVED time. Both halves matter: the aura is a
// step function held for unequal durations, and Catalyst does not watch
// continuously.

const MIN = 60_000;
// Production cadence: BOSS_REFRESH_MS is 2 minutes, comfortably under the
// 5-minute per-interval cap, so a watched stretch accumulates in full.
function feedEvery(gapMin, values) {
  let stats = null;
  let t = 0;
  for (const value of values) {
    stats = updateAuraStats(stats, value, t);
    t += gapMin * MIN;
  }
  return stats;
}
const repeat = (value, n) => Array.from({ length: n }, () => value);

// Each interval is attributed to the value that was LIVE across it.
const twoSamples = updateAuraStats(updateAuraStats(null, 30, 0), 90, 2 * MIN);
check("aura: the interval is credited to the value that was live", twoSamples.weightedSum, 30 * 2 * MIN);
check("aura: observed time is the interval", twoSamples.observedMs, 2 * MIN);

// Half an hour at 30% then half an hour at 60% averages ~45%, where a plain
// average of samples would depend on how often we happened to poll.
const weighted = feedEvery(2, [...repeat(30, 16), ...repeat(60, 15)]);
const weightedMean = auraMean(weighted);
check("aura: the mean is time-weighted", weightedMean > 43 && weightedMean < 46, true);

// Under the minimum observed window there is no honest average to show.
check("aura: no mean before 30 minutes observed", auraMean(feedEvery(2, repeat(30, 5))), null);
check("aura: no mean from nothing", auraMean(null), null);

// A three-day gap (browser closed, laptop asleep) must contribute a bounded
// slice, not three days at one value.
const gapped = updateAuraStats(updateAuraStats(null, 32, 0), 80, 3 * 24 * 60 * MIN);
check("aura: a long gap contributes at most the cap", gapped.observedMs, 5 * MIN);

// The changes list records steps only, and its cap cannot distort the mean.
const stepped = feedEvery(2, [30, 30.2, 45, 45]);
check("aura: sub-1-point moves are not logged", stepped.changes.length, 2);
check("aura: a logged change carries its value", stepped.changes[1][1], 45);
let capped = null;
for (let i = 0; i < 600; i++) capped = updateAuraStats(capped, i % 2 ? 30 : 60, i * 2 * MIN);
check("aura: the changes list is capped", capped.changes.length, 500);
const cappedMean = auraMean(capped);
check("aura: the mean survives the cap", cappedMean > 43 && cappedMean < 47, true);

// --- alert tiers -------------------------------------------------------------

const NOW = 1_000_000_000;
const alertAt = (over = {}) =>
  chooseAuraAlert({ current: 60, prevEventHigh: 50, prevAllTimeHigh: 80, mean: 30, floor: 50, alerts: null, now: NOW, ...over });

check("alert: a new event high fires", alertAt().tier, "high");
check("alert: a record outranks an event high", alertAt({ current: 90 }).tier, "record");
check("alert: a record is sticky", alertAt({ current: 90 }).durationMs, 0);
check("alert: near the event high", alertAt({ current: 51, prevEventHigh: 60 }).tier, "near");
check("alert: above the average", alertAt({ current: 55, prevEventHigh: 90, mean: 30 }).tier, "above");
check("alert: nothing below the floor", alertAt({ current: 40, prevEventHigh: 90, mean: 10 }), null);
check("alert: nothing without a change", alertAt({ alerts: { lastPct: 60 } }), null);
check("alert: no current value, no alert", alertAt({ current: null }), null);

// A fresh install has an all-time high of 0 and a brand-new event has an event
// high of 0 — without these guards every early sample would be a "record".
check("alert: no record against a zero all-time high", alertAt({ current: 90, prevAllTimeHigh: 0 }).tier, "high");
check("alert: no event high against a zero event high", alertAt({ current: 20, prevEventHigh: 0, prevAllTimeHigh: 0, mean: null }), null);

// The increment guard: an opening surge climbing a fraction at a time must not
// announce each step as a new high. (It may still be "near the high" — that is
// a different, and quieter, tier with an hour's cooldown.)
check("alert: a fractional rise is not announced as a new high", alertAt({ current: 50.4 }).tier, "near");
check(
  "alert: and nothing at all when it is also below the floor",
  alertAt({ current: 40.4, prevEventHigh: 40, prevAllTimeHigh: 80, mean: null }),
  null
);

// Cooldowns, and the lower-tier suppression after a bigger one.
const justFired = { tierLastAt: { high: NOW - 60_000 }, lastTier: "high", lastAt: NOW - 60_000, lastPct: 55 };
check("alert: a tier respects its cooldown", alertAt({ alerts: justFired }), null);
check(
  "alert: it fires again after the cooldown",
  alertAt({ alerts: { ...justFired, tierLastAt: { high: NOW - 11 * 60_000 }, lastAt: NOW - 11 * 60_000 } }).tier,
  "high"
);
check(
  "alert: a lower tier stays quiet right after a higher one",
  alertAt({ current: 55, prevEventHigh: 90, mean: 30, alerts: { lastTier: "record", lastAt: NOW - 60_000, tierLastAt: {} } }),
  null
);
check(
  "alert: the floor is configurable",
  alertAt({ current: 45, prevEventHigh: 90, mean: 20, floor: 40 }).tier,
  "above"
);

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
  const thresholds = n.Rewards.map((r) => r.XPThreshold).sort((a, b) => a - b);
  check(`${label}: event identity readable`, hasBossEventIdentity(n), true);
  check(`${label}: Event.UUID`, n.Event.UUID, expected.uuid);
  check(`${label}: XPBonus is a number`, typeof n.XPBonus, "number");
  check(`${label}: HealthPoints`, n.Event.HealthPoints, expected.hp);
  check(`${label}: rewards readable`, n.Rewards.length, expected.rewards);
  check(`${label}: thresholds`, thresholds, expected.thresholds);
  // The reward booleans are the easiest thing to lose to a casing flip. Nothing
  // reads them any more (chest state comes from XPUser vs UserXPThreshold), but
  // losing them silently would still hide a schema change.
  check(
    `${label}: reward booleans survive normalization`,
    n.Rewards.every((r) => typeof r.IsUnlocked === "boolean"),
    true
  );
  check(`${label}: active`, isBossEventActive(n), expected.active);
}

const liveUrl = new URL("boss_events_progress.json", CAPTURES);
if (existsSync(liveUrl)) {
  runFixture("live PascalCase capture 2026-06-26", JSON.parse(readFileSync(liveUrl, "utf8")), {
    uuid: "dcfcb7af-184b-4e81-a176-0bd95f21afee",
    hp: 120000000,
    rewards: 4,
    thresholds: [30000000, 60000000, 90000000, 120000000],
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
        active: false,
    });
  }
}
// --- v0.14.0 redesign captures (probe 01d, 2026-08-16/17) --------------------
// These are the states that could only be produced during a live event, from
// accounts that had not yet crossed the thresholds. They pin the new model
// against real bodies rather than synthetic ones.

// A partially filled ladder: the ONE capture that proves IsUnlocked and
// IsUnlockedByUser flip per chest and agree, while the community XPTotal is
// above 100M. Catalyst ignores both flags — this asserts the computed state
// matches them anyway.
const oneChest = loadProbeBody("boss_progress_villainousrent97_dummy1_one_chest_");
if (oneChest) {
  fixturesRun += 1;
  const n = normalizeBossProgressJson(oneChest);
  const chests = getPersonalChestState(n);
  check("capture one_chest: xpUser", chests.xpUser, 2689);
  check("capture one_chest: one chest earned", chests.earned, 1);
  check("capture one_chest: next threshold", chests.nextThreshold, 5000);
  check("capture one_chest: next tier", chests.nextTier, "Uncommon");
  check("capture one_chest: target is the personal 10000", chests.target, 10000);
  check("capture one_chest: not defeated", chests.defeated, false);
  check(
    "capture one_chest: computed state matches the reward flags",
    n.Rewards.map((r) => r.IsUnlockedByUser),
    n.Rewards.map((r) => chests.xpUser >= Number(r.UserXPThreshold))
  );
  check("capture one_chest: IsUnlocked mirrors IsUnlockedByUser",
    n.Rewards.map((r) => r.IsUnlocked), n.Rewards.map((r) => r.IsUnlockedByUser));
  // Two eligible guilds, neither completed, neither yet counting XP.
  const picked = selectBossGuild(n.Guilds);
  check("capture one_chest: two guilds normalized", n.Guilds.length, 2);
  check("capture one_chest: nothing pinned with no completion", picked.pinnedGuildId, null);
  check("capture one_chest: selected guild is eligible", picked.guild.eligible, true);
  check("capture one_chest: guild XP is pending below 2 qualified", picked.guild.xpPending, true);
}

// The moment a second member qualified: guild XP goes 0 -> 6149 (3045 + 3104),
// still short of the 20000 goal. The mid-progress guild bar, which no earlier
// capture contained.
const midGuild = loadProbeBody("boss_progress_emotionalpost67_dummy2_qualified_2026-08-17T003347");
if (midGuild) {
  fixturesRun += 1;
  const n = normalizeBossProgressJson(midGuild);
  const picked = selectBossGuild(n.Guilds);
  check("capture mid_guild: xp", picked.guild.xp, 6149);
  check("capture mid_guild: threshold", picked.guild.xpThreshold, 20000);
  check("capture mid_guild: 2 of 2 qualified", [picked.guild.contributorCount, picked.guild.memberCount], [2, 2]);
  check("capture mid_guild: not completed", picked.guild.isCompleted, false);
  check("capture mid_guild: XP is no longer pending", picked.guild.xpPending, false);
  check("capture mid_guild: an incomplete guild is not pinned", picked.pinnedGuildId, null);
  check("capture mid_guild: guildRewardGranted still false", n.GuildRewardGranted, false);
}

// One body carrying a COMPLETED guild and a MID-PROGRESS one — the fixture the
// pin rule exists for.
const twoGuilds = loadProbeBody("boss_progress_villainousrent97_dummy1_two_qualified_");
if (twoGuilds) {
  fixturesRun += 1;
  const n = normalizeBossProgressJson(twoGuilds);
  const picked = selectBossGuild(n.Guilds);
  check("capture two_guilds: the completed guild is selected", picked.guild.name, "Byte Club");
  check("capture two_guilds: it is pinned", picked.pinnedGuildId, "a838d70b-450e-4b1c-9da3-9f0b3f32d878");
  check("capture two_guilds: completed", picked.guild.isCompleted, true);
  check("capture two_guilds: guildRewardGranted is true", n.GuildRewardGranted, true);
  // ...and the pin holds if the other guild completes later in the same event.
  const laterBothDone = n.Guilds.map((g) => ({ ...g, IsCompleted: true, XP: 999999 }));
  check(
    "capture two_guilds: the pin survives the other guild completing",
    selectBossGuild(laterBothDone, picked.pinnedGuildId).guild.name,
    "Byte Club"
  );
}

// --- what the panel actually renders from those captures ---------------------
// The blocks degrade to "show less" on a missing value, which is what makes a
// rename invisible; these assert the opposite direction — that a healthy
// capture produces the numbers, and that a missing one produces nothing rather
// than a confident zero or a NaN.

if (oneChest) {
  const s = stateFromCapture(oneChest);
  const personal = renderPersonalFight(s);
  check("render one_chest: chest count", has(personal, "1 of 4 chests"), true);
  check("render one_chest: XP against the personal target", has(personal, "2,689 / 10,000 XP"), true);
  check("render one_chest: names the next chest and the gap", has(personal, "Next: Uncommon Chest at 5,000 (2,311 to go)"), true);
  check("render one_chest: not claiming a defeat", has(personal, "Boss defeated"), false);
  check("render one_chest: no NaN", /NaN/.test(personal), false);

  const guild = renderGuildFight(s);
  check("render one_chest: guild XP is explained, not just 0", has(guild, "Guild XP counts once 2 members qualify"), true);
  check("render one_chest: qualified count uses Boot.dev's wording", has(guild, "members qualified"), true);
}

if (midGuild) {
  const s = stateFromCapture(midGuild);
  const guild = renderGuildFight(s);
  check("render mid_guild: guild name", has(guild, "DumbAndDumber"), true);
  check("render mid_guild: 2 of 2 qualified", has(guild, "2 of 2 members qualified"), true);
  check("render mid_guild: XP against the guild goal", has(guild, "6,149 / 20,000 XP"), true);
  check("render mid_guild: the pending note is gone at 2 qualified", has(guild, "counts once"), false);
  check("render mid_guild: not claiming the reward", has(guild, "Reward earned"), false);
}

if (twoGuilds) {
  const s = stateFromCapture(twoGuilds);
  const guild = renderGuildFight(s);
  check("render two_guilds: the completed guild is the one drawn", has(guild, "Byte Club"), true);
  check("render two_guilds: reward chip", has(guild, "Reward earned"), true);
  check("render two_guilds: its XP", has(guild, "263,032 / 20,000 XP"), true);
}

// The live 2026-08-14 capture is the all-chests-earned case.
if (existsSync(new URL("boss_events_progress_live_2026-08-14.json", CAPTURES))) {
  const s = stateFromCapture(JSON.parse(readFileSync(new URL("boss_events_progress_live_2026-08-14.json", CAPTURES), "utf8")));
  const personal = renderPersonalFight(s);
  check("render complete: says the boss is defeated", has(personal, "Boss defeated · Mythic chest earned"), true);
  check("render complete: no permanently-full bar", has(personal, "progressbar"), false);
  check("render complete: still shows the XP", has(personal, "Your event XP 253,180"), true);
}

// Degradation: nothing readable renders nothing at all.
check("render: no xpUser renders no personal block", renderPersonalFight({ xpUser: null }), "");
check("render: no guild renders no guild block", renderGuildFight({ guild: null }), "");
check(
  "render: an ineligible guild gets no bar",
  has(renderGuildFight({ guild: { name: "Solo", memberCount: 1, eligible: false } }), "progressbar"),
  false
);
check(
  "render: an ineligible guild explains itself",
  has(renderGuildFight({ guild: { name: "Solo", memberCount: 1, eligible: false } }), "Guilds need at least 2 members"),
  true
);
// A guild name is Boot.dev-supplied text and must never be interpolated raw.
check(
  "render: guild names are escaped",
  has(renderGuildFight({ guild: { name: "<img src=x>", memberCount: 2, eligible: true, contributorCount: 2, xp: 1, xpThreshold: 2 } }), "<img src=x>"),
  false
);

if (!fixturesRun) {
  console.log("note: reference_data fixtures not present; skipped capture checks");
}

// -----------------------------------------------------------------------------

if (failures) {
  console.error(`\n${failures}/${checks} checks FAILED`);
  process.exit(1);
}
console.log(`ok — ${checks} checks passed${fixturesRun ? ` (incl. ${fixturesRun} capture fixtures)` : ""}`);
