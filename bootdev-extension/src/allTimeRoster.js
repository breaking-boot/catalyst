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
//               value covers lifetime XP from 930,102 to 1,741,426 (measured,
//               probe 13). There is now NO source of an exact position.
//
// So ordering comes from lifetime XP alone, compared between the learners
// Catalyst has actually observed. That is an OBSERVED ranking, not an objective
// one, and the board is named accordingly — a position here means "Nth highest
// XP among those Catalyst knows of", never "Nth on Boot.dev".
//
// The 2026-08-20 ranks are kept as provenance on seeded entries (`rank`,
// `rankAt`). They are not reproducible and are never displayed as current.
// Carry them forward with diagnostics/14_roster_export.js; do not re-probe.

const ALLTIME_ROSTER_KEY = "be_alltime_roster";
const ALLTIME_ROSTER_VERSION = 1;
const ALLTIME_BOARD_SIZE = 25;

// Retained window: the 25 the board draws plus a watchlist underneath, so a
// climber is already tracked before they reach the board. Pruned by XP.
const ROSTER_MAX_ENTRIES = 60;

// XP has no TTL at all: the cursor advances on every leaderboard load, so the
// whole board refreshes over ~5 loads and reloading the page IS a refresh. A
// clock TTL would refresh a board nobody is reading and still be stale the
// moment someone opens it.
// 8, not 6: the week and month XP API timeframes are no longer available
// (confirmed returning 400 "Invalid timeframe" on 2026-09-19) and the two
// requests per pass they used to spend now go here. The per-load ceiling
// below is unchanged.
const ROSTER_XP_SLICE = 8;
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
  return { version: ALLTIME_ROSTER_VERSION, updatedAt: 0, xpCursor: 0, xpWraps: 0, self: {}, entries: {} };
}

// True once the XP cursor has been all the way round at least once, i.e. every
// row has had a chance to be read live rather than inherited from the seed.
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
    rank: null,
    rankAt: 0,
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

  const rankAt = observedNum(observation?.rankAt) || 0;
  const rank = observedNum(observation?.rank);
  if (rank != null && rankAt >= (observedNum(entry.rankAt) || 0)) {
    entry.rank = rank;
    entry.rankAt = rankAt;
  }

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

// Keep the store bounded. Ranked entries always outranked candidates for a slot,
// and among candidates the highest XP wins — those are the ones most likely to
// actually be in the window.
// Keep the highest-XP entries. Ranks no longer exist to prune by, and XP is
// both the ordering signal and the admission signal, so one rule covers it.
// An entry with no XP yet sorts last and is the first to go.
function pruneRoster(roster) {
  const remaining = Object.entries(roster.entries);
  if (remaining.length <= ROSTER_MAX_ENTRIES) return;
  remaining
    .sort((a, b) => (observedNum(b[1].XP) ?? -1) - (observedNum(a[1].XP) ?? -1))
    .slice(ROSTER_MAX_ENTRIES)
    .forEach(([handle]) => delete roster.entries[handle]);
}

// ---------------------------------------------------------------------------
// Seed
// ---------------------------------------------------------------------------
// Applied on EVERY load, not just the first: shipping a fresher seed in a later
// release then upgrades stale rows for free, while a user whose own data is
// newer keeps it (merge rule above).
function applySeedToRoster(roster, seed = typeof ALLTIME_SEED === "undefined" ? null : ALLTIME_SEED) {
  if (!isPlainObject(roster) || !isPlainObject(seed) || !Array.isArray(seed.entries)) return false;
  const observedAt = Date.parse(seed.generatedAt);
  if (!Number.isFinite(observedAt)) return false;

  let changed = false;
  for (const raw of seed.entries) {
    const handle = normalizeHandle(raw?.handle);
    if (!isValidHandle(handle) || observedNum(raw?.rank) == null) continue;
    // A seed exported from a live roster (diagnostics/14_roster_export.js)
    // carries the date each rank was actually confirmed, which is older than the
    // export. Honour it — claiming the export date would silently make a
    // months-old position look freshly verified, and ranks can no longer be
    // re-checked to correct that.
    const rankAt = Date.parse(raw.rankAt);
    changed = applyRosterObservation(roster, {
      handle,
      Handle: raw.handle,
      rank: observedNum(raw.rank),
      rankAt: Number.isFinite(rankAt) ? rankAt : observedAt,
      XP: observedNum(raw.xp),
      FirstName: raw.firstName,
      LastName: raw.lastName,
      Role: raw.role,
      Level: observedNum(raw.level),
      ProfileImageURL: raw.profileImageURL,
      profileAt: observedAt,
      source: "seed",
      candidate: true,
    }) || changed;
  }
  return changed;
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
// Admission floor is the XP of the DEEPEST position retained (rank 30 against
// the bundled seed), not rank 25's: the watchlist keeps refilling and a climber
// is spotted before they arrive rather than after. XP only grows, and the
// stored floor is itself slightly stale, so this over-admits — the safe
// direction, since a false candidate costs one /stats and is then evicted.
// The XP a newcomer must beat to be worth tracking: the lowest XP among the
// entries currently retained. Sitting below the retained window rather than
// below the rendered board means a climber is picked up before they arrive,
// and the watchlist keeps refilling from underneath.
function admissionThresholdXp(roster) {
  let floor = null;
  for (const entry of Object.values(roster?.entries || {})) {
    const xp = observedNum(entry.XP);
    if (xp == null) continue;
    if (floor == null || xp < floor) floor = xp;
  }
  return floor;
}

// True while some position in 1..25 has no known occupant. Drives both the gap
// rows and the week/month escalation.
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
// XP is refreshed far more often than rank, and rank order tracks XP order (0
// inversions across 45 handles), so the fresher field can carry the ordering
// and the rank lookup becomes verification plus an absolute anchor.
//
// It is only sound if no UNKNOWN person sits inside the window, and that is
// checkable rather than assumable: exactly rank-1 people are above a verified
// anchor, so if the count of known entries with more XP equals rank-1, every
// position above it is accounted for. An unknown at, say, 20 would occupy one
// of the 24 places above a verified #25, leaving at most 23 of ours — which the
// count catches. Short by n means exactly n unknowns, and the board falls back
// to per-entry stored ranks with gaps.
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
    rankAt: observedNum(entry.rankAt) || 0,
    profileAt: observedNum(entry.profileAt) || 0,
    isCurrentUser: Boolean(handle) && handle === normalizeHandle(selfHandle),
    href: handle ? `/u/${encodeURIComponent(handle)}` : "",
  };
}

// ---------------------------------------------------------------------------
// Overtake detection
// ---------------------------------------------------------------------------
// Queue A — XP, round-robin, driven by page loads rather than a clock, so the
// work lands where the attention is and an F5 is a refresh. `skip` carries the
// handles the Personal Leaderboards pass already covered this load, so an
// overlapping handle is not fetched twice.
//
// Walks in the board's own order — highest XP first — so the rows a reader is
// most likely to be looking at refresh earliest in a sweep.
function pickXpRefreshTargets(roster, { slice = ROSTER_XP_SLICE, skip = [], now = Date.now() } = {}) {
  const ordered = Object.values(roster?.entries || {}).sort(compareByObservedXp);
  if (!ordered.length) return { targets: [], cursor: 0, wrapped: false };

  const skipSet = new Set(skip.map(normalizeHandle));
  const start = clamp(observedNum(roster.xpCursor) || 0, 0, Math.max(0, ordered.length - 1));
  const targets = [];
  let cursor = start;
  let wrapped = false;

  for (let step = 0; step < ordered.length && targets.length < slice; step++) {
    const entry = ordered[(start + step) % ordered.length];
    // The cursor advances whether or not this entry is requested, which is what
    // guarantees the wrap — and so guarantees priming terminates.
    if (start + step + 1 >= ordered.length) wrapped = true;
    cursor = (start + step + 1) % ordered.length;
    const handle = normalizeHandle(entry.Handle);
    if (!handle || skipSet.has(handle)) continue;
    // Already covered by a sighting moments ago — costs a slot nothing.
    if (now - (observedNum(entry.profileAt) || 0) < ROSTER_RECENT_SIGHTING_MS) continue;
    targets.push(handle);
  }

  return { targets, cursor, wrapped };
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
  changed = applySeedToRoster(allTimeRoster) || changed;
  if (changed) saveAllTimeRoster();
}

function normalizeStoredRoster(stored) {
  const roster = emptyRoster();
  if (!isPlainObject(stored)) return roster;
  roster.updatedAt = observedNum(stored.updatedAt) || 0;
  roster.xpCursor = observedNum(stored.xpCursor) || 0;
  roster.xpWraps = observedNum(stored.xpWraps) || 0;
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
    roster.entries[normalized] = { ...blankEntry(normalized), ...entry };
  }
  return roster;
}

function saveAllTimeRoster() {
  if (!allTimeRoster) return;
  allTimeRoster.updatedAt = Date.now();
  chromeSet(ALLTIME_ROSTER_KEY, allTimeRoster);
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
    // A rank only arrives if Boot.dev restores the field. Stored as provenance
    // if it does; nothing depends on it.
    if (rank != null) {
      if (handle === normalizeHandle(currentUserHandle)) {
        allTimeRoster.self = { ...allTimeRoster.self, handle, rank, rankAt: now };
        changed = true;
      }
      changed = applyRosterObservation(allTimeRoster, { handle, Handle: readField(data, "Handle"), rank, rankAt: now }) || changed;
    }
  } else {
    changed = noteAllTimeProfile(handle, data, now) || changed;
  }

  if (changed) {
    saveAllTimeRoster();
    schedulePersonalLeaderboardRender();
    renderAllTimeLeaderboard();
  }
}

// A profile sighting: refresh XP and display fields for a known entry, or admit
// an unknown one that clears the admission floor. The overtake check runs here
// because this is where a value read NOW is available to compare against.
function noteAllTimeProfile(handle, data, now = Date.now()) {
  const xp = observedNum(readField(data, "XP"));
  if (xp == null) return false;

  const known = Boolean(allTimeRoster.entries[handle]);
  const floor = admissionThresholdXp(allTimeRoster);
  if (!known && (floor == null || xp < floor)) return false;

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
    saveAllTimeRoster();
    renderAllTimeLeaderboard();
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
// Refresh: two queues, one budget
// ---------------------------------------------------------------------------
// ONE hard ceiling rather than a sum of sub-budgets: it is a single number to
// verify in DevTools, and it cannot drift as the queues are tuned. Spent in
// priority order, so when it binds the gap-closing work survives and the XP
// sweep is what gets truncated.
// DISCOVERY IS PASSIVE-ONLY SINCE v0.15.1, and that is a platform constraint
// rather than a choice. /v1/leaderboard_xp/{week,month} were the standing
// discovery sweep; both were confirmed returning 400 "Invalid timeframe" on
// 2026-09-19, the same answer `alltime` gave when it was checked on
// 2026-08-14. The date any of them stopped working is unknown. Sixteen
// timeframe names were tried and none answered.
//
// Nothing replaces them. /v1/leaderboard_archmage is alive and lists 30 full
// user objects, but they are the most recent learners to reach level 100 —
// measured XP 427,712-464,145 against an admission floor (the lowest XP the
// roster already holds) of 930,102. Not one would be admitted, so relaying it
// would cost nothing and add nothing. The daily board's own lifetime-XP range
// that day topped out at 786,594, also below the floor; the all-time karma
// board reached 1,813,156 and is the only remaining board that regularly
// carries learners this one could admit.
//
// So an unknown learner now enters the roster through the karma board, the
// daily board, a profile the user opens, or a refreshed bundled seed. That is
// slower than it was. It is stated in the README rather than hidden, because
// the board showing fewer new faces is a consequence of the platform and not a
// defect to chase.
//
// The route handler for the unavailable timeframes is deliberately KEPT (see
// handleXpDiscoveryBoard in leaderboard.js, and the router in content.js), on
// the same reasoning that kept /v1/leaderboard_xp/alltime: if Boot.dev ever
// restores them, Catalyst picks them up passively with no further change.
const ALLTIME_SELF_PROFILE_TTL_MS = 10 * 60 * 1000;
let alltimeSelfProfileAt = 0;

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

  // 1. My own XP, which the All-Time comparisons are measured against.
  const selfHandle = normalizeHandle(currentUserHandle);
  if (selfHandle && now - alltimeSelfProfileAt >= ALLTIME_SELF_PROFILE_TTL_MS) {
    if (spend(() => requestApiJson(`https://api.boot.dev/v1/users/public/${encodeURIComponent(selfHandle)}`))) {
      alltimeSelfProfileAt = now;
    }
  }

  // 2. The student count, which the subtitle's percentile is stated against.
  if (now - (observedNum(leaderboardStats.updatedAt) || 0) >= LEADERBOARD_STATS_TTL_MS) {
    spend(() => requestApiJson(LEADERBOARD_STATS_URL));
  }

  // 3. The XP sweep — now the ONLY thing keeping the board correct, since the
  //    ordering is derived from XP alone. Handles the Personal Leaderboards
  //    pass already refreshes this load are skipped rather than fetched twice.
  const skip = anyPersonalBoardEnabled() ? personalHandles : [];
  const { targets, cursor, wrapped } = pickXpRefreshTargets(allTimeRoster, {
    slice: Math.min(priming ? ROSTER_XP_PRIMING_SLICE : ROSTER_XP_SLICE, budget),
    skip,
    now,
  });
  for (const handle of targets) {
    spend(() => requestApiJson(`https://api.boot.dev/v1/users/public/${encodeURIComponent(handle)}`));
  }
  allTimeRoster.xpCursor = cursor;
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
    readAlltimeRank,
    readAlltimePercentile,
    readRegisteredUsers,
    admissionThresholdXp,
    rosterCoverage,
    deriveBoardPositions,
    compareByObservedXp,
    buildAllTimeBoardRows,
    pickXpRefreshTargets,
    constants: {
      ALLTIME_BOARD_SIZE,
      ROSTER_MAX_ENTRIES,
      ROSTER_XP_SLICE,
      ROSTER_XP_PRIMING_SLICE,
      ROSTER_PRIMING_COOLDOWN_MS,
      ROSTER_REFRESH_COOLDOWN_MS,
      ROSTER_REQUEST_CEILING,
    },
  };
}
