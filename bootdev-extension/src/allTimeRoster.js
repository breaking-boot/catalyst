// allTimeRoster.js
// The data half of the Top All-Time Learners board: what Catalyst knows about
// the highest-ranked learners, how it learns it, and how the board's positions
// are worked out. leaderboard.js owns the rendering.
//
// WHY THIS EXISTS, and why the design moved twice:
//
//   2026-08-14  /v1/leaderboard_xp/alltime removed (400 "Invalid timeframe";
//               23 period names probed). Nothing enumerates the top 25, so the
//               board became a ROSTER: keep handles, learn each one's rank.
//   2026-08-20  leaderboardXPRankAlltime removed from /stats too, replaced by
//               leaderboardXPPercentileAlltime — a band so coarse that a single
//               value covers lifetime XP from 930,102 to 1,741,426 (measured
//               2026-08-21). There is now NO source of an exact position.
//
// So ordering comes from lifetime XP alone, compared between the learners
// Catalyst has actually observed. That is an OBSERVED ranking, not an objective
// one, and the board is named accordingly — a position here means "Nth highest
// XP among those Catalyst knows of", never "Nth on Boot.dev".
//
// Entries carry no rank. The seed used to carry the last ranks measured before
// the field was withdrawn, and gating the seed on them kept out every learner
// discovered afterwards — including ones who had since climbed into the top 10
// by XP. A position is derived from XP on every render; roster.self keeps a
// slot for the viewer's own rank in case Boot.dev ever serves one again.

const ALLTIME_ROSTER_KEY = OBSERVED_ROSTER_STORAGE_KEY;
const ALLTIME_ROSTER_VERSION = 1;
const ALLTIME_BOARD_SIZE = 25;

// Retained window: the 25 the board draws plus a watchlist of 75 underneath,
// so a climber is already tracked before they reach the board. The watchlist
// is also what an exported or published list carries. Pruned by XP, with
// hysteresis: the roster may grow to ROSTER_PRUNE_AT before it is cut back, so
// a learner sitting at the boundary is not dropped and re-admitted on
// alternate sightings.
const ROSTER_MAX_ENTRIES = OBSERVED_LEARNERS_MAX;
const ROSTER_PRUNE_AT = ROSTER_MAX_ENTRIES + 10;

// The refresh queue has two rings, because a single round robin over 100
// learners would take an hour of browsing per lap and leave the visible rows
// staler than the tail deserves.
//
// HOT: the rendered 25 plus the next few climbers. XP has no TTL here: the
// cursor advances on every leaderboard load, so the ring refreshes over a few
// loads and reloading the page IS a refresh. A clock TTL would refresh a board
// nobody is reading and still be stale the moment someone opens it.
// 8, not 6: the week and month XP API timeframes are no longer available
// (confirmed returning 400 "Invalid timeframe" on 2026-09-19) and the two
// requests per pass they used to spend now go here.
//
// COLD: everyone else. Two per pass, and only learners not read for a while —
// the native boards on the same page refresh much of the tail for free.
const ROSTER_HOT_SIZE = ALLTIME_BOARD_SIZE + 5;
const ROSTER_XP_SLICE = 8;
const ROSTER_COLD_SLICE = 2;
const ROSTER_COLD_FRESH_MS = 12 * 60 * 60 * 1000;
const ROSTER_REQUEST_CEILING = 12;
const ROSTER_REFRESH_COOLDOWN_MS = 5 * 60 * 1000;

// PRIMING. Until Catalyst has walked the roster once, every row still carries
// the bundled seed's XP — which is release-day accurate and then drifts, so a
// fresh install can show two neighbours in the wrong order until the sweep
// reaches them. At the steady-state pace that first sweep takes five visits
// spread over 20+ minutes, which is a long time to look wrong.
//
// So the first sweep runs hot: a bigger slice and a much shorter cooldown, and
// consecutive loads converge the board in about a minute. It is bounded by
// construction — the cursor advances every pass whether or not it issues
// requests, so it wraps within ceil(entries / slice) passes and priming ends
// for good. Deliberately keyed on the WRAP COUNT rather than on "does any row
// still look seed-vintage": a handle that 404s would never refresh, and that
// would leave a state-based check priming forever.
const ROSTER_XP_PRIMING_SLICE = 10;
const ROSTER_PRIMING_COOLDOWN_MS = 20 * 1000;
// A handle seen this recently needs no request; covers the overlap with the
// Personal Leaderboards pass, which refreshes its own handles every visit.
const ROSTER_RECENT_SIGHTING_MS = 2 * 60 * 1000;

let allTimeRoster = null;
let rosterLastPassAt = 0;

function emptyRoster() {
  return {
    version: ALLTIME_ROSTER_VERSION,
    updatedAt: 0,
    xpCursor: 0,
    xpWraps: 0,
    coldCursor: 0,
    boardSeen: [],
    self: {},
    entries: {},
  };
}

// True once the hot ring's cursor has been all the way round at least once,
// i.e. every visible row has had a chance to be read live rather than
// inherited from the seed.
// A replacement seed in a later release does NOT un-prime the roster: that seed
// is fresh at release time, so there is nothing to catch up on.
function rosterIsPrimed(roster) {
  return (observedNum(roster?.xpWraps) || 0) >= 1;
}

// ---------------------------------------------------------------------------
// Entry shape
// ---------------------------------------------------------------------------
// Display fields are stored in PascalCase LEADERBOARD-ENTRY shape on purpose:
// getDisplayName / getAvatarUrl / getRoleFrameIndex / renderLeaderAvatar in
// leaderboard.js then work on a roster entry with no changes at all. Catalyst's
// own bookkeeping uses lowercase names so the two can never be confused.
function blankEntry(handle) {
  return {
    Handle: handle,
    FirstName: "",
    LastName: "",
    Role: "",
    Level: null,
    XP: null,
    ProfileImageURL: "",
    profileAt: 0,
    source: "observed",
  };
}

// ---------------------------------------------------------------------------
// Merge: newest observation wins, always
// ---------------------------------------------------------------------------
// One rule covers "don't clobber my fresh data with an old seed" and "a newer
// bundled seed upgrades a stale row" — no overwrite flag, no special cases.
//
// XP is written EXACTLY as observed, including a decrease. Boot.dev staff can
// manually reduce XP where they believe it was cheated (rare; never observed).
// Do NOT add a Math.max guard here: it would turn that rare correction into a
// permanently wrong row. Since ordering is now derived from XP alone, a
// reduction simply re-sorts the board, which is the correct outcome.
function mergeRosterObservation(existing, observation) {
  const handle = normalizeHandle(observation?.handle || existing?.Handle);
  if (!handle) return existing || null;

  const entry = isPlainObject(existing) ? { ...existing } : blankEntry(handle);
  entry.Handle = observation?.Handle || entry.Handle || handle;

  const profileAt = observedNum(observation?.profileAt) || 0;
  if (profileAt >= (observedNum(entry.profileAt) || 0)) {
    const xp = observedNum(observation?.XP);
    if (xp != null) {
      entry.XP = xp;
      entry.profileAt = profileAt;
    }
    for (const field of ["FirstName", "LastName", "Role", "ProfileImageURL"]) {
      if (observation?.[field] != null && observation[field] !== "") entry[field] = observation[field];
    }
    const level = observedNum(observation?.Level);
    if (level != null) entry.Level = level;
  }

  if (observation?.source) entry.source = observation.source;
  return entry;
}

// Apply an observation to the roster, honoring the retained window. Returns
// true when anything changed, so callers can skip a pointless storage write.
function applyRosterObservation(roster, observation) {
  const handle = normalizeHandle(observation?.handle);
  if (!isValidHandle(handle) || !isPlainObject(roster)) return false;

  const existing = roster.entries[handle];

  // Admission is now purely about XP. Rank used to gate this, but Boot.dev
  // removed the field on 2026-08-20, so "is this person high enough to belong"
  // can only be answered by comparing lifetime XP against what is already held.
  // A handle Catalyst has never seen therefore needs an explicit admission
  // decision from the caller (see noteAllTimeProfile), which owns the floor.
  if (!existing && !observation?.candidate) return false;

  const merged = mergeRosterObservation(existing, observation);
  if (!merged) return false;
  if (existing && JSON.stringify(existing) === JSON.stringify(merged)) return false;

  roster.entries[handle] = merged;
  pruneRoster(roster);
  return true;
}

// Keep the store bounded: once it passes `limit`, cut it back to the
// ROSTER_MAX_ENTRIES highest-XP entries. XP is both the ordering signal and the
// admission signal, so one rule covers it; an entry with no XP sorts last and
// goes first. The shared list code does the cut, so an imported list and a
// sighting are pruned identically.
function pruneRoster(roster, limit = ROSTER_PRUNE_AT) {
  if (Object.keys(roster?.entries || {}).length <= limit) return [];
  return trimObservedRoster(roster, ROSTER_MAX_ENTRIES);
}

// ---------------------------------------------------------------------------
// Seed
// ---------------------------------------------------------------------------
// Applied on EVERY load, not just the first: shipping a fresher seed in a later
// release then upgrades stale rows for free, while a user whose own data is
// newer keeps it (merge rule above, applied per learner by the shared list
// code). The seed is an observed-learner list like any other, so it is read by
// the same parser as an imported or fetched one.
function applySeedToRoster(roster, seed = typeof ALLTIME_SEED === "undefined" ? null : ALLTIME_SEED) {
  if (!isPlainObject(roster) || !isPlainObject(seed)) return false;
  return applyObservedLearners(roster, seed, "seed").changed;
}

// Fold an observed-learner list (bundled seed, imported file or fetched copy)
// into the roster. A list can carry far more learners than a sighting does, so
// the roster is pruned afterwards like after any other admission.
function applyObservedLearners(roster, list, source) {
  const parsed = parseObservedLearners(list);
  if (parsed.error) {
    warnOnce(`alltime:list-${source}`, `Observed-learner list (${source}) was not applied: ${parsed.error}`);
    return { changed: false, added: [], updated: [], parsed };
  }
  const { added, updated } = mergeObservedLearnersIntoRoster(roster, parsed.learners, { source, blank: blankEntry });
  pruneRoster(roster);
  return { changed: added.length > 0 || updated.length > 0, added, updated, parsed };
}

// bootstrapRosterFromPersonalRecords was removed with the pivot. It seeded the
// roster from ranks already sitting in be_personal_leaderboard_cache, and since
// 2026-08-20 those caches can only hold ranks from before the field was
// withdrawn — stale numbers that no longer decide anything. Tracked handles
// still reach the roster the ordinary way, by XP, when their responses arrive.


// ---------------------------------------------------------------------------
// Field reads
// ---------------------------------------------------------------------------
// Both readers unwrap `data` first, because /stats is wrapped and
// /v1/leaderboard_stats was captured bare — and either could gain or lose the
// wrapper without warning.
//
// The exact rank is gone (2026-08-20, absent on 26 of 26 handles probed). This
// is kept ONLY so a restored field would be noticed: it is read on every /stats
// response and, if it ever answers again, reportAlltimeRankField stops warning
// and the value flows back into the roster as provenance.
function readAlltimeRank(json) {
  const data = json?.data ?? json;
  if (!isPlainObject(data)) return null;
  return observedNum(readField(data, "LeaderboardXPRankAlltime"));
}

// What replaced it: an integer band, lower is better. Far too coarse to order
// anyone Catalyst renders — band 1 spans 930,102 to 1,741,426 lifetime XP — so
// it is NEVER used for ordering or converted into an estimated rank. It is
// displayed verbatim, for the viewer only, as the one self-position signal
// Boot.dev still publishes.
function readAlltimePercentile(json) {
  const data = json?.data ?? json;
  if (!isPlainObject(data)) return null;
  const direct = observedNum(readField(data, "LeaderboardXPPercentileAlltime"));
  if (direct != null) return direct;
  for (const [key, value] of Object.entries(data)) {
    if (key.toLowerCase() === "leaderboardxppercentilealltime") return observedNum(value);
  }
  return null;
}

// /v1/leaderboard_stats is the ONE leaderboard-related endpoint that was not
// re-read in the 2026-08-19 casing audit, so its current shape is genuinely
// unverified — the "bare PascalCase object" note dates from 2026-08-14, before
// every other endpoint in this family flipped. Hence the case-insensitive sweep
// rather than an entry in API_FIELD_ALIASES: a guessed alias would be a claim,
// while the sweep resolves whatever spelling actually arrives. Fold this into
// the alias table once a capture settles it.
function readRegisteredUsers(json) {
  const data = json?.data ?? json;
  if (!isPlainObject(data)) return null;
  for (const [key, value] of Object.entries(data)) {
    if (key.toLowerCase() === "registeredusersalltime") return observedNum(value);
  }
  return null;
}

// ---------------------------------------------------------------------------
// Discovery
// ---------------------------------------------------------------------------
// The XP a newcomer must beat to be admitted, or null when anyone is.
//
// Below capacity, every sighting with a readable lifetime XP is admitted,
// however low. An empty slot helps nobody, a low entry is displaced as soon as
// someone higher is seen, and a fast climber is tracked from the first
// sighting rather than only once they are already near the top. (The previous
// rule demanded beating the LOWEST XP held even with slots free, which against
// a seed of top learners turned away nearly everyone the native boards showed.)
//
// At capacity, a newcomer has to beat the learner in the last retained place.
// Dropping someone costs nothing — the roster holds only their latest XP — so a
// climber who falls out is simply re-admitted by a later sighting.
function admissionThresholdXp(roster) {
  const xps = [];
  for (const entry of Object.values(roster?.entries || {})) {
    const xp = observedNum(entry.XP);
    if (xp != null) xps.push(xp);
  }
  if (xps.length < ROSTER_MAX_ENTRIES) return null;
  xps.sort((a, b) => b - a);
  return xps[ROSTER_MAX_ENTRIES - 1];
}

// How many learners the board can actually draw. There is no notion of a
// "known position" any more — an unknown occupant of slot 17 is not something
// Catalyst can detect, because nothing reports positions. What it can state
// honestly is how many learners it is ordering.
function rosterCoverage(roster) {
  let observed = 0;
  for (const entry of Object.values(roster?.entries || {})) {
    if (observedNum(entry.XP) != null) observed += 1;
  }
  return observed;
}

// ---------------------------------------------------------------------------
// Position derivation
// ---------------------------------------------------------------------------
// Positions are the XP order of the learners held, nothing more: with no rank
// to anchor against, an unknown learner between two known ones cannot be
// detected, which is why the board says "observed".
function deriveBoardPositions(roster) {
  const entries = Object.values(roster?.entries || {}).filter((e) => observedNum(e.XP) != null);
  return {
    positions: entries
      .sort(compareByObservedXp)
      .map((entry, index) => ({ entry, position: index + 1 })),
  };
}

// Ordering comparator. XP descending, then a DETERMINISTIC tiebreak on handle.
// Without the tiebreak, two learners on identical XP would order by whatever
// Object.values happened to yield and could swap places between renders for no
// reason. Boot.dev itself appears to treat equal XP as a tie group rather than
// assigning arbitrary ordinals, so inventing a stable-but-meaningless order is
// the best available behaviour: at least it does not flicker.
function compareByObservedXp(a, b) {
  const diff = observedNum(b.XP) - observedNum(a.XP);
  if (diff) return diff;
  return normalizeHandle(a.Handle).localeCompare(normalizeHandle(b.Handle));
}


// The board: 25 fixed slots, a real row where a position is known and a gap row
// where it is not. Never fabricates a name, an XP figure or a handle.
function buildAllTimeBoardRows(roster, selfHandle = "") {
  const { positions } = deriveBoardPositions(roster);
  const rows = positions
    .filter((placed) => placed.position <= ALLTIME_BOARD_SIZE)
    .map((placed) => rosterRow(placed.entry, placed.position, selfHandle));

  // The viewer, when they are not among the observed top. Appended rather than
  // displacing someone real. There is no rank to show any more, so the row
  // carries no position — see renderers, which label it rather than number it.
  const selfNormalized = normalizeHandle(selfHandle || roster?.self?.handle);
  const onBoard = rows.some((r) => r.isCurrentUser);
  const selfEntry = selfNormalized ? roster?.entries?.[selfNormalized] : null;
  if (selfNormalized && !onBoard && selfEntry && observedNum(selfEntry.XP) != null) {
    rows.push({ ...rosterRow(selfEntry, null, selfNormalized), outsideBoard: true });
  }

  return { rows, observed: positions.length, shown: Math.min(positions.length, ALLTIME_BOARD_SIZE) };
}

function rosterRow(entry, position, selfHandle) {
  const handle = normalizeHandle(entry.Handle);
  return {
    key: handle || `slot:${position}`,
    gap: false,
    position,
    entry,
    handle,
    xp: observedNum(entry.XP),
    profileAt: observedNum(entry.profileAt) || 0,
    isCurrentUser: Boolean(handle) && handle === normalizeHandle(selfHandle),
    href: handle ? `/u/${encodeURIComponent(handle)}` : "",
  };
}

// ---------------------------------------------------------------------------
// Overtake detection
// ---------------------------------------------------------------------------
// The XP queue, in two rings (see ROSTER_HOT_SIZE). Driven by page loads
// rather than a clock, so the work lands where the attention is and an F5 is a
// refresh. `skip` carries the handles the Personal Leaderboards pass already
// covered this load, so an overlapping handle is not fetched twice.
//
// The hot ring walks in the board's own order — highest XP first — so the rows
// a reader is most likely to be looking at refresh earliest in a sweep.
function pickXpRefreshTargets(roster, {
  slice = ROSTER_XP_SLICE,
  coldSlice = ROSTER_COLD_SLICE,
  skip = [],
  now = Date.now(),
} = {}) {
  const ordered = Object.values(roster?.entries || {})
    .filter((entry) => observedNum(entry.XP) != null)
    .sort(compareByObservedXp);
  const skipSet = new Set(skip.map(normalizeHandle));
  // A skipped or recently read entry costs a slot nothing.
  const unreadFor = (ms) => (entry) =>
    !skipSet.has(normalizeHandle(entry.Handle)) && now - (observedNum(entry.profileAt) || 0) >= ms;
  const hot = walkRing(ordered.slice(0, ROSTER_HOT_SIZE), roster?.xpCursor, slice, unreadFor(ROSTER_RECENT_SIGHTING_MS));
  const cold = walkRing(ordered.slice(ROSTER_HOT_SIZE), roster?.coldCursor, coldSlice, unreadFor(ROSTER_COLD_FRESH_MS));
  return {
    targets: [...hot.handles, ...cold.handles],
    cursor: hot.cursor,
    wrapped: hot.wrapped,
    coldCursor: cold.cursor,
  };
}

// One round robin over `ring`, from `start`, collecting up to `slice` handles
// that `due` accepts. The cursor advances whether or not an entry is taken,
// which is what guarantees the wrap — and so guarantees priming terminates.
function walkRing(ring, start, slice, due) {
  if (!ring.length) return { handles: [], cursor: 0, wrapped: false };
  const from = clamp(observedNum(start) || 0, 0, ring.length - 1);
  const handles = [];
  let cursor = from;
  let wrapped = false;
  for (let step = 0; step < ring.length && handles.length < slice; step++) {
    const entry = ring[(from + step) % ring.length];
    if (from + step + 1 >= ring.length) wrapped = true;
    cursor = (from + step + 1) % ring.length;
    const handle = normalizeHandle(entry.Handle);
    if (handle && due(entry)) handles.push(handle);
  }
  return { handles, cursor, wrapped };
}

// ---------------------------------------------------------------------------
// Display fill
// ---------------------------------------------------------------------------
// The seed carries handle and XP only, so a row it adds has no name, avatar or
// frame until that learner's profile is read. When the board is drawn, the
// visible rows still missing them are fetched straight away instead of waiting
// for the XP sweep to come round.
//
// A deliberate exception to ROSTER_REQUEST_CEILING, bounded three ways: only
// rows the board is about to show (at most ALLTIME_BOARD_SIZE), each at most
// once per page session, and only when the board is actually drawn — not at
// install, when the user may be on a lesson and may never open the
// leaderboard. Requests are spaced rather than sent as a burst: twenty-five
// profile reads in the same second from one session is a conspicuous pattern,
// and nothing on screen needs them that fast. patchLeaderAvatar fills each row
// in place as its profile arrives.
const DISPLAY_FILL_SPACING_MS = 400;
const displayFillRequested = new Set();
let displayFillQueue = [];
let displayFillTimer = null;

// A profile read always brings a level and a role, so their absence means this
// learner has never been read — not that they have no avatar.
function needsDisplayFields(entry) {
  return !entry?.FirstName && !entry?.ProfileImageURL && !entry?.Role && observedNum(entry?.Level) == null;
}

function pickDisplayFillTargets(roster, requested = new Set()) {
  return deriveBoardPositions(roster).positions
    .filter(({ position, entry }) => position <= ALLTIME_BOARD_SIZE && needsDisplayFields(entry))
    .map(({ entry }) => normalizeHandle(entry.Handle))
    .filter((handle) => isValidHandle(handle) && !requested.has(handle));
}

function requestRosterDisplayFill() {
  if (!allTimeRoster || enhancerStopped) return [];
  if (!isLeaderboardPage() || !isFeatureEnabled("allTimeLeaderboard")) return [];
  const handles = pickDisplayFillTargets(allTimeRoster, displayFillRequested);
  for (const handle of handles) {
    displayFillRequested.add(handle);
    displayFillQueue.push(handle);
  }
  drainDisplayFill();
  return handles;
}

function drainDisplayFill() {
  if (displayFillTimer || !displayFillQueue.length || enhancerStopped) return;
  // Leaving the leaderboard abandons what is left. Those handles are released,
  // so the next time the board is drawn they are asked for again.
  if (!isLeaderboardPage()) {
    for (const handle of displayFillQueue) displayFillRequested.delete(handle);
    displayFillQueue = [];
    return;
  }
  const handle = displayFillQueue.shift();
  requestApiJson(`https://api.boot.dev/v1/users/public/${encodeURIComponent(handle)}`);
  displayFillTimer = setTrackedTimeout(() => {
    displayFillTimer = null;
    drainDisplayFill();
  }, DISPLAY_FILL_SPACING_MS);
}

// There is no rank queue any more. It fetched /stats to verify or discover a
// position, and positions no longer exist — every such request would return a
// percentile Catalyst cannot order by. detectOvertakes went with it: it existed
// to raise a rank re-check when fresher XP proved somebody had moved, and the
// board now simply re-sorts on the XP it already holds.
//
// A /stats response arriving for any other reason still updates the viewer's
// percentile through noteAllTimeObservation.


// ---------------------------------------------------------------------------
// Storage
// ---------------------------------------------------------------------------
async function loadAllTimeRoster() {
  const stored = await chromeGet(ALLTIME_ROSTER_KEY);
  if (enhancerStopped) return;

  allTimeRoster = normalizeStoredRoster(stored);
  let changed = !isPlainObject(stored);
  const seed = typeof ALLTIME_SEED === "undefined" ? null : ALLTIME_SEED;
  const seeded = isPlainObject(seed) ? applyObservedLearners(allTimeRoster, seed, "seed") : null;
  changed = Boolean(seeded?.changed) || changed;
  // A load is never news: whatever reached the board through the seed, an
  // import, or another tab's write is recorded without an alert.
  changed = noteBoardMembership(allTimeRoster, seeded?.added || []).changed || changed;
  if (changed) saveAllTimeRoster();
}

function normalizeStoredRoster(stored) {
  const roster = emptyRoster();
  if (!isPlainObject(stored)) return roster;
  roster.updatedAt = observedNum(stored.updatedAt) || 0;
  roster.xpCursor = observedNum(stored.xpCursor) || 0;
  roster.xpWraps = observedNum(stored.xpWraps) || 0;
  roster.coldCursor = observedNum(stored.coldCursor) || 0;
  roster.boardSeen = Array.isArray(stored.boardSeen)
    ? uniqueHandleList(stored.boardSeen).slice(-BOARD_SEEN_MAX)
    : [];
  if (isPlainObject(stored.self)) {
    roster.self = {
      handle: normalizeHandle(stored.self.handle),
      rank: observedNum(stored.self.rank),
      rankAt: observedNum(stored.self.rankAt) || 0,
    };
  }
  if (!isPlainObject(stored.entries)) return roster;
  for (const [handle, entry] of Object.entries(stored.entries)) {
    const normalized = normalizeHandle(handle);
    if (!isValidHandle(normalized) || !isPlainObject(entry)) continue;
    // Rosters written before v0.16.0 carry a per-entry rank and its date. They
    // are dropped here so nothing can read them by accident.
    const { rank, rankAt, ...kept } = entry;
    roster.entries[normalized] = { ...blankEntry(normalized), ...kept };
  }
  return roster;
}

// Per handle, the newer observation wins — the same rule mergeRosterObservation
// applies within a tab, applied again across tabs. A roster is a set of
// sightings, so two tabs holding different sightings must be combined; taking
// one copy whole would throw away whichever XP reads the other tab made.
//
// The viewer's own percentile follows its own timestamp, and xpWraps takes the
// larger so priming cannot restart because a second tab had seen fewer passes.
function mergeRosters(mine, theirs) {
  if (!isPlainObject(theirs) || !isPlainObject(theirs.entries)) return mine;
  if (!isPlainObject(mine)) return theirs;

  const merged = { ...theirs, ...mine };
  merged.entries = { ...theirs.entries };
  for (const [handle, entry] of Object.entries(mine.entries || {})) {
    const other = merged.entries[handle];
    if (!isPlainObject(other)) {
      merged.entries[handle] = entry;
      continue;
    }
    const mineAt = observedNum(entry.profileAt) || 0;
    const theirsAt = observedNum(other.profileAt) || 0;
    merged.entries[handle] = theirsAt > mineAt ? { ...entry, ...other } : { ...other, ...entry };
  }

  const mineSelfAt = observedNum(mine.self?.percentileAt) || 0;
  const theirsSelfAt = observedNum(theirs.self?.percentileAt) || 0;
  if (theirsSelfAt > mineSelfAt) merged.self = theirs.self;

  merged.xpWraps = Math.max(observedNum(mine.xpWraps) || 0, observedNum(theirs.xpWraps) || 0);
  merged.boardSeen = uniqueHandleList([
    ...(Array.isArray(theirs.boardSeen) ? theirs.boardSeen : []),
    ...(Array.isArray(mine.boardSeen) ? mine.boardSeen : []),
  ]).slice(-BOARD_SEEN_MAX);
  // Two tabs each holding a full roster can union to well past capacity.
  pruneRoster(merged);
  return merged;
}

function saveAllTimeRoster() {
  if (!allTimeRoster) return;
  allTimeRoster.updatedAt = Date.now();
  void mergeWrite(ALLTIME_ROSTER_KEY, (stored) => {
    const merged = mergeRosters(allTimeRoster, stored);
    allTimeRoster = merged;
    return merged;
  });
}

// ---------------------------------------------------------------------------
// Intake
// ---------------------------------------------------------------------------
// One entry point for every sighting, whoever asked for it. The router already
// relays /v1/users/public/{h} and /stats for Boot.dev's own profile-page
// traffic, so browsing anyone's profile maintains the board for free.
function noteAllTimeObservation(username, isStats, json) {
  if (!allTimeRoster || !isFeatureEnabled("allTimeLeaderboard")) return;
  const data = json?.data ?? json;
  const handle = normalizeHandle(readField(data, "Handle") || username);
  if (!isValidHandle(handle)) return;

  const now = Date.now();
  let changed = false;

  if (isStats) {
    const rank = readAlltimeRank(json);
    const percentile = readAlltimePercentile(json);
    noteAlltimeRankResponse(rank, percentile);
    if (handle === normalizeHandle(currentUserHandle) && percentile != null) {
      allTimeRoster.self = { ...allTimeRoster.self, handle, percentile, percentileAt: now };
      changed = true;
    }
    // A rank only arrives if Boot.dev restores the field. The viewer's own is
    // kept, because a privately visible own-rank would be the one exact
    // position Catalyst could show; nothing reads it yet.
    if (rank != null && handle === normalizeHandle(currentUserHandle)) {
      allTimeRoster.self = { ...allTimeRoster.self, handle, rank, rankAt: now };
      changed = true;
    }
  } else {
    changed = noteAllTimeProfile(handle, data, now) || changed;
  }

  if (changed) {
    const { newcomers } = noteBoardMembership(allTimeRoster);
    saveAllTimeRoster();
    schedulePersonalLeaderboardRender();
    renderAllTimeLeaderboard();
    announceBoardNewcomers(newcomers);
  }
}

// A profile sighting: refresh XP and display fields for a known entry, or admit
// an unknown one under the admission rule (see admissionThresholdXp).
function noteAllTimeProfile(handle, data, now = Date.now()) {
  const xp = observedNum(readField(data, "XP"));
  if (xp == null) return false;

  const known = Boolean(allTimeRoster.entries[handle]);
  const floor = admissionThresholdXp(allTimeRoster);
  if (!known && floor != null && xp <= floor) return false;

  return applyRosterObservation(allTimeRoster, {
    handle,
    // Keys are Catalyst's own observation shape (see mergeRosterObservation) and
    // stay PascalCase; only the VALUES are API reads.
    Handle: readField(data, "Handle"),
    XP: xp,
    FirstName: readField(data, "FirstName"),
    LastName: readField(data, "LastName"),
    Role: readField(data, "Role"),
    Level: observedNum(readField(data, "Level")),
    ProfileImageURL: getAvatarUrl(data),
    profileAt: now,
    candidate: !known,
  });
}

// Every leaderboard response Catalyst receives is also a batch of XP sightings:
// 25 handles with a full user object. Free freshness for anyone already on the
// board, and the only realistic way a typical install discovers a newcomer.
function noteAllTimeBoardEntries(entries) {
  if (!allTimeRoster || !isFeatureEnabled("allTimeLeaderboard")) return;
  if (!Array.isArray(entries) || !entries.length) return;

  const now = Date.now();
  let changed = false;
  for (const entry of entries) {
    const handle = normalizeHandle(getHandle(entry));
    if (!isValidHandle(handle)) continue;
    changed = noteAllTimeProfile(handle, entry, now) || changed;
  }
  if (changed) {
    const { newcomers } = noteBoardMembership(allTimeRoster);
    saveAllTimeRoster();
    renderAllTimeLeaderboard();
    announceBoardNewcomers(newcomers);
  }
}

// A renamed rank field would freeze every row at its seed value while the board
// still looked healthy — the graceful-degradation failure mode this codebase
// keeps meeting. Warn once after enough responses to be sure.
// The rank's absence is now EXPECTED, so it is not what gets warned about —
// warning on it would fire for every user forever. What is worth a line is the
// percentile also vanishing, which would leave the viewer with no self-position
// at all; and, on the happy side, the rank COMING BACK, which would be worth
// redesigning around.
const ALLTIME_RANK_FIELD_SAMPLE = 3;
let alltimeStatsSeen = 0;
let alltimePercentilesRead = 0;
function noteAlltimeRankResponse(rank, percentile) {
  alltimeStatsSeen += 1;
  if (rank != null) {
    warnOnce(
      "alltime:rank-returned",
      "/v1/users/public/{handle}/stats is serving LeaderboardXPRankAlltime again — " +
      "Boot.dev removed it on 2026-08-20 and the board was rebuilt to order by XP " +
      "alone. An exact position is available again; see allTimeRoster.js."
    );
  }
  if (percentile != null) {
    alltimePercentilesRead += 1;
    return;
  }
  if (alltimePercentilesRead || alltimeStatsSeen < ALLTIME_RANK_FIELD_SAMPLE) return;
  warnOnce(
    "alltime:percentile-field",
    `${alltimeStatsSeen} /v1/users/public/{handle}/stats responses carried no readable ` +
    "LeaderboardXPPercentileAlltime — the All-Time subtitle will show no position for you. " +
    "See readAlltimePercentile() in allTimeRoster.js."
  );
}

// ---------------------------------------------------------------------------
// Student count (/v1/leaderboard_stats)
// ---------------------------------------------------------------------------
// Replaces findTotalStudents(), which read the figure out of a native board's
// rendered subtitle because no API source existed. One does now — and "no API
// source exists" is a claim with a shelf life.
const LEADERBOARD_STATS_KEY = "be_leaderboard_stats";
const LEADERBOARD_STATS_TTL_MS = 6 * 60 * 60 * 1000;
const LEADERBOARD_STATS_URL = "https://api.boot.dev/v1/leaderboard_stats";
let leaderboardStats = { registeredUsers: null, updatedAt: 0 };

async function loadLeaderboardStats() {
  const stored = await chromeGet(LEADERBOARD_STATS_KEY);
  if (enhancerStopped || !isPlainObject(stored)) return;
  leaderboardStats = {
    registeredUsers: observedNum(stored.registeredUsers),
    updatedAt: observedNum(stored.updatedAt) || 0,
  };
}

function handleLeaderboardStats(json) {
  const registeredUsers = readRegisteredUsers(json);
  if (registeredUsers == null) {
    warnOnce(
      "alltime:students-field",
      "/v1/leaderboard_stats answered without a readable RegisteredUsersAlltime — " +
      "the All-Time subtitle will show your position without a total. " +
      "See readRegisteredUsers() in allTimeRoster.js."
    );
    return;
  }
  leaderboardStats = { registeredUsers, updatedAt: Date.now() };
  chromeSet(LEADERBOARD_STATS_KEY, leaderboardStats);
  renderAllTimeLeaderboard();
}

function getTotalStudents() {
  return observedNum(leaderboardStats.registeredUsers);
}

// ---------------------------------------------------------------------------
// New-learner alerts (opt-in)
// ---------------------------------------------------------------------------
// An informational notice when a learner this device found by browsing enters
// the visible board for the first time. Default OFF: news about strangers on a
// board the user did not curate is not something most users want. It carries
// no call to action; sharing a list is what the options page's export is for.
//
// roster.boardSeen holds every handle that has been on the board here, plus
// every handle that arrived in a list. It is kept whether or not alerts are on,
// so switching them on later does not announce the whole board at once, and a
// learner who drops to 26th and climbs back is not news a second time.
const BOARD_SEEN_MAX = 1000;

function uniqueHandleList(handles) {
  return Array.from(new Set(handles.map(normalizeHandle).filter(isValidHandle)));
}

// Record the current top ALLTIME_BOARD_SIZE, plus `fromLists` (handles that
// arrived in a seed, import or fetched list, which are never news). Returns the
// handles reaching the board for the first time; the first call on an empty
// record establishes a baseline and reports none.
function noteBoardMembership(roster, fromLists = []) {
  const seen = Array.isArray(roster.boardSeen) ? roster.boardSeen.slice() : [];
  const seenSet = new Set(seen);
  const baseline = seen.length === 0;
  const mark = (handle) => {
    seenSet.add(handle);
    seen.push(handle);
  };
  for (const handle of uniqueHandleList(fromLists)) {
    if (!seenSet.has(handle)) mark(handle);
  }
  const newcomers = [];
  for (const { position, entry } of deriveBoardPositions(roster).positions) {
    if (position > ALLTIME_BOARD_SIZE) break;
    const handle = normalizeHandle(entry.Handle);
    if (!isValidHandle(handle) || seenSet.has(handle)) continue;
    mark(handle);
    if (!baseline) newcomers.push(handle);
  }
  const changed = seen.length !== (roster.boardSeen?.length || 0);
  roster.boardSeen = seen.slice(-BOARD_SEEN_MAX);
  return { newcomers, changed };
}

function announceBoardNewcomers(handles) {
  if (!handles.length || !isFeatureEnabled("observedBoardAlerts")) return;
  // Reaching the board yourself is not news about someone else.
  const self = normalizeHandle(currentUserHandle);
  const others = handles.filter((handle) => handle !== self);
  if (!others.length) return;
  const describe = (handle) => {
    const xp = observedNum(allTimeRoster?.entries?.[handle]?.XP);
    return xp == null ? `@${handle}` : `@${handle} (${fmtNum(xp)} xp)`;
  };
  const text = others.length === 1
    ? `New on Top Observed Learners: ${describe(others[0])}.`
    : `New on Top Observed Learners: ${others.slice(0, 2).map(describe).join(", ")}` +
      (others.length > 2 ? ` and ${others.length - 2} more.` : ".");
  toast(text);
}

// ---------------------------------------------------------------------------
// Published list (opt-in)
// ---------------------------------------------------------------------------
// The repository publishes a curated list, data/observed-learners.json — the
// same file the bundled seed is built from. With observedListFetch on,
// Catalyst reads it at most once a day and folds it in like an imported list,
// so a newly found top learner reaches users between releases. Default OFF,
// like versionCheck and for the same reason: it is a request somewhere other
// than Boot.dev. It sends nothing; it is one GET of a public file. GitHub's
// REST API answers with Access-Control-Allow-Origin: * (checked 2026-10-04),
// so no host permission is needed.
//
// The file is untrusted input. It goes through the same parser as an import,
// so all it can contribute is handles and numbers, and newest-reading-wins per
// learner means a stale or tampered copy cannot lower a fresher local reading.
const OBSERVED_LIST_URL =
  "https://api.github.com/repos/breaking-boot/catalyst/contents/data/observed-learners.json?ref=main";
const OBSERVED_LIST_STATE_KEY = "be_observed_list_fetch";
const OBSERVED_LIST_INTERVAL_MS = 24 * 60 * 60 * 1000;
let observedListFetchInFlight = false;

async function maybeFetchObservedList(now = Date.now()) {
  if (enhancerStopped || observedListFetchInFlight || !allTimeRoster) return;
  if (!isFeatureEnabled("observedListFetch") || !isFeatureEnabled("allTimeLeaderboard")) return;
  const state = await chromeGet(OBSERVED_LIST_STATE_KEY);
  if (enhancerStopped) return;
  if (now - (observedNum(state?.checkedAt) || 0) < OBSERVED_LIST_INTERVAL_MS) return;

  observedListFetchInFlight = true;
  // Recorded before the request, so a failure waits a day as a success does
  // instead of retrying on every page load.
  await chromeSet(OBSERVED_LIST_STATE_KEY, { ...(isPlainObject(state) ? state : {}), checkedAt: now });
  try {
    const text = await fetchObservedListText();
    // Read after the await: another tab's write may have replaced the roster.
    if (enhancerStopped || !allTimeRoster) return;
    const result = applyObservedLearners(allTimeRoster, text, "published");
    if (result.parsed.error) return;
    noteBoardMembership(allTimeRoster, result.added);
    chromeSet(OBSERVED_LIST_STATE_KEY, {
      checkedAt: now,
      appliedAt: now,
      listGeneratedAt: result.parsed.generatedAt,
      learners: result.parsed.learners.length,
    });
    if (result.changed) {
      saveAllTimeRoster();
      renderAllTimeLeaderboard();
    }
  } catch (err) {
    // Offline, rate-limited, or the file is missing: keep what is held.
    warnOnce("alltime:list-fetch", `Published learner list not fetched: ${safeErrorMessage(err)}`);
  } finally {
    observedListFetchInFlight = false;
  }
}

// The contents API returns the file base64-encoded inside a JSON envelope.
async function fetchObservedListText() {
  const response = await fetch(OBSERVED_LIST_URL, { headers: { accept: "application/vnd.github+json" } });
  if (!response.ok) throw new Error(`GitHub answered ${response.status}`);
  const body = await response.json();
  if (body?.encoding !== "base64" || typeof body.content !== "string") {
    throw new Error("unexpected response from GitHub");
  }
  const binary = atob(body.content.replace(/\s/g, ""));
  return new TextDecoder().decode(Uint8Array.from(binary, (c) => c.charCodeAt(0)));
}

// ---------------------------------------------------------------------------
// Refresh: one budget, spent in priority order
// ---------------------------------------------------------------------------
// ONE hard ceiling rather than a sum of sub-budgets: it is a single number to
// verify in DevTools, and it cannot drift as the queues are tuned. Spent in
// priority order — the student count, the hot ring, then the cold tail — so
// when it binds, the tail is what gets truncated.
// DISCOVERY IS PASSIVE-ONLY SINCE v0.15.1, and that is a platform constraint
// rather than a choice. /v1/leaderboard_xp/{week,month} were the standing
// discovery sweep; both were confirmed returning 400 "Invalid timeframe" on
// 2026-09-19, the same answer `alltime` gave when it was checked on
// 2026-08-14. The date any of them stopped working is unknown. Sixteen
// timeframe names were tried and none answered.
//
// Nothing replaces them. /v1/leaderboard_archmage is alive and lists 30 full
// user objects, but they are the most recent learners to reach level 100 —
// measured XP 427,712-464,145, against 930,102 for the lowest learner the board
// then drew. They could only ever fill the tail, which the native boards on the
// same page already fill, so it is not relayed. The daily board's lifetime-XP
// range that day topped out at 786,594; the all-time karma board reached
// 1,813,156 and is the only remaining board that regularly carries learners
// high enough to reach the board itself.
//
// So an unknown learner enters the roster through the karma board, the daily
// board, a league board, a profile the user opens, a refreshed bundled seed, a
// list imported on the options page, or the opt-in published list. Reaching the
// visible 25 that way
// is slower than it was, which the README states rather than hides: the board
// showing fewer new faces is a consequence of the platform, not a defect.
//
// The route handler for the unavailable timeframes is deliberately KEPT (see
// handleXpDiscoveryBoard in leaderboard.js, and the router in content.js), on
// the same reasoning that kept /v1/leaderboard_xp/alltime: if Boot.dev ever
// restores them, Catalyst picks them up passively with no further change.
//
// The viewer's own XP refresh used to live in this pass too, which coupled it
// to the Observed board being switched on — with that board off, the only
// source for the viewer's own lifetime XP was a league board that may not carry
// them, and every All-Time comparison then had nothing to measure against. It
// is its own request now: see refreshCurrentUserXp in leaderboard.js.

function requestAllTimeRosterRefresh() {
  if (!allTimeRoster || enhancerStopped) return 0;
  if (!isLeaderboardPage() || !isFeatureEnabled("allTimeLeaderboard")) return 0;

  const now = Date.now();
  const priming = !rosterIsPrimed(allTimeRoster);
  if (now - rosterLastPassAt < (priming ? ROSTER_PRIMING_COOLDOWN_MS : ROSTER_REFRESH_COOLDOWN_MS)) return 0;
  rosterLastPassAt = now;

  let budget = ROSTER_REQUEST_CEILING;
  const spend = (fn) => {
    if (budget <= 0) return false;
    budget -= 1;
    fn();
    return true;
  };

  // 1. The student count, which the subtitle's percentile is stated against.
  if (now - (observedNum(leaderboardStats.updatedAt) || 0) >= LEADERBOARD_STATS_TTL_MS) {
    spend(() => requestApiJson(LEADERBOARD_STATS_URL));
  }

  // 2. The XP sweep — the ONLY thing keeping the board correct, since the
  //    ordering is derived from XP alone. Hot ring first, then the cold tail.
  //    Handles the Personal Leaderboards pass already refreshes this load, and
  //    rows still waiting in the display fill, are skipped rather than fetched
  //    twice.
  const skip = [...(anyPersonalBoardEnabled() ? personalHandles : []), ...displayFillQueue];
  const slice = Math.min(priming ? ROSTER_XP_PRIMING_SLICE : ROSTER_XP_SLICE, budget);
  const { targets, cursor, wrapped, coldCursor } = pickXpRefreshTargets(allTimeRoster, {
    slice,
    coldSlice: Math.min(ROSTER_COLD_SLICE, Math.max(0, budget - slice)),
    skip,
    now,
  });
  for (const handle of targets) {
    spend(() => requestApiJson(`https://api.boot.dev/v1/users/public/${encodeURIComponent(handle)}`));
  }
  allTimeRoster.xpCursor = cursor;
  allTimeRoster.coldCursor = coldCursor;
  if (wrapped) allTimeRoster.xpWraps = (observedNum(allTimeRoster.xpWraps) || 0) + 1;
  saveAllTimeRoster();

  return ROSTER_REQUEST_CEILING - budget;
}

// The response is relayed and routed like any other, so it lands back through

// Test hook: scripts/check_alltime_roster.mjs predefines this global before
// evaluating the file. Never defined on the real page.
if (typeof window !== "undefined" && window.__BOOTDEV_ENHANCER_TEST__) {
  window.__BOOTDEV_ENHANCER_TEST__.allTimeRoster = {
    emptyRoster,
    blankEntry,
    rosterIsPrimed,
    mergeRosterObservation,
    applyRosterObservation,
    applySeedToRoster,
    applyObservedLearners,
    mergeRosters,
    normalizeStoredRoster,
    readAlltimeRank,
    readAlltimePercentile,
    readRegisteredUsers,
    admissionThresholdXp,
    rosterCoverage,
    deriveBoardPositions,
    compareByObservedXp,
    buildAllTimeBoardRows,
    pickXpRefreshTargets,
    pickDisplayFillTargets,
    needsDisplayFields,
    noteBoardMembership,
    pruneRoster,
    constants: {
      ALLTIME_BOARD_SIZE,
      ROSTER_MAX_ENTRIES,
      ROSTER_PRUNE_AT,
      ROSTER_HOT_SIZE,
      ROSTER_COLD_SLICE,
      ROSTER_COLD_FRESH_MS,
      ROSTER_XP_SLICE,
      ROSTER_XP_PRIMING_SLICE,
      ROSTER_PRIMING_COOLDOWN_MS,
      ROSTER_REFRESH_COOLDOWN_MS,
      ROSTER_REQUEST_CEILING,
    },
  };
}
