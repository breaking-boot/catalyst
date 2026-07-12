// backup.js
// Backup & restore core for the extension pages: owns the backup file format
// (BACKUP_FORMAT_VERSION), builds an export from storage, validates/upgrades an
// uploaded file, and merges it back into storage. Merge semantics: data accretes
// (handle list unions, snapshot series merge, boss highs take the max), settings
// are replaced wholesale — restoring a backup should land the toggles exactly as
// they were.
//
// Dependency-free like settings-schema.js: loaded by options.html via a
// <script> tag before popup.js, and NOT a content script (utils.js is coupled
// to the content-script lifecycle via enhancerStopped/stopEnhancer, so the few
// helpers needed here are mirrored instead — each marked "keep in sync").
// Open Boot.dev tabs learn about an import through the BACKUP_BROADCAST_KEY
// write at the end of applyBackup; see the storage.onChanged listener in
// content.js.

const BACKUP_FORMAT_VERSION = 1;

// Storage keys mirrored from settings.js / leaderboard.js / boss.js — keep in sync.
const BACKUP_SETTINGS_KEY = "be_settings"; // chrome.storage.sync; everything below is storage.local
const BACKUP_HANDLES_KEY = "be_personal_leaderboard_handles";
const BACKUP_PERSONAL_CACHE_KEY = "be_personal_leaderboard_cache";
const BACKUP_USER_HANDLE_KEY = "be_current_user_handle";
const BACKUP_USER_KARMA_KEY = "be_current_user_karma";
const BACKUP_BOSS_KEY = "be_boss_state";
// Written (fresh timestamp) after a successful import. Content scripts can't be
// messaged from an extension page without the "tabs" permission, and having
// tabs react to the data keys themselves would make every tab reload on its own
// routine writes — so tabs listen for this one key instead.
const BACKUP_BROADCAST_KEY = "be_import_broadcast";

// Snapshot retention rules mirrored from leaderboard.js
// (SNAPSHOT_MAX_AGE_MS / SNAPSHOT_CAP) — keep in sync.
const BACKUP_SNAPSHOT_MAX_AGE_MS = (24 * 60 + 30) * 60 * 1000; // 24.5h
const BACKUP_SNAPSHOT_CAP = 60;

// Import guards. Entry-level problems are skipped leniently, but hard bounds
// keep a hostile or corrupt file from doing real damage: an absurd handle list
// would mean an API request per entry on the next leaderboard visit.
const BACKUP_CLOCK_SKEW_MS = 5 * 60 * 1000; // tolerate cross-device clock skew on "future" points
const BACKUP_MAX_FILE_BYTES = 2 * 1024 * 1024; // a real backup is a few hundred KB at most
const BACKUP_MAX_HANDLES = 200;
const BACKUP_MAX_SETTINGS_KEYS = 64;

// --- helpers mirrored from utils.js (keep in sync) -------------------------

function backupNum(v) {
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}

function backupIsPlainObject(value) {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function backupNormalizeHandle(value) {
  const raw = String(value || "")
    .trim()
    .replace(/^https?:\/\/(?:www\.)?boot\.dev\/u\//i, "")
    .replace(/^\/u\//i, "")
    .replace(/^@/, "");
  return raw.split(/[/?#\s]/)[0].toLowerCase();
}

function backupIsValidHandle(handle) {
  return /^[a-z0-9][a-z0-9_-]{0,39}$/i.test(String(handle || ""));
}

// --- storage (extension-page context; no content-script lifecycle) ---------

function backupStorageGet(area, key) {
  return new Promise((resolve) => {
    try {
      chrome.storage[area].get(key, (o) => {
        resolve(chrome.runtime.lastError ? undefined : o?.[key]);
      });
    } catch (_) {
      resolve(undefined);
    }
  });
}

function backupStorageSet(area, key, value) {
  return new Promise((resolve) => {
    try {
      chrome.storage[area].set({ [key]: value }, () => {
        resolve(!chrome.runtime.lastError);
      });
    } catch (_) {
      resolve(false);
    }
  });
}

// --- sanitizers / merge primitives ------------------------------------------

// Combine up to two snapshot series into one clean series: valid [t(ms), total]
// pairs only, inside the retention window, ascending by time, totals
// non-decreasing (points are observations of a lifetime total, so a later,
// lower point is a glitch and is dropped), capped with endpoint-preserving
// thinning. Mirrors the invariants of updateSnapshotSeries in leaderboard.js —
// keep in sync. Pass null as either side to just sanitize the other.
function mergeSnapshotSeries(a, b, now) {
  const cutoff = now - BACKUP_SNAPSHOT_MAX_AGE_MS;
  const latest = now + BACKUP_CLOCK_SKEW_MS;
  const pairs = [];
  for (const src of [a, b]) {
    if (!Array.isArray(src)) continue;
    for (const p of src) {
      if (!Array.isArray(p)) continue;
      const t = backupNum(p[0]);
      const v = backupNum(p[1]);
      if (t == null || v == null || v < 0) continue;
      if (t < cutoff || t > latest) continue;
      pairs.push([t, v]);
    }
  }
  pairs.sort((x, y) => x[0] - y[0] || x[1] - y[1]);

  let out = [];
  for (const p of pairs) {
    const last = out[out.length - 1];
    if (last && last[0] === p[0] && last[1] === p[1]) continue; // exact duplicate
    if (last && p[1] < last[1]) continue; // contradiction: keep the higher run
    out.push(p);
  }
  while (out.length > BACKUP_SNAPSHOT_CAP) {
    out = out.filter((s, i, arr) => i === 0 || i === arr.length - 1 || i % 2 === 1);
  }
  return out;
}

function sanitizeHandleList(raw) {
  if (!Array.isArray(raw)) return [];
  const seen = new Set();
  const out = [];
  for (const h of raw) {
    const normalized = backupNormalizeHandle(h);
    if (!backupIsValidHandle(normalized) || seen.has(normalized)) continue;
    seen.add(normalized);
    out.push(normalized);
    if (out.length >= BACKUP_MAX_HANDLES) break;
  }
  return out;
}

// Booleans only, sane key names, bounded count. Unknown keys are kept on
// purpose: a backup from a newer Catalyst may carry flags this version doesn't
// know — normalizeSettings ignores them at read time and they take effect after
// an upgrade. The key regex also shuts out "__proto__"-style names whose
// assignment wouldn't stay a plain data property.
function sanitizeBackupSettings(raw) {
  const out = {};
  if (!backupIsPlainObject(raw)) return out;
  let count = 0;
  for (const key of Object.keys(raw)) {
    if (count >= BACKUP_MAX_SETTINGS_KEYS) break;
    if (typeof raw[key] !== "boolean") continue;
    if (!/^[a-zA-Z][a-zA-Z0-9_]{0,63}$/.test(key)) continue;
    out[key] = raw[key];
    count += 1;
  }
  return out;
}

// --- export ------------------------------------------------------------------

// Build the versioned export object from current storage. Settings are exported
// as the RAW stored object, not the normalized map: an unset flag must stay
// unset so it keeps tracking future default changes after a restore (the same
// reasoning as setFeatureEnabled in settings.js). Per tracked learner only the
// snapshot series are exported — profile/stats/heatmap are refetched
// automatically and would only ship stale data.
async function collectBackupData() {
  const [settings, handlesStored, cacheStored, userHandleStored, userKarmaStored, bossStored] =
    await Promise.all([
      backupStorageGet("sync", BACKUP_SETTINGS_KEY),
      backupStorageGet("local", BACKUP_HANDLES_KEY),
      backupStorageGet("local", BACKUP_PERSONAL_CACHE_KEY),
      backupStorageGet("local", BACKUP_USER_HANDLE_KEY),
      backupStorageGet("local", BACKUP_USER_KARMA_KEY),
      backupStorageGet("local", BACKUP_BOSS_KEY),
    ]);

  const now = Date.now();
  const handles = sanitizeHandleList(
    Array.isArray(handlesStored) ? handlesStored : handlesStored?.handles
  );

  const snapshots = {};
  const records = backupIsPlainObject(cacheStored?.records) ? cacheStored.records : {};
  for (const handle of handles) {
    const record = backupIsPlainObject(records[handle]) ? records[handle] : {};
    const xp = mergeSnapshotSeries(record.xpSnapshots, null, now);
    const karma = mergeSnapshotSeries(record.karmaSnapshots, null, now);
    if (xp.length || karma.length) snapshots[handle] = { xp, karma };
  }

  const data = {
    settings: backupIsPlainObject(settings) ? settings : {},
    personalLeaderboard: { handles, snapshots },
  };

  const userHandle = backupNormalizeHandle(userHandleStored?.handle ?? userHandleStored);
  if (backupIsValidHandle(userHandle)) {
    // The karma series is only valid for the handle it was recorded for.
    const series =
      backupIsPlainObject(userKarmaStored) &&
      backupNormalizeHandle(userKarmaStored.handle) === userHandle
        ? mergeSnapshotSeries(userKarmaStored.snapshots, null, now)
        : [];
    data.currentUser = { handle: userHandle, karmaSnapshots: series };
  }

  const boss = backupIsPlainObject(bossStored?.state) ? bossStored.state : null;
  if (boss) {
    data.bossState = {
      eventId: typeof boss.eventId === "string" ? boss.eventId : null,
      eventHigh: Math.max(0, backupNum(boss.eventHigh) ?? 0),
      eventHighAt: backupNum(boss.eventHighAt), // null on pre-0.9.0 states
      allTimeHigh: Math.max(0, backupNum(boss.allTimeHigh) ?? 0),
    };
  }

  return {
    catalystExport: true,
    formatVersion: BACKUP_FORMAT_VERSION,
    exportedAt: new Date(now).toISOString(),
    extensionVersion: chrome.runtime.getManifest().version,
    data,
  };
}

// --- import: parse / summarize / apply ----------------------------------------

// Parse and structurally validate an uploaded backup. File-level strict: any
// problem here rejects the whole file and nothing is written. Entry-level
// problems (one bad handle, one malformed snapshot pair) are skipped leniently
// at apply time instead. Returns { data } or { error }.
function parseBackupFile(text) {
  if (typeof text !== "string" || !text.trim()) return { error: "The file is empty." };
  if (text.length > BACKUP_MAX_FILE_BYTES) {
    return { error: "File is too large to be a Catalyst backup." };
  }
  let parsed;
  try {
    parsed = JSON.parse(text);
  } catch (_) {
    return { error: "Not a JSON file." };
  }
  if (!backupIsPlainObject(parsed) || parsed.catalystExport !== true) {
    return { error: "Not a Catalyst backup file." };
  }
  const version = parsed.formatVersion;
  if (!Number.isInteger(version) || version < 1) {
    return { error: "The backup has no valid format version." };
  }
  if (version > BACKUP_FORMAT_VERSION) {
    return {
      error: `This backup uses format v${version}; this Catalyst reads up to v${BACKUP_FORMAT_VERSION}. Update Catalyst, then retry.`,
    };
  }
  const data = upgradeBackupData(version, parsed.data);
  if (!backupIsPlainObject(data)) return { error: "The backup contains no data." };
  return { data };
}

// Ordered upgrade steps from older file formats to the current one. v1 is the
// first format, so this is a pass-through today; when a structural change ships,
// add `if (fromVersion < 2) { ...transform... }` here and bump
// BACKUP_FORMAT_VERSION. New settings keys or new data sections are NOT format
// changes — unknown keys/sections already pass through harmlessly.
function upgradeBackupData(fromVersion, data) {
  return data;
}

// Human-readable description of a parsed backup for the confirm step. Rendered
// with textContent only (file content is untrusted) — see popup.js.
function summarizeBackup(data) {
  const now = Date.now();
  const lines = [];

  if (backupIsPlainObject(data.settings)) {
    const count = Object.keys(sanitizeBackupSettings(data.settings)).length;
    lines.push(`Settings — ${count} saved choice${count === 1 ? "" : "s"} (replaces current settings)`);
  }

  const pl = backupIsPlainObject(data.personalLeaderboard) ? data.personalLeaderboard : null;
  if (pl) {
    const handles = sanitizeHandleList(pl.handles);
    const snaps = backupIsPlainObject(pl.snapshots) ? pl.snapshots : {};
    let snapshotUsers = 0;
    for (const handle of handles) {
      const s = backupIsPlainObject(snaps[handle]) ? snaps[handle] : null;
      if (!s) continue;
      if (mergeSnapshotSeries(s.xp, null, now).length || mergeSnapshotSeries(s.karma, null, now).length) {
        snapshotUsers += 1;
      }
    }
    lines.push(
      `Personal leaderboards — ${handles.length} tracked learner${handles.length === 1 ? "" : "s"}, ` +
        `usable snapshot history for ${snapshotUsers} (merges with your current list)`
    );
  }

  if (backupIsPlainObject(data.currentUser)) {
    const handle = backupNormalizeHandle(data.currentUser.handle);
    if (backupIsValidHandle(handle)) {
      lines.push(`Your karma comparison history (@${handle}) — merges if this device tracks the same user`);
    }
  }

  if (backupIsPlainObject(data.bossState)) {
    const ath = Math.round(Math.max(0, backupNum(data.bossState.allTimeHigh) ?? 0));
    lines.push(`Boss stats — all-time high ${ath}% (merges; event high only if it's the same event)`);
  }

  if (!lines.length) lines.push("No recognizable Catalyst data in this file.");
  return lines;
}

// Apply a parsed backup: data merges (never deletes), settings replace. Returns
// human-readable per-section results for the status UI. Ends with a broadcast
// write so open Boot.dev tabs reload the imported local keys (settings need no
// broadcast — the sync onChanged live-apply in content.js already covers them).
async function applyBackup(data) {
  const now = Date.now();
  const results = [];
  let applied = false;

  if (backupIsPlainObject(data.settings)) {
    const cleaned = sanitizeBackupSettings(data.settings);
    const ok = await backupStorageSet("sync", BACKUP_SETTINGS_KEY, cleaned);
    applied = applied || ok;
    results.push(ok ? "Settings restored." : "Settings could not be written.");
  }

  const pl = backupIsPlainObject(data.personalLeaderboard) ? data.personalLeaderboard : null;
  if (pl) {
    const imported = sanitizeHandleList(pl.handles);
    const handlesStored = await backupStorageGet("local", BACKUP_HANDLES_KEY);
    const existing = sanitizeHandleList(
      Array.isArray(handlesStored) ? handlesStored : handlesStored?.handles
    );
    // Union, existing first, so the user's current ordering is preserved.
    const merged = existing.slice();
    for (const handle of imported) {
      if (!merged.includes(handle)) merged.push(handle);
    }
    const added = merged.length - existing.length;

    const cacheStored = await backupStorageGet("local", BACKUP_PERSONAL_CACHE_KEY);
    const records = backupIsPlainObject(cacheStored?.records) ? cacheStored.records : {};
    const importedSnaps = backupIsPlainObject(pl.snapshots) ? pl.snapshots : {};
    let snapshotUsers = 0;
    for (const handle of merged) {
      const record = backupIsPlainObject(records[handle]) ? records[handle] : { handle };
      const snaps = backupIsPlainObject(importedSnaps[handle]) ? importedSnaps[handle] : null;
      if (
        snaps &&
        (mergeSnapshotSeries(snaps.xp, null, now).length ||
          mergeSnapshotSeries(snaps.karma, null, now).length)
      ) {
        snapshotUsers += 1;
      }
      record.xpSnapshots = mergeSnapshotSeries(record.xpSnapshots, snaps?.xp, now);
      record.karmaSnapshots = mergeSnapshotSeries(record.karmaSnapshots, snaps?.karma, now);
      records[handle] = record;
    }

    const wroteHandles = await backupStorageSet("local", BACKUP_HANDLES_KEY, { handles: merged });
    const wroteCache = await backupStorageSet("local", BACKUP_PERSONAL_CACHE_KEY, {
      records,
      updatedAt: now,
    });
    applied = applied || wroteHandles || wroteCache;
    results.push(
      wroteHandles && wroteCache
        ? `Personal leaderboards: ${added} learner${added === 1 ? "" : "s"} added (${merged.length} total), ` +
            `snapshot history merged for ${snapshotUsers}.`
        : "Personal leaderboards could not be written."
    );
  }

  if (backupIsPlainObject(data.currentUser)) {
    const handle = backupNormalizeHandle(data.currentUser.handle);
    if (backupIsValidHandle(handle)) {
      const localStored = await backupStorageGet("local", BACKUP_USER_HANDLE_KEY);
      const localHandle = backupNormalizeHandle(localStored?.handle ?? localStored);
      if (backupIsValidHandle(localHandle) && localHandle !== handle) {
        // Another account's baseline would silently corrupt every karma
        // comparison — same rule as the invalidate-on-handle-change guard.
        results.push(`Skipped your karma history: backup is for @${handle}, this device tracks @${localHandle}.`);
      } else {
        const karmaStored = await backupStorageGet("local", BACKUP_USER_KARMA_KEY);
        const existingSeries =
          backupIsPlainObject(karmaStored) && backupNormalizeHandle(karmaStored.handle) === handle
            ? karmaStored.snapshots
            : null;
        const mergedSeries = mergeSnapshotSeries(existingSeries, data.currentUser.karmaSnapshots, now);
        const ok = await backupStorageSet("local", BACKUP_USER_KARMA_KEY, {
          handle,
          snapshots: mergedSeries,
        });
        if (ok && !backupIsValidHandle(localHandle)) {
          await backupStorageSet("local", BACKUP_USER_HANDLE_KEY, { handle, updatedAt: now });
        }
        applied = applied || ok;
        results.push(ok ? "Your karma history merged." : "Your karma history could not be written.");
      }
    }
  }

  if (backupIsPlainObject(data.bossState)) {
    const { message, wrote } = await mergeBossState(data.bossState, now);
    applied = applied || wrote;
    results.push(message);
  }

  if (applied) {
    await backupStorageSet("local", BACKUP_BROADCAST_KEY, { at: now });
  }
  if (!results.length) results.push("Nothing recognizable to import.");
  return results;
}

// Boss merge rules: the all-time high takes the max; event stats only merge
// when the backup's event is the SAME event this device last saw (per-event
// stats reset when Event.UUID changes, so a different event's high is stale by
// definition and dropped). With no local state at all, the backup's event is
// adopted wholesale — live fields refill on the next boss_events_progress
// response, and the normal new-event reset applies if that response shows a
// different event.
async function mergeBossState(imported, now) {
  const eventId = typeof imported.eventId === "string" && imported.eventId ? imported.eventId : null;
  const eventHigh = Math.max(0, backupNum(imported.eventHigh) ?? 0);
  const eventHighAt = backupNum(imported.eventHighAt);
  const allTimeHigh = Math.max(0, backupNum(imported.allTimeHigh) ?? 0, eventHigh);

  const stored = await backupStorageGet("local", BACKUP_BOSS_KEY);
  const local = backupIsPlainObject(stored?.state) ? { ...stored.state } : null;

  if (!local) {
    if (!eventId && !allTimeHigh) return { message: "Boss stats: nothing to restore.", wrote: false };
    // Mirrors the shape of newEventState in boss.js — keep in sync.
    const fresh = {
      eventId: eventId || "unknown-event",
      current: 0,
      eventHigh,
      eventHighAt,
      allTimeHigh,
      damage: 0,
      nextChestAt: 0,
      bossMaxHp: 0,
      lastChestTier: null,
      nextChestTier: null,
      notifiedHigh: 0,
      updatedAt: now,
    };
    const ok = await backupStorageSet("local", BACKUP_BOSS_KEY, { state: fresh });
    return {
      message: ok ? "Boss stats restored." : "Boss stats could not be written.",
      wrote: ok,
    };
  }

  let changed = false;
  let eventNote = "";
  if (allTimeHigh > (backupNum(local.allTimeHigh) ?? 0)) {
    local.allTimeHigh = allTimeHigh;
    changed = true;
  }
  if (eventId && eventId === local.eventId) {
    if (eventHigh > (backupNum(local.eventHigh) ?? 0)) {
      local.eventHigh = eventHigh;
      local.eventHighAt = eventHighAt;
      if (local.eventHigh > (backupNum(local.allTimeHigh) ?? 0)) local.allTimeHigh = local.eventHigh;
      changed = true;
    }
  } else if (eventId && eventHigh > 0) {
    eventNote = " (its event high was for a different event and was dropped)";
  }

  if (!changed) {
    return { message: `Boss stats: this device already has the newer values${eventNote}.`, wrote: false };
  }
  local.updatedAt = now;
  const ok = await backupStorageSet("local", BACKUP_BOSS_KEY, { state: local });
  return {
    message: ok ? `Boss stats merged${eventNote}.` : "Boss stats could not be written.",
    wrote: ok,
  };
}
