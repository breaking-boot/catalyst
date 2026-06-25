// injected.js
// Runs in the PAGE's JS context (not the isolated content-script world), so it
// can see and wrap the same window.fetch / XMLHttpRequest that boot.dev uses.
// It clones each api.boot.dev JSON response and relays it to the content script
// via window.postMessage. It never blocks or alters the real request.

(function () {
  const TAG = "BOOTDEV_ENHANCER";
  const API = "api.boot.dev";

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

  // --- wrap fetch ---
  const origFetch = window.fetch;
  window.fetch = async function (...args) {
    const res = await origFetch.apply(this, args);
    try {
      const url = typeof args[0] === "string" ? args[0] : args[0]?.url;
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
  const origSend = XMLHttpRequest.prototype.send;
  XMLHttpRequest.prototype.open = function (method, url, ...rest) {
    this.__be_url = url;
    this.__be_method = method;
    return origOpen.call(this, method, url, ...rest);
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

  console.debug("[Boot.dev Enhancer] interceptor installed");
})();
