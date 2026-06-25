// injected.js
// Runs in the PAGE's JS context (not the isolated content-script world), so it
// can see and wrap the same window.fetch / XMLHttpRequest that boot.dev uses.
// It clones each api.boot.dev JSON response and relays it to the content script
// via window.postMessage. It never blocks or alters the real request.

(function () {
  const TAG = "BOOTDEV_ENHANCER";
  const API = "api.boot.dev";
  const HEADER_ALLOWLIST = new Set([
    "accept",
    "authorization",
    "content-type",
    "x-csrf-token",
    "x-xsrf-token",
  ]);
  let lastApiHeaders = {};

  function relay(url, method, status, bodyText) {
    let json = null;
    try {
      json = JSON.parse(bodyText);
    } catch (_) {
      return; // not JSON, ignore
    }
    window.postMessage(
      { source: TAG, payload: { url, method, status, json } },
      window.location.origin
    );
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

    const msg = event.data;
    if (!msg || msg.source !== TAG || msg.command !== "BE_FETCH_JSON") return;

    const url = String(msg.payload?.url || "");
    if (!url.includes(API)) return;

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
      relay(parsed.href, "GET", res.status, text);
    } catch (_) {}
  });

  console.debug("[Boot.dev Enhancer] interceptor installed");
})();
