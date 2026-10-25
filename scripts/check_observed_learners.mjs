#!/usr/bin/env node
// Checks for the observed-learner list format (bootdev-extension/src/
// observed-learners.js), evaluated in a vm sandbox and reached through the
// __BOOTDEV_ENHANCER_TEST__ hook.
//
// Run from anywhere:  node scripts/check_observed_learners.mjs
//
// One format serves four jobs — the bundled seed, the options page's
// export/import, the observedLearners section of a backup, and the opt-in fetch
// of the published list — and each is read by a copy of Catalyst that did not
// write it. What must hold:
//
//   1. A file that is not this format and version is refused whole; a bad row
//      is skipped and the rest are kept.
//   2. A list carries handles, XP and read times only. Nothing else is written,
//      and nothing else is read.
//   3. Folding a list in follows "newest reading wins", so an old list can never
//      overwrite a fresher local reading.
//   4. The bundled seed and data/observed-learners.json hold the same list.
//   5. A backup carries the observed learners, so moving to another browser
//      takes one export and one import. Importing one reaches open Boot.dev
//      tabs, an older backup without the section leaves the roster alone, and
//      a bad section never blocks the rest of the backup.

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import vm from "node:vm";

const MODULE = new URL("../bootdev-extension/src/observed-learners.js", import.meta.url);
const SEED_FILE = new URL("../bootdev-extension/src/alltime-seed.js", import.meta.url);
const DATA_FILE = new URL("../data/observed-learners.json", import.meta.url);
const BACKUP = new URL("../bootdev-extension/src/backup.js", import.meta.url);
const SRC = new URL("../bootdev-extension/src/", import.meta.url);

const hook = {};
const sandbox = { window: { __BOOTDEV_ENHANCER_TEST__: hook }, console };
vm.createContext(sandbox);
vm.runInContext(readFileSync(MODULE, "utf8"), sandbox, { filename: fileURLToPath(MODULE) });
const L = hook.observedLearners;
if (!L) {
  console.error("FAIL: observed-learners.js did not expose test hooks");
  process.exit(1);
}
const { OBSERVED_LEARNERS_FORMAT: FORMAT, OBSERVED_LEARNERS_VERSION: VERSION } = L.constants;

let failures = 0;
function check(name, condition, detail = "") {
  if (condition) return;
  failures += 1;
  console.error(`FAIL: ${name}${detail ? ` — ${detail}` : ""}`);
}
function eq(name, actual, expected) {
  check(name, JSON.stringify(actual) === JSON.stringify(expected),
    `expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`);
}

const NOW = Date.parse("2026-10-04T12:00:00Z");
const HOUR = 60 * 60 * 1000;
const iso = (ms) => new Date(ms).toISOString();
const list = (learners, extra = {}) => ({ format: FORMAT, version: VERSION, generatedAt: iso(NOW), learners, ...extra });

// --- 1. file-level strict ------------------------------------------------------

check("non-JSON text is refused", Boolean(L.parseObservedLearners("not json", NOW).error));
check("empty text is refused", Boolean(L.parseObservedLearners("  ", NOW).error));
check("another format is refused", Boolean(L.parseObservedLearners({ ...list([]), format: "catalystExport" }, NOW).error));
check("a backup file is refused", Boolean(L.parseObservedLearners({ catalystExport: true, formatVersion: 1, data: {} }, NOW).error));
check("a missing version is refused", Boolean(L.parseObservedLearners({ format: FORMAT, learners: [] }, NOW).error));
check("a newer version is refused, not guessed at",
  /Update Catalyst/.test(L.parseObservedLearners(list([], { version: VERSION + 1 }), NOW).error || ""));
check("a list without learners is refused", Boolean(L.parseObservedLearners({ format: FORMAT, version: VERSION }, NOW).error));
check("an empty list is accepted", !L.parseObservedLearners(list([]), NOW).error);

// --- 2. entry-level lenient ------------------------------------------------------

{
  const parsed = L.parseObservedLearners(list([
    { handle: "good", xp: 100, at: iso(NOW - HOUR) },
    { handle: "bad handle!", xp: 100, at: iso(NOW) },
    { handle: "noxp", at: iso(NOW) },
    { handle: "nullxp", xp: null, at: iso(NOW) },
    { handle: "negative", xp: -5, at: iso(NOW) },
    { handle: "noat", xp: 5 },
    { handle: "future", xp: 5, at: iso(NOW + 2 * HOUR) },
    { handle: "@Mixed-Case", xp: 7.4, at: iso(NOW) },
  ]), NOW);
  eq("only well-formed rows survive", parsed.learners.map((l) => l.handle), ["good", "mixed-case"]);
  eq("and the rest are counted as skipped", parsed.skipped, 6);
  check("a missing XP is never read as zero", !parsed.learners.some((l) => l.handle === "nullxp"));
  eq("XP is stored as a whole number", parsed.learners.find((l) => l.handle === "mixed-case").xp, 7);
  eq("read times come back as milliseconds", parsed.learners[0].at, NOW - HOUR);
}

{
  const parsed = L.parseObservedLearners(list([
    { handle: "dup", xp: 100, at: iso(NOW - HOUR) },
    { handle: "dup", xp: 90, at: iso(NOW) },
    { handle: "dup", xp: 80, at: iso(NOW - 2 * HOUR) },
  ]), NOW);
  eq("a repeated handle keeps its newest reading", parsed.learners, [{ handle: "dup", xp: 90, at: NOW }]);
}

{
  const parsed = L.parseObservedLearners(list([
    { handle: "b", xp: 5, at: iso(NOW) },
    { handle: "a", xp: 5, at: iso(NOW) },
    { handle: "c", xp: 9, at: iso(NOW) },
  ]), NOW);
  eq("readers sort for themselves, XP then handle", parsed.learners.map((l) => l.handle), ["c", "a", "b"]);
}

{
  const many = Array.from({ length: 300 }, (_, i) => ({ handle: `u${i}`, xp: i, at: iso(NOW) }));
  const parsed = L.parseObservedLearners(list(many), NOW);
  eq("a reader keeps at most its read maximum", parsed.learners.length, L.constants.OBSERVED_LEARNERS_READ_MAX);
  eq("and keeps the highest XP", parsed.learners[0].handle, "u299");
}

// --- 3. writing -------------------------------------------------------------------

{
  const rows = Array.from({ length: 130 }, (_, i) => ({ handle: `u${i}`, xp: 1000 + i, at: NOW - i }));
  const built = L.buildObservedLearners(rows, NOW);
  eq("a written list is capped", built.learners.length, L.constants.OBSERVED_LEARNERS_MAX);
  eq("highest XP first", built.learners[0].handle, "u129");
  check("each row is handle, xp and an ISO read time, nothing else", built.learners.every((l) =>
    JSON.stringify(Object.keys(l)) === JSON.stringify(["handle", "xp", "at"]) && !Number.isNaN(Date.parse(l.at))));
  eq("the header names the format", [built.format, built.version], [FORMAT, VERSION]);

  const text = L.stringifyObservedLearners(built);
  eq("the one-row-per-line text is the same JSON", JSON.parse(text), JSON.parse(JSON.stringify(built)));
  const back = L.parseObservedLearners(text, NOW);
  eq("a written list reads back unchanged", back.learners, built.learners.map((l) => ({ ...l, at: Date.parse(l.at) })));
}

{
  const roster = {
    entries: {
      kat: { Handle: "Kat", XP: 500, profileAt: NOW, FirstName: "Katharina", ProfileImageURL: "x.png", Level: 200, Role: "Archmage" },
      unread: { Handle: "unread", XP: 400, profileAt: 0 },
      noxp: { Handle: "noxp", XP: null, profileAt: NOW },
    },
  };
  const out = L.rosterToObservedLearners(roster);
  eq("a roster exports handle, XP and read time only", out, [{ handle: "kat", xp: 500, at: NOW }]);
}

// --- 4. merging into a roster ---------------------------------------------------------

{
  const roster = {
    entries: {
      fresh: { Handle: "fresh", XP: 300, profileAt: NOW, FirstName: "F" },
      stale: { Handle: "stale", XP: 100, profileAt: NOW - 10 * HOUR, FirstName: "S", ProfileImageURL: "s.png" },
    },
  };
  const learners = [
    { handle: "fresh", xp: 250, at: NOW - HOUR },
    { handle: "stale", xp: 150, at: NOW - HOUR },
    { handle: "new", xp: 50, at: NOW - HOUR },
  ];
  const result = L.mergeObservedLearnersIntoRoster(roster, learners, { source: "shared" });
  eq("an older list never lowers a fresher reading", roster.entries.fresh.XP, 300);
  eq("a newer list reading replaces a stale one", roster.entries.stale.XP, 150);
  eq("and leaves its display fields alone", [roster.entries.stale.FirstName, roster.entries.stale.ProfileImageURL], ["S", "s.png"]);
  eq("a new handle arrives with XP and read time", [roster.entries.new.XP, roster.entries.new.profileAt], [50, NOW - HOUR]);
  eq("added and updated are reported", [result.added, result.updated], [["new"], ["stale"]]);

  const withBlank = { entries: {} };
  L.mergeObservedLearnersIntoRoster(withBlank, learners, { blank: (h) => ({ Handle: h, FirstName: "", Level: null }) });
  eq("the caller's blank entry shape is used", withBlank.entries.new.FirstName, "");
}

{
  const roster = { entries: {} };
  for (let i = 0; i < 12; i++) roster.entries[`u${i}`] = { XP: i * 10 };
  roster.entries.unknown = { XP: null };
  const removed = L.trimObservedRoster(roster, 10);
  eq("trimming keeps the highest XP", Object.keys(roster.entries).length, 10);
  check("an entry with no XP goes first", removed.includes("unknown"));
  check("the lowest XP goes next", removed.includes("u0") && removed.includes("u1") && !removed.includes("u2"));
}

{
  const roster = { entries: {} };
  for (let i = 0; i < 100; i++) roster.entries[`have${i}`] = { XP: 1000 + i, profileAt: NOW - HOUR };
  const learners = [
    { handle: "climber", xp: 5000, at: NOW },
    { handle: "low", xp: 1, at: NOW },
    { handle: "have5", xp: 2000, at: NOW },
  ];
  const before = JSON.stringify(roster);
  const preview = L.previewObservedLearnersImport(roster, learners);
  eq("a preview does not touch the roster", JSON.stringify(roster), before);
  eq("a preview counts what would change", preview, { listed: 3, added: 2, kept: 1, updated: 1 });
}

{
  // The options page's import, against the roster exactly as storage holds it.
  const stored = {
    version: 1, xpCursor: 4, beWriter: "tab-123", self: { percentile: 1 },
    entries: { kept: { Handle: "kept", XP: 900, profileAt: NOW - HOUR, FirstName: "K" } },
  };
  const { roster, kept, updated } = L.importObservedLearnersIntoStoredRoster(stored,
    [{ handle: "kept", xp: 950, at: NOW }, { handle: "fresh", xp: 10, at: NOW }], NOW);
  check("the last writer's stamp is removed, so that tab adopts the import", !("beWriter" in roster));
  eq("the rest of the stored roster is carried over", [roster.xpCursor, roster.self.percentile], [4, 1]);
  eq("and the import is applied", [roster.entries.kept.XP, roster.entries.kept.FirstName, roster.entries.fresh.XP], [950, "K", 10]);
  eq("added and updated are counted", [kept, updated], [1, 1]);
  eq("the stored object itself is untouched", [stored.entries.kept.XP, stored.beWriter], [900, "tab-123"]);
  eq("nothing stored yet still imports", L.importObservedLearnersIntoStoredRoster(undefined,
    [{ handle: "a", xp: 1, at: NOW }], NOW).kept, 1);
}

// --- 5. the shipped files ---------------------------------------------------------------

{
  const seedSandbox = {};
  vm.createContext(seedSandbox);
  vm.runInContext(`${readFileSync(SEED_FILE, "utf8")}\nthis.SEED = ALLTIME_SEED;`, seedSandbox);
  const data = JSON.parse(readFileSync(DATA_FILE, "utf8"));
  eq("the bundled seed and data/observed-learners.json hold the same list",
    JSON.parse(JSON.stringify(seedSandbox.SEED)), data);
  const parsed = L.parseObservedLearners(data, Date.now());
  check("the published list is one the extension accepts", !parsed.error, parsed.error);
  eq("with no malformed rows", parsed.skipped, 0);
  check("and nothing but handle, xp and at per row",
    data.learners.every((l) => JSON.stringify(Object.keys(l)) === JSON.stringify(["handle", "xp", "at"])));
  eq("its header carries nothing but the format fields",
    Object.keys(data).sort(), ["format", "generatedAt", "learners", "version"]);
}

// --- 6. backups carry the observed learners ---------------------------------------------

{
  // backup.js and observed-learners.js as options.html loads them, against a
  // stubbed chrome.storage.
  const store = { sync: {}, local: {} };
  const area = (name) => ({
    get: (key, cb) => cb({ [key]: store[name][key] === undefined ? undefined : JSON.parse(JSON.stringify(store[name][key])) }),
    set: (obj, cb) => { Object.assign(store[name], JSON.parse(JSON.stringify(obj))); cb && cb(); },
  });
  const pageSandbox = {
    console,
    chrome: { runtime: { lastError: undefined, getManifest: () => ({ version: "0.16.0" }) }, storage: { sync: area("sync"), local: area("local") } },
  };
  vm.createContext(pageSandbox);
  for (const url of [MODULE, BACKUP]) {
    vm.runInContext(readFileSync(url, "utf8"), pageSandbox, { filename: fileURLToPath(url) });
  }
  const run = (code) => vm.runInContext(code, pageSandbox);
  const T = Date.now();

  store.local.be_alltime_roster = {
    version: 1, beWriter: "tab-1",
    entries: {
      kat: { Handle: "kat", XP: 2000000, profileAt: T - HOUR, FirstName: "Katharina", ProfileImageURL: "k.png" },
      dan: { Handle: "dan", XP: 1200000, profileAt: T - 2 * HOUR },
      unread: { Handle: "unread", XP: null, profileAt: T },
    },
  };
  const exported = await run("collectBackupData()");
  const section = exported.data.observedLearners;
  eq("a backup carries the observed learners in the list format",
    [section?.format, section?.version, section?.learners?.map((l) => l.handle)], [FORMAT, VERSION, ["kat", "dan"]]);
  check("with handle, XP and read time only", section.learners.every((l) =>
    JSON.stringify(Object.keys(l)) === JSON.stringify(["handle", "xp", "at"])));
  check("and the summary names it", run(`summarizeBackup(${JSON.stringify(exported.data)})`)
    .some((line) => line.startsWith("Top Observed Learners — 2 learners")));

  // Restore on another browser that already knows a fresher kat and a stranger.
  store.local = {
    be_alltime_roster: {
      version: 1, beWriter: "tab-2",
      entries: { kat: { Handle: "kat", XP: 2100000, profileAt: T, FirstName: "K" }, low: { Handle: "low", XP: 5, profileAt: T } },
    },
  };
  const results = await run(`applyBackup(${JSON.stringify(exported.data)})`);
  const roster = store.local.be_alltime_roster;
  check("the import reports the learners", results.includes("Top Observed Learners: 1 learner added, 0 updated."), results.join(" | "));
  eq("the newer local reading is kept", [roster.entries.kat.XP, roster.entries.kat.FirstName], [2100000, "K"]);
  eq("a learner only the backup knows is added", roster.entries.dan?.XP, 1200000);
  check("the last tab's writer stamp is cleared, so open tabs adopt it", !("beWriter" in roster));
  check("open tabs are told to reload", Number.isFinite(store.local.be_import_broadcast?.at));

  // An older backup has no section; a damaged one is skipped on its own.
  store.local = { be_alltime_roster: { version: 1, entries: { kat: { Handle: "kat", XP: 1, profileAt: T } } } };
  const old = { settings: { allTimeLeaderboard: true } };
  const oldResults = await run(`applyBackup(${JSON.stringify(old)})`);
  check("a backup without the section leaves the roster alone",
    store.local.be_alltime_roster?.entries?.kat?.XP === 1 && !oldResults.some((r) => r.includes("Observed")));

  // A bad section, whatever its shape, is skipped and said so, and every other
  // section of the same backup still applies.
  const badSections = [
    null, "garbage", 42, [],
    { format: "nope", version: 1, learners: [] },
    { format: FORMAT, version: VERSION + 1, learners: [] },
    { format: FORMAT, version: VERSION, learners: "x" },
  ];
  for (const bad of badSections) {
    const label = JSON.stringify(bad);
    store.sync = { be_settings: { allTimeLeaderboard: true } };
    store.local = { be_alltime_roster: { version: 1, entries: { kat: { Handle: "kat", XP: 1, profileAt: T } } } };
    const damaged = {
      settings: { allTimeLeaderboard: false },
      personalLeaderboard: { handles: ["friend"], snapshots: {} },
      bossState: { eventId: "event-1", eventHigh: 50, allTimeHigh: 80 },
      observedLearners: bad,
    };
    let damagedResults = [];
    try {
      damagedResults = await run(`applyBackup(${JSON.stringify(damaged)})`);
    } catch (err) {
      check(`a bad section (${label}) does not stop the import`, false, String(err));
    }
    check(`a bad section (${label}) is skipped and said so`,
      damagedResults.some((r) => r.startsWith("Top Observed Learners skipped:")), damagedResults.join(" | "));
    eq(`and leaves the roster alone (${label})`, Object.keys(store.local.be_alltime_roster?.entries || {}), ["kat"]);
    eq(`while settings, tracked learners and boss stats still apply (${label})`,
      [store.sync.be_settings?.allTimeLeaderboard, store.local.be_personal_leaderboard_handles?.handles,
        store.local.be_boss_state?.state?.allTimeHigh],
      [false, ["friend"], 80]);
  }

  store.local = {};
  eq("an empty roster adds no section", (await run("collectBackupData()")).data.observedLearners, undefined);
}

// --- 7. an imported backup reaches open Boot.dev tabs -----------------------------------

{
  // The options page and a Boot.dev tab share one storage, and like Chrome each
  // set() fires one onChanged event with the keys it wrote. The tab runs the
  // real roster code and the real storage-change handlers from content.js. Only
  // those three handlers are taken from content.js, because loading the file
  // starts the whole extension, which needs every feature file and a page.
  const store = { sync: {}, local: {} };
  const listeners = [];
  const copy = (v) => (v === undefined ? undefined : JSON.parse(JSON.stringify(v)));
  const area = (name) => ({
    get: (key, cb) => cb({ [key]: copy(store[name][key]) }),
    set: (obj, cb) => {
      const changes = {};
      for (const [key, value] of Object.entries(obj)) {
        changes[key] = { oldValue: copy(store[name][key]), newValue: copy(value) };
        store[name][key] = copy(value);
      }
      cb && cb();
      for (const listener of listeners) listener(changes, name);
    },
  });
  const chrome = {
    runtime: { lastError: undefined, getManifest: () => ({ version: "0.16.0" }) },
    storage: { sync: area("sync"), local: area("local") },
  };
  const settle = () => new Promise((resolve) => setTimeout(resolve, 20));

  let renders = 0;
  const tab = {
    window: {}, console, URL, chrome, setTimeout, clearTimeout, setInterval: () => 0, clearInterval() {},
    document: { addEventListener() {}, removeEventListener() {}, getElementById: () => null },
    location: { origin: "https://www.boot.dev", pathname: "/leaderboard" },
    isFeatureEnabled: () => true, currentUserHandle: "", personalHandles: [], anyPersonalBoardEnabled: () => false,
    renderAllTimeLeaderboard: () => { renders += 1; },
    // What the handlers also reach, which this check is not about.
    SETTINGS_KEY: "be_settings", BOSS_KEY: "be_boss_state", PERSONAL_CACHE_KEY: "be_personal_leaderboard_cache",
    PERSONAL_HANDLES_KEY: "be_personal_leaderboard_handles", CURRENT_USER_KARMA_KEY: "be_current_user_karma",
    adoptBossState: async () => {}, loadPersonalLeaderboard: async () => {}, loadCurrentUserHandle: async () => {},
    loadBossState: async () => {}, restoreBossPanel: async () => {}, schedulePersonalLeaderboardRender() {},
    isLeaderboardPage: () => true, personalDataMissing: () => false, requestPersonalLeaderboardData() {},
    getSettings: () => ({}), applyStoredSettings() {}, applyFeatureSettings() {},
    handleAsyncError: (err) => { failures += 1; console.error("FAIL: tab handler threw —", err); },
  };
  vm.createContext(tab);
  for (const file of ["utils.js", "observed-learners.js", "alltime-seed.js", "allTimeRoster.js"]) {
    const url = new URL(file, SRC);
    vm.runInContext(readFileSync(url, "utf8"), tab, { filename: fileURLToPath(url) });
  }
  const contentSource = readFileSync(new URL("content.js", SRC), "utf8");
  const handler = (head) => {
    const start = contentSource.indexOf(head);
    const end = contentSource.indexOf("\n}\n", start);
    if (start < 0 || end < 0) throw new Error(`content.js no longer has ${head}; update this check`);
    return contentSource.slice(start, end + 3);
  };
  vm.runInContext([
    'const IMPORT_BROADCAST_KEY = "be_import_broadcast";',
    handler("function handleSettingsChange("),
    handler("async function adoptCrossTabWrites("),
    handler("async function applyImportedData("),
  ].join("\n"), tab);
  listeners.push((changes, name) => vm.runInContext("handleSettingsChange", tab)(changes, name));
  const inTab = (code) => vm.runInContext(code, tab);

  const page = { console, chrome };
  vm.createContext(page);
  for (const url of [MODULE, BACKUP]) vm.runInContext(readFileSync(url, "utf8"), page, { filename: fileURLToPath(url) });
  const onPage = (code) => vm.runInContext(code, page);

  // The tab loads its roster and is the last to write it, so the stored copy
  // carries the tab's own stamp — the case where a tab would skip the change.
  await inTab("loadAllTimeRoster()");
  inTab("saveAllTimeRoster()");
  await settle();
  eq("the stored roster carries the open tab's stamp",
    store.local.be_alltime_roster?.beWriter, inTab("CATALYST_WRITER_ID"));

  const T = Date.now();
  const withLearners = {
    observedLearners: {
      format: FORMAT, version: VERSION, generatedAt: new Date(T).toISOString(),
      learners: [{ handle: "brandnewtop", xp: 5_000_000, at: new Date(T).toISOString() }],
    },
  };
  renders = 0;
  await onPage(`applyBackup(${JSON.stringify(withLearners)})`);
  await settle();
  check("the open tab adopts an imported roster", inTab("Boolean(allTimeRoster.entries.brandnewtop)"));
  check("and redraws its board", renders > 0);
  check("and the imported learner survives the tab's own next write",
    Boolean(store.local.be_alltime_roster?.entries?.brandnewtop));

  const before = JSON.stringify(store.local.be_alltime_roster.entries);
  await onPage(`applyBackup(${JSON.stringify({ settings: { bossTracker: true } })})`);
  await settle();
  check("a backup without the section leaves the stored roster as it was",
    JSON.stringify(store.local.be_alltime_roster?.entries) === before);
  check("and the open tab keeps its learners", inTab("Boolean(allTimeRoster.entries.brandnewtop)"));

  // A backup reaches the tab two ways: the roster write itself, and the import
  // signal written last. The Import learners button sends no signal, so it
  // depends on the roster write alone — and that write is only adopted because
  // the import clears the stamp the tab left on the stored copy.
  inTab("saveAllTimeRoster()");
  await settle();
  eq("the tab has written the roster again, under its own stamp",
    store.local.be_alltime_roster?.beWriter, inTab("CATALYST_WRITER_ID"));
  const listed = [{ handle: "listedtop", xp: 4_000_000, at: T }];
  await onPage(`(async () => {
    const stored = await backupStorageGet("local", OBSERVED_ROSTER_STORAGE_KEY);
    const { roster } = importObservedLearnersIntoStoredRoster(stored, ${JSON.stringify(listed)});
    await backupStorageSet("local", OBSERVED_ROSTER_STORAGE_KEY, roster);
  })()`);
  await settle();
  check("a learner-list import reaches the open tab with no import signal",
    inTab("Boolean(allTimeRoster.entries.listedtop)"));
}

if (failures) {
  console.error(`\n${failures} check(s) failed`);
  process.exit(1);
}
console.log("check_observed_learners: all checks passed");
