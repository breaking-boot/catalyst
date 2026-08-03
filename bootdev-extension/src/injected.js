// injected.js
// Runs in the PAGE's JS context (not the isolated content-script world), so it
// can see and wrap the same window.fetch / XMLHttpRequest that Boot.dev uses.
// It clones each api.boot.dev JSON response and relays it to the content script
// via window.postMessage. It never blocks or alters the real request.

(function () {
  if (window.__BOOTDEV_ENHANCER_INSTALLED__) return;
  window.__BOOTDEV_ENHANCER_INSTALLED__ = true;

  const TAG = "BOOTDEV_ENHANCER";
  const API = "api.boot.dev";
  const DEBUG = false;
  // Paths the session cookie alone cannot reach: they need the Authorization
  // header harvested from Boot.dev's own requests, so a request made before one
  // has been seen must be queued rather than sent bare (it would 401 and be
  // dropped). Measured 2026-07-31: a credentialed cookie-only GET returns 401
  // for these and 200 for every other endpoint Catalyst reads.
  const AUTH_REQUIRED_PATHS = new Set([
    "/v1/boss_events_progress",
    "/v1/dashboard_content",
  ]);
  // The league boards need the header too, but carry a period segment, so they
  // need a pattern rather than an exact path. Omitting them used to mean a
  // cold, server-rendered /leaderboard (where Boot.dev fetches nothing, so
  // nothing is harvested) silently lost both League comparison boards.
  const AUTH_REQUIRED_PATTERNS = [/^\/v1\/league_leaderboard_xp\/[^/]+$/];
  // Passively-observed responses are only broadcast for the handful of paths the
  // content-script router actually consumes, so unrelated (and possibly
  // sensitive) api.boot.dev payloads are never re-exposed on the window bus.
  // Responses to our own explicit requests (those carry a requestId) always
  // relay regardless. Keep in sync with the router in content.js.
  const RELAY_PATH_PATTERNS = [
    /^\/v1\/leaderboard_xp\/[^/]+$/,
    /^\/v1\/leaderboard_karma\/[^/]+$/,
    /^\/v1\/league_leaderboard_xp\/[^/]+$/,
    /^\/v1\/users\/public\/[^/]+(?:\/stats|\/activity_heatmap)?$/,
    /^\/v1\/boss_events_progress$/,
    /^\/v1\/dashboard_content$/,
    /^\/v1\/users\/lessons\/[^/]+$/,
    /^\/v1\/course_progress_by_lesson\/[^/]+$/,
    /^\/v1\/challenges\/search$/,
  ];

  function shouldRelay(url) {
    try {
      const pathname = new URL(url, window.location.origin).pathname;
      return RELAY_PATH_PATTERNS.some((re) => re.test(pathname));
    } catch (_) {
      return false;
    }
  }
  // --- Training Grounds difficulty level filter ---------------------------
  // Boot.dev shipped its own Easy/Medium/Hard filter on 2026-08-01 (d=easy in
  // the query, filtered server-side), so Catalyst no longer tiers anything: it
  // narrows the already tier-filtered response down to exact levels, which is
  // the thing the native filter cannot do. Only the 1-10 bound matters here —
  // the tier -> level mapping lives in trainingGrounds.js (CHALLENGE_TIERS),
  // which is now the single copy rather than one of two kept in sync.
  const LEVEL_MIN = 1;
  const LEVEL_MAX = 10;
  const CHALLENGE_SEARCH_PATH = "/v1/challenges/search";
  // Committed levels arrive via a DOM attribute the content script maintains
  // (trainingGrounds.js). An attribute read is synchronous, so a fetch fired
  // in the same task as a Search click already sees the just-committed state
  // — no postMessage race. Attribute absent = feature off / nothing committed.
  const CHALLENGE_LEVEL_ATTR = "data-be-dl";
  // Throwaway router-query param used only to make the page re-run its search
  // (any query change refetches); stripped from the URL by trainingGrounds.js.
  const CHALLENGE_REFRESH_NONCE_PARAM = "be_r";

  // 1-10 in every captured record. Anything else (missing, non-integer, out of
  // range) is "unresolvable", which the filter below treats as keep — the same
  // rule the tier version had, where an out-of-range value tiered to null.
  function challengeLevel(value) {
    const n = Number(value);
    if (!Number.isInteger(n)) return null;
    if (n < LEVEL_MIN || n > LEVEL_MAX) return null;
    return n;
  }

  // Boot.dev reshaped this response from PascalCase to camelCase between
  // 2026-07-14 and 2026-07-30 (Topics.Difficulty -> topics.difficulty). Because
  // an unreadable difficulty is deliberately treated as "keep" below, that
  // flip disabled the filter silently: every record survived and the catalog
  // just looked unfiltered. Read both casings so either shape works and a flip
  // back cannot break it again — same hazard normalizeBossProgressJson (boss.js)
  // handles for boss_events_progress.
  function challengeDifficulty(record) {
    const topics = record?.Topics ?? record?.topics;
    if (!topics || typeof topics !== "object") return undefined;
    return topics.Difficulty ?? topics.difficulty;
  }

  // Records with no resolvable level are always kept: hiding a challenge on
  // bad data is worse than showing an occasional mis-levelled one.
  function filterChallengeSearchArray(records, levelSet) {
    return records.filter((record) => {
      const level = challengeLevel(challengeDifficulty(record));
      return level === null || levelSet.has(level);
    });
  }

  // How many records Catalyst could actually read a level from. The
  // keep-on-unknown rule above means a renamed difficulty field disables the
  // filter without any symptom — that is exactly what happened in v0.12.1 — so
  // this number rides along in the relay metadata and trainingGrounds.js warns
  // when it is 0 out of N. Detection, not tolerance: the next rename should
  // announce itself.
  function countResolvedLevels(records) {
    let resolved = 0;
    for (const record of records) {
      if (challengeLevel(challengeDifficulty(record)) !== null) resolved += 1;
    }
    return resolved;
  }

  // The response has been a bare JSON array in every capture (2026-07-14 and
  // 2026-07-31). A wrapped shape is accepted anyway, and re-wrapped on the way
  // out, because a wrapper appearing later would otherwise disable the filter
  // in the same silent way the casing flip did. Returns null when no record
  // array can be found, which fails open to Boot.dev's own response.
  function challengeSearchRecords(json) {
    if (Array.isArray(json)) return { records: json, rewrap: (list) => list };
    if (json && typeof json === "object") {
      for (const key of ["data", "results", "challenges"]) {
        if (Array.isArray(json[key])) {
          return { records: json[key], rewrap: (list) => ({ ...json, [key]: list }) };
        }
      }
    }
    return null;
  }

  // "8,10" (any junk tolerated) -> in-range levels only, deduped, ascending.
  function parseLevelList(raw) {
    const seen = new Set();
    for (const part of String(raw ?? "").split(",")) {
      const level = challengeLevel(part.trim());
      if (level !== null) seen.add(level);
    }
    return [...seen].sort((a, b) => a - b);
  }

  // "hard:8,10" -> { tier: "hard", levels: [8, 10] }. The tier rides along
  // because a level selection is only meaningful inside the native tier it was
  // picked in; see challengeFilterForRequest.
  function parseChallengeFilter(raw) {
    if (raw === null || raw === undefined) return null;
    const [tier, list] = String(raw).split(":");
    const levels = parseLevelList(list);
    if (!tier || !levels.length) return null;
    return { tier: tier.toLowerCase(), levels };
  }

  // null = nothing to do (attribute absent, unparseable, or scoped to a tier
  // this request isn't asking for): touch nothing.
  //
  // Validating against the REQUEST URL rather than the content script's cached
  // idea of the native tier is what makes stale state harmless. Boot.dev can
  // drop its own difficulty filter without the popover ever opening — clearing
  // the search box, a fresh search with no filters, navigating back to the
  // catalog — and Catalyst has no way to observe those. Before this check, a
  // selection scoped to Hard would happily filter a search that carried no
  // `d=` at all, hiding results with no visible filter to explain it.
  function challengeFilterForRequest(url) {
    const filter = parseChallengeFilter(
      document.documentElement?.getAttribute?.(CHALLENGE_LEVEL_ATTR)
    );
    if (!filter) return null;
    try {
      const requested = new URL(url, window.location.origin).searchParams.get("d");
      if (String(requested || "").toLowerCase() !== filter.tier) return null;
    } catch (_) {
      return null;
    }
    return filter;
  }

  function isChallengeSearchUrl(url) {
    try {
      return new URL(url, window.location.origin).pathname === CHALLENGE_SEARCH_PATH;
    } catch (_) {
      return false;
    }
  }

  // Returns a replacement Response when the filter applied cleanly, else null
  // (the caller falls through to the untouched response + normal relay).
  async function maybeFilterChallengeSearch(url, method, res) {
    try {
      const filter = challengeFilterForRequest(url);
      if (!filter) return null;
      const levels = filter.levels;
      const text = await res.clone().text();
      const json = JSON.parse(text);
      const shape = challengeSearchRecords(json);
      if (!shape) return null;
      const filtered = filterChallengeSearchArray(shape.records, new Set(levels));
      const body = JSON.stringify(shape.rewrap(filtered));
      relay(url, method, res.status, body, null, {
        filtered: true,
        originalCount: shape.records.length,
        resolvedCount: countResolvedLevels(shape.records),
        appliedLevels: levels,
      });
      const headers = new Headers(res.headers);
      // Stale after re-serialization / already decoded by fetch.
      headers.delete("content-length");
      headers.delete("content-encoding");
      return new Response(body, {
        status: res.status,
        statusText: res.statusText,
        headers,
      });
    } catch (_) {
      return null; // fail open: boot.dev gets its original response
    }
  }

  // Makes the page re-run its current search (e.g. after a Search click that
  // Boot.dev skipped because q/t/l were unchanged, or on a cold load where the
  // results were server-rendered with no API call). Re-pushes the current
  // route through the page's Vue router with a fresh throwaway nonce param —
  // always a query change, so the frontend always refetches; the server
  // provably ignores unknown params. trainingGrounds.js cleans the nonce out
  // of the URL (and maintains the cosmetic `dl` param) once the response
  // arrives. __vue_app__ is private Vue API, hence the guard; the hard-reload
  // fallback restores native (unfiltered) content at worst — fail-open.
  function refreshChallengeSearch() {
    try {
      const router = document.querySelector("#__nuxt")?.__vue_app__?.config
        ?.globalProperties?.$router;
      const current = router?.currentRoute?.value;
      if (router && current) {
        const query = { ...(current.query || {}) };
        query[CHALLENGE_REFRESH_NONCE_PARAM] = Date.now().toString(36);
        router.push({ path: window.location.pathname, query });
        return;
      }
    } catch (_) {}
    try {
      window.location.reload();
    } catch (_) {}
  }
  // -------------------------------------------------------------------------

  const HEADER_ALLOWLIST = new Set([
    "accept",
    "authorization",
    "content-type",
    "x-csrf-token",
    "x-xsrf-token",
  ]);
  let lastApiHeaders = {};
  const pendingAuthFetches = new Map();

  function relay(url, method, status, bodyText, requestId = null, catalyst = null) {
    let json = null;
    try {
      json = JSON.parse(bodyText);
    } catch (_) {
      return; // not JSON, ignore
    }
    // Passive broadcasts (no requestId) are limited to consumed paths; explicit
    // request responses (with a requestId) always go through to their caller.
    if (!requestId && !shouldRelay(url)) return;
    const payload = { url, method, status, json, requestId };
    if (catalyst) payload.catalyst = catalyst; // e.g. challenge-filter metadata
    window.postMessage({ source: TAG, payload }, window.location.origin);
  }

  function rememberApiHeaders(...sources) {
    for (const source of sources) {
      if (!source) continue;
      try {
        new Headers(source).forEach((value, key) => {
          const lowered = key.toLowerCase();
          if (HEADER_ALLOWLIST.has(lowered)) lastApiHeaders[lowered] = value;
        });
      } catch (_) {}
    }
    if (hasAuthHeaders()) flushPendingAuthFetches();
  }

  function hasAuthHeaders() {
    return Boolean(lastApiHeaders.authorization);
  }

  function requiresAuth(pathname) {
    return (
      AUTH_REQUIRED_PATHS.has(pathname) ||
      AUTH_REQUIRED_PATTERNS.some((re) => re.test(pathname))
    );
  }

  function queueAuthFetch(url, requestId) {
    const entry = pendingAuthFetches.get(url) || { requestIds: new Set(), broadcast: false };
    if (requestId) {
      entry.requestIds.add(requestId);
    } else {
      entry.broadcast = true;
    }
    pendingAuthFetches.set(url, entry);
  }

  function flushPendingAuthFetches() {
    for (const [url, entry] of pendingAuthFetches.entries()) {
      pendingAuthFetches.delete(url);
      const requestIds = Array.from(entry.requestIds);
      if (entry.broadcast || !requestIds.length) requestIds.push(null);
      fetchAndRelay(url, requestIds);
    }
  }

  async function fetchAndRelay(url, requestIds) {
    try {
      const parsed = new URL(url, window.location.origin);
      if (parsed.hostname !== API) return;

      const res = await origFetch(parsed.href, {
        method: "GET",
        credentials: "include",
        cache: "no-store",
        headers: {
          accept: "application/json",
          "content-type": "application/json",
          ...lastApiHeaders,
        },
      });

      const text = await res.clone().text();
      for (const requestId of requestIds) {
        relay(parsed.href, "GET", res.status, text, requestId);
      }
    } catch (_) {
      for (const requestId of requestIds) {
        relay(url, "GET", 0, JSON.stringify({ error: "request_failed" }), requestId);
      }
    }
  }

  // --- wrap fetch ---
  const origFetch = window.fetch;
  window.fetch = async function (...args) {
    const url = typeof args[0] === "string" ? args[0] : args[0]?.url;
    if (url && url.includes(API)) {
      rememberApiHeaders(args[0]?.headers, args[1]?.headers);
    }

    const res = await origFetch.apply(this, args);
    try {
      if (url && url.includes(API)) {
        const method =
          (args[1] && args[1].method) ||
          (typeof args[0] !== "string" && args[0]?.method) ||
          "GET";
        // Challenge search with an active level selection: hand the page a
        // filtered copy so its own list, "Showing X-Y of Z" line, and
        // pagination all render the reduced set. Any hiccup falls through to
        // the untouched response below.
        if (
          res.ok &&
          String(method).toUpperCase() === "GET" &&
          isChallengeSearchUrl(url) &&
          challengeFilterForRequest(url)
        ) {
          const replaced = await maybeFilterChallengeSearch(url, method, res);
          if (replaced) return replaced;
        }
        // clone() so we read the body without consuming the page's copy
        res
          .clone()
          .text()
          .then((t) => relay(url, method, res.status, t))
          .catch(() => {});
      }
    } catch (_) {}
    return res;
  };

  // --- wrap XHR (some Nuxt/axios setups use XHR) ---
  const origOpen = XMLHttpRequest.prototype.open;
  const origSetRequestHeader = XMLHttpRequest.prototype.setRequestHeader;
  const origSend = XMLHttpRequest.prototype.send;
  XMLHttpRequest.prototype.open = function (method, url, ...rest) {
    this.__be_url = url;
    this.__be_method = method;
    return origOpen.call(this, method, url, ...rest);
  };
  XMLHttpRequest.prototype.setRequestHeader = function (name, value) {
    if (this.__be_url && String(this.__be_url).includes(API)) {
      rememberApiHeaders({ [name]: value });
    }
    return origSetRequestHeader.call(this, name, value);
  };
  XMLHttpRequest.prototype.send = function (...sendArgs) {
    this.addEventListener("load", function () {
      try {
        if (this.__be_url && String(this.__be_url).includes(API)) {
          relay(this.__be_url, this.__be_method, this.status, this.responseText);
        }
      } catch (_) {}
    });
    return origSend.apply(this, sendArgs);
  };

  window.addEventListener("message", async (event) => {
    if (event.source !== window) return;
    if (event.origin !== window.location.origin) return;

    const msg = event.data;
    if (!msg || msg.source !== TAG || !msg.command) return;

    if (msg.command === "BE_REFRESH_CHALLENGE_SEARCH") {
      refreshChallengeSearch();
      return;
    }
    if (msg.command !== "BE_FETCH_JSON") return;

    const url = String(msg.payload?.url || "");
    const requestId = msg.payload?.requestId || null;
    if (!url.includes(API)) return;

    try {
      const parsed = new URL(url, window.location.origin);
      if (parsed.hostname !== API) return;
      // The bridge replays authenticated GETs, so restrict it to the same paths
      // the extension actually consumes. Any same-origin script can post
      // BE_FETCH_JSON, but it can only reach the allowlisted endpoints (which it
      // could already read from the page's own session anyway) — not arbitrary
      // Boot.dev API paths. Catalyst only ever requests allowlisted paths, so
      // there is no functional cost.
      if (!shouldRelay(parsed.href)) return;

      if (requiresAuth(parsed.pathname) && !hasAuthHeaders()) {
        queueAuthFetch(parsed.href, requestId);
        relay(parsed.href, "GET", 0, JSON.stringify({ error: "auth_headers_unavailable" }), requestId);
        return;
      }

      await fetchAndRelay(parsed.href, [requestId]);
    } catch (_) {}
  });

  // Test-only seam: the Node harness (scripts/check_challenge_filter.mjs)
  // predefines __BOOTDEV_ENHANCER_TEST__ before evaluating this file so it can
  // reach the pure helpers. Never defined on the real page.
  if (window.__BOOTDEV_ENHANCER_TEST__) {
    window.__BOOTDEV_ENHANCER_TEST__.hooks = {
      challengeLevel,
      challengeDifficulty,
      filterChallengeSearchArray,
      countResolvedLevels,
      challengeSearchRecords,
      parseLevelList,
      parseChallengeFilter,
      isChallengeSearchUrl,
      requiresAuth,
    };
  }

  if (DEBUG) console.debug("[catalyst] interceptor installed");
})();
