// observed-learners.js
// The observed-learner list format, and the one rule for folding a list into
// the Observed board's roster. Three things read and write these lists, and
// they must agree exactly:
//   - the bundled seed (alltime-seed.js, generated alongside data/observed-learners.json),
//   - the options page's Export / Import learners buttons,
//   - the opt-in fetch of the published list (allTimeRoster.js).
//
// Dependency-free and side-effect free, so it loads both as a content script
// (before alltime-seed.js and allTimeRoster.js) and on the options page through
// a <script> tag. The two helpers it needs from utils.js are mirrored — keep in
// sync.
//
// A list holds handles, lifetime XP, and the time each XP reading was observed.
// Names, avatars, level, and role come from each learner's public profile when
// the board needs them and stay in this browser's storage. Published or shared
// lists therefore contain only those three fields.

const OBSERVED_LEARNERS_FORMAT = "catalyst-observed-learners";
// Bump only for a STRUCTURAL change. A reader refuses a version newer than it
// knows instead of guessing at it, so a list published for a later release can
// never break an installed copy. A new optional field is not structural:
// readers skip fields they do not know.
const OBSERVED_LEARNERS_VERSION = 1;
// What a list holds, and what the roster keeps once a list is folded in.
const OBSERVED_LEARNERS_MAX = 100;
// Readers accept more rows than a writer produces and trim after merging, so a
// list from a differently configured copy is not refused outright.
const OBSERVED_LEARNERS_READ_MAX = 250;
const OBSERVED_LEARNERS_MAX_BYTES = 256 * 1024;
// A reading dated further ahead than this is a clock error rather than a newer
// reading, and would otherwise beat every genuine observation until that time
// arrived.
const OBSERVED_LEARNERS_CLOCK_SKEW_MS = 60 * 60 * 1000;
// The roster the lists merge into. allTimeRoster.js reads the key from here and
// the options page writes it, so the two cannot drift apart.
const OBSERVED_ROSTER_STORAGE_KEY = "be_alltime_roster";

// --- helpers -----------------------------------------------------------------

// Stricter than normalizeHandle in utils.js, which cuts a pasted profile URL
// down at the first "/", "?" or space. A list row is a handle, not a URL, so a
// row such as "bad handle" is refused instead of being truncated into a
// different learner. The character rule mirrors isValidHandle — keep in sync.
function observedLearnerHandle(value) {
  const handle = String(value || "").trim().replace(/^@/, "").toLowerCase();
  return /^[a-z0-9][a-z0-9_-]{0,39}$/.test(handle) ? handle : "";
}

function observedLearnersIsObject(value) {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

// Number(null) is 0, so a missing XP would read as a real zero — the fabricated
// value this codebase has been bitten by three times. Absent stays null.
function observedLearnersNum(value) {
  if (value == null || value === "") return null;
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
}

// --- ordering -----------------------------------------------------------------

// XP descending, then handle, so equal XP orders the same way everywhere —
// matches compareByObservedXp in allTimeRoster.js.
function compareObservedLearners(a, b) {
  return b.xp - a.xp || a.handle.localeCompare(b.handle);
}

// --- read -----------------------------------------------------------------------

// Parse a list from text or from an already-parsed object. File-level strict:
// anything that is not recognisably this format and version is refused whole.
// Entry-level lenient: a malformed row is skipped and the rest are kept. A
// handle listed twice keeps its newer reading.
// Returns { generatedAt, learners, skipped } or { error }.
function parseObservedLearners(input, now = Date.now()) {
  let parsed = input;
  if (typeof input === "string") {
    if (!input.trim()) return { error: "The file is empty." };
    if (input.length > OBSERVED_LEARNERS_MAX_BYTES) {
      return { error: "The file is too large to be a Catalyst learner list." };
    }
    try {
      parsed = JSON.parse(input);
    } catch (_) {
      return { error: "Not a JSON file." };
    }
  }
  if (!observedLearnersIsObject(parsed) || parsed.format !== OBSERVED_LEARNERS_FORMAT) {
    return { error: "Not a Catalyst learner list." };
  }
  const version = parsed.version;
  if (!Number.isInteger(version) || version < 1) {
    return { error: "The list has no valid format version." };
  }
  if (version > OBSERVED_LEARNERS_VERSION) {
    return {
      error: `This list uses format v${version}; this Catalyst reads up to v${OBSERVED_LEARNERS_VERSION}. Update Catalyst, then retry.`,
    };
  }
  if (!Array.isArray(parsed.learners)) return { error: "The list contains no learners." };

  const latest = now + OBSERVED_LEARNERS_CLOCK_SKEW_MS;
  const byHandle = new Map();
  let skipped = 0;
  for (const raw of parsed.learners) {
    const handle = observedLearnerHandle(raw?.handle);
    const xp = observedLearnersNum(raw?.xp);
    const at = Date.parse(raw?.at);
    if (!handle || xp == null || xp < 0 || !Number.isFinite(at) || at <= 0 || at > latest) {
      skipped += 1;
      continue;
    }
    const prior = byHandle.get(handle);
    if (prior && prior.at >= at) continue;
    byHandle.set(handle, { handle, xp: Math.round(xp), at });
  }

  const learners = Array.from(byHandle.values())
    .sort(compareObservedLearners)
    .slice(0, OBSERVED_LEARNERS_READ_MAX);
  const generatedAt = Date.parse(parsed.generatedAt);
  return {
    generatedAt: Number.isFinite(generatedAt) ? generatedAt : null,
    learners,
    skipped,
  };
}

// --- write ----------------------------------------------------------------------

// Build a list: highest XP first, ties by handle, at most OBSERVED_LEARNERS_MAX
// rows. The order is for whoever reads the file or reviews a change to it;
// readers re-sort and never rely on it.
function buildObservedLearners(learners, now = Date.now()) {
  const rows = (Array.isArray(learners) ? learners : [])
    .filter((l) => l && observedLearnerHandle(l.handle) && Number.isFinite(l.xp) && Number.isFinite(l.at) && l.at > 0)
    .map((l) => ({ handle: observedLearnerHandle(l.handle), xp: Math.round(l.xp), at: l.at }))
    .sort(compareObservedLearners)
    .slice(0, OBSERVED_LEARNERS_MAX);
  return {
    format: OBSERVED_LEARNERS_FORMAT,
    version: OBSERVED_LEARNERS_VERSION,
    generatedAt: new Date(now).toISOString(),
    learners: rows.map((l) => ({ handle: l.handle, xp: l.xp, at: new Date(l.at).toISOString() })),
  };
}

// One learner per line, so a refreshed list reviews as a readable diff.
function stringifyObservedLearners(list) {
  const rows = list.learners.map((l) =>
    `    { "handle": ${JSON.stringify(l.handle)}, "xp": ${JSON.stringify(l.xp)}, "at": ${JSON.stringify(l.at)} }`);
  return [
    "{",
    `  "format": ${JSON.stringify(list.format)},`,
    `  "version": ${JSON.stringify(list.version)},`,
    `  "generatedAt": ${JSON.stringify(list.generatedAt)},`,
    `  "learners": [${rows.length ? "\n" + rows.join(",\n") + "\n  " : ""}]`,
    "}",
    "",
  ].join("\n");
}

// --- roster bridge ----------------------------------------------------------------

// The roster as a list: every learner with an XP reading and the time it was
// read. Display fields stay behind on purpose — see the header.
function rosterToObservedLearners(roster) {
  const out = [];
  const entries = observedLearnersIsObject(roster?.entries) ? roster.entries : {};
  for (const [key, entry] of Object.entries(entries)) {
    if (!observedLearnersIsObject(entry)) continue;
    const handle = observedLearnerHandle(entry.Handle || key);
    const xp = observedLearnersNum(entry.XP);
    const at = observedLearnersNum(entry.profileAt);
    if (!handle || xp == null || xp < 0 || at == null || at <= 0) continue;
    out.push({ handle, xp, at });
  }
  return out.sort(compareObservedLearners);
}

// Fold a parsed list into a roster's entries. Per handle the newer reading
// wins — the rule every other sighting follows — so an old list can never
// overwrite something read more recently. A handle the roster does not hold is
// added with its XP alone; the board fetches the rest when it draws the row.
// `blank` builds an empty entry in the caller's shape (allTimeRoster.js passes
// blankEntry); without it the entry carries only what the list supplied.
// Returns the handles added and updated.
function mergeObservedLearnersIntoRoster(roster, learners, { source = "shared", blank = null } = {}) {
  const added = [];
  const updated = [];
  if (!observedLearnersIsObject(roster)) return { added, updated };
  if (!observedLearnersIsObject(roster.entries)) roster.entries = {};
  for (const learner of Array.isArray(learners) ? learners : []) {
    const handle = observedLearnerHandle(learner?.handle);
    if (!handle || !Number.isFinite(learner.xp) || !Number.isFinite(learner.at)) continue;
    const existing = roster.entries[handle];
    if (!observedLearnersIsObject(existing)) {
      roster.entries[handle] = {
        ...(typeof blank === "function" ? blank(handle) : { Handle: handle }),
        XP: learner.xp,
        profileAt: learner.at,
        source,
      };
      added.push(handle);
      continue;
    }
    const existingAt = observedLearnersNum(existing.profileAt) || 0;
    if (learner.at <= existingAt) continue;
    roster.entries[handle] = { ...existing, XP: learner.xp, profileAt: learner.at };
    updated.push(handle);
  }
  return { added, updated };
}

// Keep the `limit` highest-XP entries; an entry with no XP sorts last and goes
// first. Returns the handles removed.
function trimObservedRoster(roster, limit = OBSERVED_LEARNERS_MAX) {
  const entries = observedLearnersIsObject(roster?.entries) ? Object.entries(roster.entries) : [];
  if (entries.length <= limit) return [];
  const xpOf = (entry) => observedLearnersNum(entry?.XP) ?? -1;
  const removed = entries
    .sort(([ha, a], [hb, b]) => xpOf(b) - xpOf(a) || ha.localeCompare(hb))
    .slice(limit)
    .map(([handle]) => handle);
  for (const handle of removed) delete roster.entries[handle];
  return removed;
}

// The options page's import: fold a list into the roster object as it was
// read from storage, keep the top OBSERVED_LEARNERS_MAX, and return what to
// write back. The writer stamp (`beWriter`, see mergeWrite in utils.js — keep
// in sync) is removed: it names the Boot.dev tab that wrote last, and that tab
// skips any change carrying its own stamp, so it would never adopt the import.
function importObservedLearnersIntoStoredRoster(stored, learners, now = Date.now()) {
  const roster = observedLearnersIsObject(stored) ? { ...stored } : { version: 1, entries: {} };
  roster.entries = observedLearnersIsObject(stored?.entries) ? { ...stored.entries } : {};
  const { added, updated } = mergeObservedLearnersIntoRoster(roster, learners);
  trimObservedRoster(roster, OBSERVED_LEARNERS_MAX);
  delete roster.beWriter;
  roster.updatedAt = now;
  return {
    roster,
    kept: added.filter((handle) => handle in roster.entries).length,
    updated: updated.length,
  };
}

// What importing a list would do, without doing it: for the options page's
// confirm step. Works on a copy, so the caller's roster is untouched.
function previewObservedLearnersImport(roster, learners) {
  const copy = { entries: {} };
  if (observedLearnersIsObject(roster?.entries)) {
    for (const [handle, entry] of Object.entries(roster.entries)) copy.entries[handle] = { ...entry };
  }
  const { added, updated } = mergeObservedLearnersIntoRoster(copy, learners);
  trimObservedRoster(copy, OBSERVED_LEARNERS_MAX);
  const kept = added.filter((handle) => handle in copy.entries).length;
  return { listed: learners.length, added: added.length, kept, updated: updated.length };
}

// Test hook: scripts/check_observed_learners.mjs predefines this global before
// evaluating the file. Never defined on the real page or the options page.
if (typeof window !== "undefined" && window.__BOOTDEV_ENHANCER_TEST__) {
  window.__BOOTDEV_ENHANCER_TEST__.observedLearners = {
    observedLearnerHandle,
    compareObservedLearners,
    parseObservedLearners,
    buildObservedLearners,
    stringifyObservedLearners,
    rosterToObservedLearners,
    mergeObservedLearnersIntoRoster,
    trimObservedRoster,
    importObservedLearnersIntoStoredRoster,
    previewObservedLearnersImport,
    constants: {
      OBSERVED_LEARNERS_FORMAT,
      OBSERVED_LEARNERS_VERSION,
      OBSERVED_LEARNERS_MAX,
      OBSERVED_LEARNERS_READ_MAX,
      OBSERVED_LEARNERS_CLOCK_SKEW_MS,
    },
  };
}
