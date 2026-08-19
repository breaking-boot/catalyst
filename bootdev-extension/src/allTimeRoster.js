// allTimeRoster.js
// The data half of the Top All-Time Learners board: what Catalyst knows about
// the highest-ranked learners, how it learns it, and how the board's positions
// are worked out. leaderboard.js owns the rendering.
//
// WHY THIS EXISTS: /v1/leaderboard_xp/alltime was removed on 2026-08-14 (400
// "Invalid timeframe"; 23 period names probed) and nothing lists the top 25 any
// more. Per-user rank survives at /v1/users/public/{h}/stats ->
// LeaderboardXPRankAlltime (45 of 45 handles resolved, cookie auth alone), so
// the board became a ROSTER problem: keep a list of handles, learn each one's
// true rank, and say so honestly where a position is unknown.
//
// Two fields, two very different refresh needs:
//   rank  <- /v1/users/public/{h}/stats     positions are sticky, rarely worth a request
//   XP    <- /v1/users/public/{h}, or ANY leaderboard entry
//                                          moves daily, and is printed on every row
// Hence two queues (see pickXpRefreshTargets / pickRankRefreshTargets) and the
// XP-ordering derivation in deriveBoardPositions.

const ALLTIME_ROSTER_KEY = "be_alltime_roster";
const ALLTIME_ROSTER_VERSION = 1;
const ALLTIME_BOARD_SIZE = 25;

// Retained window. 25 for the board plus a near-miss watchlist: an entry that
// drops out is the earliest sign of drift, and one that climbs in is already
// known when it arrives. A resolved rank past this is evicted on the response
// that revealed it, so discovery cannot grow the store without bound.
const ROSTER_RANK_LIMIT = 40;
const ROSTER_MAX_ENTRIES = 60;
const ROSTER_CANDIDATE_MAX = 12;

// Rank TTLs, banded by position. Change enters at the bottom of the board and
// cascades upward in number, so the boundary is where every change first
// becomes visible; the top ten essentially never reorder. These are the
// BACKSTOP — the detector is detectOvertakes(), which raises a suspect the
// moment fresher XP proves somebody moved.
const ROSTER_BOUNDARY_FROM_RANK = 22;
const RANK_TTL_BOUNDARY_MS = 4 * 60 * 60 * 1000;
const RANK_TTL_MID_MS = 48 * 60 * 60 * 1000;
const RANK_TTL_TOP_MS = 7 * 24 * 60 * 60 * 1000;

// XP has no TTL at all: the cursor advances on every leaderboard load, so the
// whole board refreshes over ~5 loads and reloading the page IS a refresh. A
// clock TTL would refresh a board nobody is reading and still be stale the
// moment someone opens it.
const ROSTER_XP_SLICE = 6;
const ROSTER_RANK_SLICE = 3;
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

// A verified-mode board is only as trustworthy as the rank observation
// anchoring it. Past this the anchor could have been overtaken unnoticed, so
// the board falls back to per-entry stored ranks.
const ROSTER_ANCHOR_MAX_AGE_MS = 36 * 60 * 60 * 1000;

let allTimeRoster = null;
// Handles whose stored rank is contradicted by fresher XP. Session-only: a
// suspicion is cheap to re-derive and must never outlive the data behind it.
let rosterRankSuspects = new Set();
let rosterLastPassAt = 0;

function emptyRoster() {
  return { version: ALLTIME_ROSTER_VERSION, updatedAt: 0, xpCursor: 0, xpWraps: 0, self: {}, entries: {} };
}

// True once the XP cursor has been all the way round at least once, i.e. every
// row has had a chance to be read live rather than inherited from the seed.
// A replacement seed in a later release does NOT un-prime the roster: that seed
// is fresh at release time, so there is nothing to catch up on.
function rosterIsPrimed(roster) {
  return (rosterNum(roster?.xpWraps) || 0) >= 1;
}

// num(null) is 0 — a documented trap in this codebase (it already made the boss
// panel's alert floor unreachable in v0.14.0). Here null means "not known yet",
// and reading it as 0 put unranked candidates at rank 0 and dropped the
// admission floor to zero XP, which would have admitted the entire karma board.
// Every rank / XP / level read in this file goes through this instead.
function rosterNum(value) {
  return value == null ? null : num(value);
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
// permanently wrong row, which is far worse than the one spurious overtake a
// decrease can cause — and that self-corrects through the rank check it
// triggers.
function mergeRosterObservation(existing, observation) {
  const handle = normalizeHandle(observation?.handle || existing?.Handle);
  if (!handle) return existing || null;

  const entry = isPlainObject(existing) ? { ...existing } : blankEntry(handle);
  entry.Handle = observation?.Handle || entry.Handle || handle;

  const rankAt = rosterNum(observation?.rankAt) || 0;
  const rank = rosterNum(observation?.rank);
  if (rank != null && rankAt >= (rosterNum(entry.rankAt) || 0)) {
    entry.rank = rank;
    entry.rankAt = rankAt;
  }

  const profileAt = rosterNum(observation?.profileAt) || 0;
  if (profileAt >= (rosterNum(entry.profileAt) || 0)) {
    const xp = rosterNum(observation?.XP);
    if (xp != null) {
      entry.XP = xp;
      entry.profileAt = profileAt;
    }
    for (const field of ["FirstName", "LastName", "Role", "ProfileImageURL"]) {
      if (observation?.[field] != null && observation[field] !== "") entry[field] = observation[field];
    }
    const level = rosterNum(observation?.Level);
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

  const rank = rosterNum(observation?.rank);
  const existing = roster.entries[handle];

  // A resolved rank outside the window is the eviction path — including the
  // one a staff XP reduction can cause.
  if (rank != null && rank > ROSTER_RANK_LIMIT) {
    if (!existing) return false;
    delete roster.entries[handle];
    return true;
  }

  // An unknown handle only earns a slot if it has a rank in the window, or
  // enough XP to plausibly be in it (a candidate — see noteAllTimeCandidates).
  if (!existing && rank == null && !observation?.candidate) return false;

  const merged = mergeRosterObservation(existing, observation);
  if (!merged) return false;
  if (existing && JSON.stringify(existing) === JSON.stringify(merged)) return false;

  roster.entries[handle] = merged;
  pruneRoster(roster);
  return true;
}

// Keep the store bounded. Ranked entries always outrank candidates for a slot,
// and among candidates the highest XP wins — those are the ones most likely to
// actually be in the window.
function pruneRoster(roster) {
  const entries = Object.entries(roster.entries);
  const candidates = entries.filter(([, e]) => rosterNum(e.rank) == null);
  if (candidates.length > ROSTER_CANDIDATE_MAX) {
    candidates
      .sort((a, b) => (rosterNum(b[1].XP) || 0) - (rosterNum(a[1].XP) || 0))
      .slice(ROSTER_CANDIDATE_MAX)
      .forEach(([handle]) => delete roster.entries[handle]);
  }

  const remaining = Object.entries(roster.entries);
  if (remaining.length <= ROSTER_MAX_ENTRIES) return;
  remaining
    .sort((a, b) => (rosterNum(a[1].rank) ?? Number.MAX_SAFE_INTEGER) - (rosterNum(b[1].rank) ?? Number.MAX_SAFE_INTEGER))
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
    if (!isValidHandle(handle) || rosterNum(raw?.rank) == null) continue;
    changed = applyRosterObservation(roster, {
      handle,
      Handle: raw.handle,
      rank: rosterNum(raw.rank),
      rankAt: observedAt,
      XP: rosterNum(raw.xp),
      FirstName: raw.firstName,
      LastName: raw.lastName,
      Role: raw.role,
      Level: rosterNum(raw.level),
      ProfileImageURL: raw.profileImageURL,
      profileAt: observedAt,
      source: "seed",
    }) || changed;
  }
  return changed;
}

// Ranks Catalyst already has on disk from the Personal Leaderboards cache
// (refreshPersonalStats stores whole /stats objects). Free, and occasionally
// contributes a handle the seed lacks.
//
// rankAt is 0, not record.updatedAt: that timestamp means "last time anything
// in the record changed", not "when the rank was read", so treating it as
// freshness would be a fabricated observation time. Zero means oldest possible
// — it never beats the seed, and it sorts first in the refresh queue.
function bootstrapRosterFromPersonalRecords(roster, records) {
  if (!isPlainObject(roster) || !isPlainObject(records)) return false;
  let changed = false;
  for (const [handle, record] of Object.entries(records)) {
    const rank = readAlltimeRank(record?.stats);
    if (rank == null) continue;
    changed = applyRosterObservation(roster, {
      handle: normalizeHandle(handle),
      rank,
      rankAt: 0,
      source: "bootstrap",
    }) || changed;
  }
  return changed;
}

// ---------------------------------------------------------------------------
// Field reads
// ---------------------------------------------------------------------------
// Both readers unwrap `data` first, because /stats is wrapped and
// /v1/leaderboard_stats was captured bare — and either could gain or lose the
// wrapper without warning.
//
// The rank goes through the shared alias table (utils.js), which carries the
// measured camel spelling `leaderboardXPRankAlltime`. A rank that silently
// stopped resolving would freeze every row at its seed value while the board
// still looked healthy, which is what reportAlltimeRankField watches for.
function readAlltimeRank(json) {
  const data = json?.data ?? json;
  if (!isPlainObject(data)) return null;
  return rosterNum(readField(data, "LeaderboardXPRankAlltime"));
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
    if (key.toLowerCase() === "registeredusersalltime") return rosterNum(value);
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
function admissionThresholdXp(roster) {
  let floor = null;
  for (const entry of Object.values(roster?.entries || {})) {
    if (rosterNum(entry.rank) == null) continue;
    const xp = rosterNum(entry.XP);
    if (xp == null) continue;
    if (floor == null || xp < floor) floor = xp;
  }
  return floor;
}

// True while some position in 1..25 has no known occupant. Drives both the gap
// rows and the week/month escalation.
function rosterCoverage(roster) {
  const covered = new Set();
  for (const entry of Object.values(roster?.entries || {})) {
    const rank = rosterNum(entry.rank);
    if (rank != null && rank >= 1 && rank <= ALLTIME_BOARD_SIZE) covered.add(rank);
  }
  return covered.size;
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
function deriveBoardPositions(roster, now = Date.now()) {
  const entries = Object.values(roster?.entries || {}).filter((e) => rosterNum(e.XP) != null);

  const anchor = entries
    .filter((e) => rosterNum(e.rank) != null && rosterNum(e.rank) <= ALLTIME_BOARD_SIZE)
    .filter((e) => now - (rosterNum(e.rankAt) || 0) <= ROSTER_ANCHOR_MAX_AGE_MS)
    .sort((a, b) => rosterNum(b.rank) - rosterNum(a.rank))[0];

  if (anchor) {
    const anchorXp = rosterNum(anchor.XP);
    const above = entries.filter((e) => e !== anchor && rosterNum(e.XP) > anchorXp);
    if (above.length === rosterNum(anchor.rank) - 1) {
      const ordered = [...above, anchor].sort((a, b) => rosterNum(b.XP) - rosterNum(a.XP));
      const below = entries
        .filter((e) => e !== anchor && rosterNum(e.XP) <= anchorXp)
        .sort((a, b) => rosterNum(b.XP) - rosterNum(a.XP));
      return {
        mode: "verified",
        positions: [...ordered, ...below].map((entry, index) => ({ entry, position: index + 1 })),
      };
    }
  }

  return {
    mode: "fallback",
    positions: entries
      .filter((e) => rosterNum(e.rank) != null)
      .sort((a, b) => rosterNum(a.rank) - rosterNum(b.rank) || (rosterNum(b.rankAt) || 0) - (rosterNum(a.rankAt) || 0))
      .map((entry) => ({ entry, position: rosterNum(entry.rank) })),
  };
}

// A gap's role frame, derived rather than assumed. Whoever holds position N
// outranks the nearest known learner below it, so they cannot be a lower tier —
// this is a lower bound Catalyst can justify, not a guess about who they are.
// Resolves to Archmage for every slot today (the board's floor is 963,435 XP,
// level 151) and stays correct on its own if the level curve or role set moves.
function gapRoleForPosition(placed, position) {
  const below = placed
    .filter((p) => p.position > position && p.entry?.Role)
    .sort((a, b) => a.position - b.position)[0];
  if (below) return below.entry.Role;

  const lowest = placed
    .filter((p) => p.entry?.Role)
    .sort((a, b) => b.position - a.position)[0];
  return lowest ? lowest.entry.Role : "";
}

// The board: 25 fixed slots, a real row where a position is known and a gap row
// where it is not. Never fabricates a name, an XP figure or a handle.
function buildAllTimeBoardRows(roster, selfHandle = "") {
  const { mode, positions } = deriveBoardPositions(roster);
  const bySlot = new Map();
  for (const placed of positions) {
    if (placed.position < 1 || placed.position > ALLTIME_BOARD_SIZE) continue;
    if (!bySlot.has(placed.position)) bySlot.set(placed.position, []);
    bySlot.get(placed.position).push(placed);
  }

  const rows = [];
  for (let position = 1; position <= ALLTIME_BOARD_SIZE; position++) {
    const claimants = (bySlot.get(position) || [])
      // Fresher rank observation first: in fallback mode two entries can
      // legitimately claim one position, and the newer sighting is the better
      // guess at which of them still holds it.
      .sort((a, b) => (rosterNum(b.entry.rankAt) || 0) - (rosterNum(a.entry.rankAt) || 0));

    if (!claimants.length) {
      rows.push({ key: `gap:${position}`, gap: true, position, role: gapRoleForPosition(positions, position) });
      continue;
    }
    for (const claimant of claimants) {
      rows.push(rosterRow(claimant.entry, position, selfHandle));
    }
  }

  // The viewer, when they rank below the board. Appended rather than displacing
  // a known learner: the board is knowledge-bounded now, and hiding something
  // real to make room is the wrong trade.
  const selfRank = rosterNum(roster?.self?.rank);
  const selfNormalized = normalizeHandle(selfHandle || roster?.self?.handle);
  if (selfRank != null && selfRank > ALLTIME_BOARD_SIZE && selfNormalized) {
    const entry = roster?.entries?.[selfNormalized] || { ...blankEntry(selfNormalized), Handle: selfNormalized };
    rows.push({ ...rosterRow(entry, selfRank, selfNormalized), outsideBoard: true });
  }

  return { mode, rows, coverage: bySlot.size };
}

function rosterRow(entry, position, selfHandle) {
  const handle = normalizeHandle(entry.Handle);
  return {
    key: handle || `slot:${position}`,
    gap: false,
    position,
    entry,
    handle,
    xp: rosterNum(entry.XP),
    rankAt: rosterNum(entry.rankAt) || 0,
    profileAt: rosterNum(entry.profileAt) || 0,
    isCurrentUser: Boolean(handle) && handle === normalizeHandle(selfHandle),
    href: handle ? `/u/${encodeURIComponent(handle)}` : "",
  };
}

// ---------------------------------------------------------------------------
// Overtake detection
// ---------------------------------------------------------------------------
// Comparing XP values of different ages is safe in ONE direction only, and only
// that direction is used. XP is a lower bound on the true figure (staff
// reductions aside), so a stored value that already exceeds a FRESHLY READ one
// proves the true order. The reverse proves nothing — the stale side may have
// grown past it since — so it raises nothing.
//
// Called with a value read in this pass: anyone stored ABOVE that handle with
// less XP than its fresh figure has been overtaken. Conservative by
// construction: no false positives, only late ones, which the next pass finds.
function detectOvertakes(roster, handle, freshXp) {
  const normalized = normalizeHandle(handle);
  const subject = roster?.entries?.[normalized];
  const xp = rosterNum(freshXp);
  const subjectRank = rosterNum(subject?.rank);
  if (!subject || xp == null || subjectRank == null) return [];

  const overtaken = [];
  for (const [otherHandle, other] of Object.entries(roster.entries)) {
    if (otherHandle === normalized) continue;
    const otherRank = rosterNum(other.rank);
    const otherXp = rosterNum(other.XP);
    if (otherRank == null || otherXp == null) continue;
    if (otherRank < subjectRank && otherXp < xp) overtaken.push(otherHandle);
  }
  return overtaken.length ? [normalized, ...overtaken] : [];
}

// ---------------------------------------------------------------------------
// Refresh queues
// ---------------------------------------------------------------------------
// Queue A — XP, round-robin, driven by page loads rather than a clock, so the
// work lands where the attention is and an F5 is a refresh. `skip` carries the
// handles the Personal Leaderboards pass already covered this load, so an
// overlapping handle is not fetched twice.
function pickXpRefreshTargets(roster, { slice = ROSTER_XP_SLICE, skip = [], now = Date.now() } = {}) {
  const ordered = Object.values(roster?.entries || {})
    .sort((a, b) => (rosterNum(a.rank) ?? Number.MAX_SAFE_INTEGER) - (rosterNum(b.rank) ?? Number.MAX_SAFE_INTEGER));
  if (!ordered.length) return { targets: [], cursor: 0, wrapped: false };

  const skipSet = new Set(skip.map(normalizeHandle));
  const start = clamp(rosterNum(roster.xpCursor) || 0, 0, Math.max(0, ordered.length - 1));
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
    if (now - (rosterNum(entry.profileAt) || 0) < ROSTER_RECENT_SIGHTING_MS) continue;
    targets.push(handle);
  }

  return { targets, cursor, wrapped };
}

// Queue B — rank. Event-driven first: candidates close a gap, and a suspect
// means fresher XP PROVED something moved. The TTL bands are the backstop.
function pickRankRefreshTargets(roster, { slice = ROSTER_RANK_SLICE, suspects = [], now = Date.now() } = {}) {
  const suspectSet = new Set([...suspects].map(normalizeHandle));
  const scored = [];

  for (const [handle, entry] of Object.entries(roster?.entries || {})) {
    const rank = rosterNum(entry.rank);
    const rankAt = rosterNum(entry.rankAt) || 0;
    if (rank == null) {
      scored.push({ handle, tier: 0, rankAt });
      continue;
    }
    if (suspectSet.has(handle)) {
      scored.push({ handle, tier: 1, rankAt });
      continue;
    }
    const age = now - rankAt;
    if (rank >= ROSTER_BOUNDARY_FROM_RANK) {
      if (age >= RANK_TTL_BOUNDARY_MS) scored.push({ handle, tier: 2, rankAt });
    } else if (rank >= 11) {
      if (age >= RANK_TTL_MID_MS) scored.push({ handle, tier: 3, rankAt });
    } else if (age >= RANK_TTL_TOP_MS) {
      scored.push({ handle, tier: 4, rankAt });
    }
  }

  // Tiers are returned rather than flattened so the caller can spend the
  // per-load request ceiling in priority order: a candidate or a proven
  // suspect is worth a request before anything else this feature does.
  return scored
    .sort((a, b) => a.tier - b.tier || a.rankAt - b.rankAt)
    .slice(0, slice)
    .map(({ handle, tier }) => ({ handle, tier }));
}

// ---------------------------------------------------------------------------
// Storage
// ---------------------------------------------------------------------------
async function loadAllTimeRoster(personalRecords = null) {
  const stored = await chromeGet(ALLTIME_ROSTER_KEY);
  if (enhancerStopped) return;

  allTimeRoster = normalizeStoredRoster(stored);
  let changed = !isPlainObject(stored);
  if (isPlainObject(personalRecords)) {
    changed = bootstrapRosterFromPersonalRecords(allTimeRoster, personalRecords) || changed;
  }
  changed = applySeedToRoster(allTimeRoster) || changed;
  if (changed) saveAllTimeRoster();
}

function normalizeStoredRoster(stored) {
  const roster = emptyRoster();
  if (!isPlainObject(stored)) return roster;
  roster.updatedAt = rosterNum(stored.updatedAt) || 0;
  roster.xpCursor = rosterNum(stored.xpCursor) || 0;
  roster.xpWraps = rosterNum(stored.xpWraps) || 0;
  if (isPlainObject(stored.self)) {
    roster.self = {
      handle: normalizeHandle(stored.self.handle),
      rank: rosterNum(stored.self.rank),
      rankAt: rosterNum(stored.self.rankAt) || 0,
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
    noteAlltimeRankResponse(rank);
    if (rank != null) {
      if (handle === normalizeHandle(currentUserHandle)) {
        allTimeRoster.self = { handle, rank, rankAt: now };
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
  const xp = rosterNum(readField(data, "XP"));
  if (xp == null) return false;

  const known = Boolean(allTimeRoster.entries[handle]);
  const floor = admissionThresholdXp(allTimeRoster);
  if (!known && (floor == null || xp < floor)) return false;

  const suspects = known ? detectOvertakes(allTimeRoster, handle, xp) : [];
  for (const suspect of suspects) rosterRankSuspects.add(suspect);

  return applyRosterObservation(allTimeRoster, {
    handle,
    // Keys are Catalyst's own observation shape (see mergeRosterObservation) and
    // stay PascalCase; only the VALUES are API reads.
    Handle: readField(data, "Handle"),
    XP: xp,
    FirstName: readField(data, "FirstName"),
    LastName: readField(data, "LastName"),
    Role: readField(data, "Role"),
    Level: rosterNum(readField(data, "Level")),
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
const ALLTIME_RANK_FIELD_SAMPLE = 3;
let alltimeStatsSeen = 0;
let alltimeRanksRead = 0;
function noteAlltimeRankResponse(rank) {
  alltimeStatsSeen += 1;
  if (rank != null) {
    alltimeRanksRead += 1;
    return;
  }
  if (alltimeRanksRead || alltimeStatsSeen < ALLTIME_RANK_FIELD_SAMPLE) return;
  warnOnce(
    "alltime:rank-field",
    `${alltimeStatsSeen} /v1/users/public/{handle}/stats responses carried no readable ` +
    "LeaderboardXPRankAlltime — Boot.dev may have renamed it, and the All-Time board is " +
    "frozen at whatever it already knew. See readAlltimeRank() in allTimeRoster.js."
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
    registeredUsers: rosterNum(stored.registeredUsers),
    updatedAt: rosterNum(stored.updatedAt) || 0,
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
  return rosterNum(leaderboardStats.registeredUsers);
}

// ---------------------------------------------------------------------------
// Refresh: two queues, one budget
// ---------------------------------------------------------------------------
// ONE hard ceiling rather than a sum of sub-budgets: it is a single number to
// verify in DevTools, and it cannot drift as the queues are tuned. Spent in
// priority order, so when it binds the gap-closing work survives and the XP
// sweep is what gets truncated.
const ALLTIME_DISCOVERY_URLS = [
  "https://api.boot.dev/v1/leaderboard_xp/week",
  "https://api.boot.dev/v1/leaderboard_xp/month",
];
const ALLTIME_DISCOVERY_TTL_MS = 60 * 60 * 1000;
const ALLTIME_SELF_PROFILE_TTL_MS = 10 * 60 * 1000;
let alltimeDiscoveryAt = 0;
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

  const rankTargets = pickRankRefreshTargets(allTimeRoster, { suspects: rosterRankSuspects, now });

  // 1. Candidates and proven suspects — a request that closes a gap or
  //    confirms a move is worth more than any amount of routine freshness.
  for (const target of rankTargets.filter((t) => t.tier <= 1)) {
    spend(() => refreshRosterRank(target.handle));
  }

  // 2. The week/month boards, only while a position is unknown. Someone
  //    climbing into the top 25 is earning heavily right now, which is exactly
  //    what puts them on those boards — and the one measured new entrant was
  //    found on the month board.
  if (rosterCoverage(allTimeRoster) < ALLTIME_BOARD_SIZE && now - alltimeDiscoveryAt >= ALLTIME_DISCOVERY_TTL_MS) {
    alltimeDiscoveryAt = now;
    for (const url of ALLTIME_DISCOVERY_URLS) spend(() => requestApiJson(url));
  }

  // 3. The boundary. Any new entrant anywhere in 1-25 pushes the incumbent #25
  //    out to 26, so this doubles as a whole-board change detector.
  for (const target of rankTargets.filter((t) => t.tier === 2)) {
    spend(() => refreshRosterRank(target.handle));
  }

  // 4. My own XP, which the All-Time comparisons are measured against.
  const selfHandle = normalizeHandle(currentUserHandle);
  if (selfHandle && now - alltimeSelfProfileAt >= ALLTIME_SELF_PROFILE_TTL_MS) {
    if (spend(() => requestApiJson(`https://api.boot.dev/v1/users/public/${encodeURIComponent(selfHandle)}`))) {
      alltimeSelfProfileAt = now;
    }
  }

  // 5. The student count.
  if (now - (rosterNum(leaderboardStats.updatedAt) || 0) >= LEADERBOARD_STATS_TTL_MS) {
    spend(() => requestApiJson(LEADERBOARD_STATS_URL));
  }

  // 6. The XP sweep. Handles the Personal Leaderboards pass already refreshes
  //    this load are skipped rather than fetched twice.
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
  if (wrapped) allTimeRoster.xpWraps = (rosterNum(allTimeRoster.xpWraps) || 0) + 1;
  saveAllTimeRoster();

  // 7. Whatever routine rank work the ceiling still allows.
  for (const target of rankTargets.filter((t) => t.tier >= 3)) {
    spend(() => refreshRosterRank(target.handle));
  }

  return ROSTER_REQUEST_CEILING - budget;
}

// The response is relayed and routed like any other, so it lands back through
// noteAllTimeObservation — one write path, not two.
function refreshRosterRank(handle) {
  const normalized = normalizeHandle(handle);
  if (!isValidHandle(normalized)) return;
  rosterRankSuspects.delete(normalized);
  requestApiJson(`https://api.boot.dev/v1/users/public/${encodeURIComponent(normalized)}/stats`);
}

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
    bootstrapRosterFromPersonalRecords,
    readAlltimeRank,
    readRegisteredUsers,
    admissionThresholdXp,
    rosterCoverage,
    deriveBoardPositions,
    gapRoleForPosition,
    buildAllTimeBoardRows,
    detectOvertakes,
    pickXpRefreshTargets,
    pickRankRefreshTargets,
    constants: {
      ALLTIME_BOARD_SIZE,
      ROSTER_RANK_LIMIT,
      ROSTER_MAX_ENTRIES,
      ROSTER_CANDIDATE_MAX,
      ROSTER_XP_SLICE,
      ROSTER_XP_PRIMING_SLICE,
      ROSTER_RANK_SLICE,
      ROSTER_PRIMING_COOLDOWN_MS,
      ROSTER_REFRESH_COOLDOWN_MS,
      ROSTER_REQUEST_CEILING,
      ROSTER_ANCHOR_MAX_AGE_MS,
      RANK_TTL_BOUNDARY_MS,
      RANK_TTL_MID_MS,
      RANK_TTL_TOP_MS,
    },
  };
}
