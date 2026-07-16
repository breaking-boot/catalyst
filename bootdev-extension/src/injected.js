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
  const AUTH_REQUIRED_PATHS = new Set([
    "/v1/boss_events_progress",
    "/v1/dashboard_content",
  ]);
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
  // --- Training Grounds difficulty filter ---------------------------------
  // The tier bounds are Catalyst's UI mapping of boot.dev's difficulty icons
  // (difficulty_easy/medium/hard filenames); the API has no tier concept and
  // no difficulty parameter (probe-verified). Keep in sync with
  // CHALLENGE_TIERS in trainingGrounds.js.
  const DIFFICULTY_TIERS = { easy: [1, 4], medium: [5, 7], hard: [8, 10] };
  const CHALLENGE_SEARCH_PATH = "/v1/challenges/search";
  const DIFF_URL_PARAM = "diff";
  // null until the content script pushes state; null means "touch nothing".
  let challengeFilter = null;

  function tierOfDifficulty(value) {
    const n = Number(value);
    if (!Number.isInteger(n)) return null;
    for (const tier of Object.keys(DIFFICULTY_TIERS)) {
      const [lo, hi] = DIFFICULTY_TIERS[tier];
      if (n >= lo && n <= hi) return tier;
    }
    return null;
  }

  // Records with no resolvable tier are always kept: hiding a challenge on
  // bad data is worse than showing an occasional mis-tiered one.
  function filterChallengeSearchArray(records, tierSet) {
    return records.filter((record) => {
      const tier = tierOfDifficulty(record?.Topics?.Difficulty);
      return tier === null || tierSet.has(tier);
    });
  }

  function normalizeChallengeFilter(payload) {
    const requested = Array.isArray(payload?.tiers) ? payload.tiers : [];
    return {
      enabled: payload?.enabled === true,
      // Known tiers only, deduped, in canonical order.
      tiers: Object.keys(DIFFICULTY_TIERS).filter((t) => requested.includes(t)),
    };
  }

  // All three tiers selected filters nothing, so it counts as inactive too.
  function challengeFilterActive() {
    return Boolean(
      challengeFilter &&
        challengeFilter.enabled &&
        challengeFilter.tiers.length >= 1 &&
        challengeFilter.tiers.length < Object.keys(DIFFICULTY_TIERS).length
    );
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
      const text = await res.clone().text();
      const json = JSON.parse(text);
      if (!Array.isArray(json)) return null;
      const filtered = filterChallengeSearchArray(json, new Set(challengeFilter.tiers));
      const body = JSON.stringify(filtered);
      relay(url, method, res.status, body, null, {
        filtered: true,
        originalCount: json.length,
        appliedTiers: challengeFilter.tiers.slice(),
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

  // Makes the page re-run its current search so a changed difficulty selection
  // shows up. Primary: re-push the current route through the page's Vue router
  // with a `diff` param carrying the selection — the URL changes exactly when
  // the selection does, the server provably ignores the param, and the
  // frontend refetches on the changed route (all owner-verified). __vue_app__
  // is private Vue API, hence the guard; fallback is a hard reload, which
  // re-runs the search because the URL carries q/t/l.
  function refreshChallengeSearch() {
    try {
      const router = document.querySelector("#__nuxt")?.__vue_app__?.config
        ?.globalProperties?.$router;
      const current = router?.currentRoute?.value;
      if (router && current) {
        const query = { ...(current.query || {}) };
        if (challengeFilterActive()) {
          query[DIFF_URL_PARAM] = challengeFilter.tiers.join(",");
        } else {
          delete query[DIFF_URL_PARAM];
        }
        // An identical push is a router no-op (no refetch); only the hard
        // reload helps then.
        if (JSON.stringify(query) !== JSON.stringify(current.query || {})) {
          router.push({ path: window.location.pathname, query });
          return;
        }
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
    return AUTH_REQUIRED_PATHS.has(pathname);
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
        // Challenge search with an active difficulty selection: hand the page
        // a filtered copy so its own list/count/pagination render the reduced
        // set. Any hiccup falls through to the untouched response below.
        if (
          res.ok &&
          String(method).toUpperCase() === "GET" &&
          isChallengeSearchUrl(url) &&
          challengeFilterActive()
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

    if (msg.command === "BE_SET_CHALLENGE_FILTER") {
      challengeFilter = normalizeChallengeFilter(msg.payload);
      return;
    }
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
      tierOfDifficulty,
      filterChallengeSearchArray,
      normalizeChallengeFilter,
      isChallengeSearchUrl,
    };
  }

  if (DEBUG) console.debug("[catalyst] interceptor installed");
})();
