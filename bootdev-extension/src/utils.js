// utils.js
// Shared helpers available to all feature modules. Loaded first by manifest.json.
// No feature logic here.

let enhancerStopped = false;
let trackedTimeouts = new Set();

// Pixels from the top within which a link is treated as part of the top nav band,
// used to tell the real nav links from scrolled-past duplicates lower in the page.
const TOP_NAV_BAND_PX = 90;

// Maintainer-only preview of the "boot.dev declined asset bundling" fallback:
// set be_use_bundled_native_art to false in chrome.storage.local to drop the
// bundled map texture and rank frames (they revert to a plain gradient / no
// frame). Default on. Loaded once at startup by loadNativeArtFlag.
const NATIVE_ART_FLAG_KEY = "be_use_bundled_native_art";
let useBundledNativeArt = true;
async function loadNativeArtFlag() {
  if ((await chromeGet(NATIVE_ART_FLAG_KEY)) === false) useBundledNativeArt = false;
}

function num(v) {
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}
function pct(v) {
  const n = num(v);
  if (n == null) return null;
  return n > 0 && n <= 1 ? n * 100 : n;
}
function fmtPct(v) {
  return v == null ? "-" : `${Math.round(v)}%`;
}
function fmtNum(v) {
  return v === "?" || v == null ? "?" : Number(v).toLocaleString();
}
function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, (c) =>
    ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c])
  );
}

function setTrackedInterval(fn, ms) {
  const id = setInterval(() => {
    if (enhancerStopped) {
      clearInterval(id);
      return;
    }
    try {
      fn();
    } catch (err) {
      handleAsyncError(err, "interval");
    }
  }, ms);
  return id;
}

function setTrackedTimeout(fn, ms) {
  const id = setTimeout(() => {
    trackedTimeouts.delete(id);
    if (enhancerStopped) return;
    try {
      fn();
    } catch (err) {
      handleAsyncError(err, "timeout");
    }
  }, ms);
  trackedTimeouts.add(id);
  return id;
}

function clearTrackedTimeout(id) {
  if (!id) return;
  clearTimeout(id);
  trackedTimeouts.delete(id);
}

function normalizeText(s) {
  return String(s || "").replace(/\s+/g, " ").trim();
}
function clamp(value, min, max) {
  const n = Number(value);
  const safeMin = Number.isFinite(min) ? min : 0;
  const safeMax = Math.max(safeMin, Number.isFinite(max) ? max : safeMin);
  if (!Number.isFinite(n)) return safeMin;
  return Math.min(safeMax, Math.max(safeMin, n));
}
function isVisible(el) {
  const rect = el.getBoundingClientRect();
  return rect.width > 0 && rect.height > 0;
}
// Poll for an element/condition (SPA routes render async). Resolves with the
// truthy value once available, or null on timeout/teardown; never rejects, so
// callers must null-check the result.
function waitFor(fn, timeout = 8000, interval = 150) {
  return new Promise((resolve) => {
    const start = Date.now();
    const tick = () => {
      if (enhancerStopped) return resolve(null);
      const v = fn();
      if (v) return resolve(v);
      if (Date.now() - start > timeout) return resolve(null);
      setTrackedTimeout(tick, interval);
    };
    tick();
  });
}

function isPlainObject(value) {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function localDateKey() {
  return new Date().toLocaleDateString("en-CA");
}

function isEditableTarget(target) {
  if (!(target instanceof Element)) return false;
  return Boolean(target.closest("input, textarea, select, [contenteditable=''], [contenteditable='true']"));
}

function normalizeHandle(value) {
  const raw = String(value || "")
    .trim()
    .replace(/^https?:\/\/(?:www\.)?boot\.dev\/u\//i, "")
    .replace(/^\/u\//i, "")
    .replace(/^@/, "");
  return raw.split(/[/?#\s]/)[0].toLowerCase();
}

function normalizeAssetUrl(value) {
  const raw = String(value || "").trim();
  if (!raw) return "";
  try {
    return new URL(raw, location.origin).href;
  } catch (_) {
    return raw;
  }
}

function isValidHandle(handle) {
  return /^[a-z0-9][a-z0-9_-]{0,39}$/i.test(String(handle || ""));
}

// Toasts stack in a shared bottom-centre container (like the site's own
// notifications) so a newer toast no longer covers an older one. Newest is
// appended at the bottom, nearest the corner; older ones float up.
function toast(text) {
  let stack = document.getElementById("be-toast-stack");
  if (!stack) {
    stack = document.createElement("div");
    stack.id = "be-toast-stack";
    stack.className = "be-toast-stack";
    document.body.appendChild(stack);
  }

  const t = document.createElement("div");
  t.className = "be-toast";
  t.textContent = text;
  stack.appendChild(t);
  requestAnimationFrame(() => t.classList.add("be-toast-in"));
  setTimeout(() => {
    t.classList.remove("be-toast-in");
    setTimeout(() => {
      t.remove();
      if (stack && !stack.childElementCount) stack.remove();
    }, 400);
  }, 6000);
}

function getChromeLastError() {
  try {
    return chrome.runtime?.lastError || null;
  } catch (err) {
    return err;
  }
}

function handleChromeApiError(err) {
  if (isExtensionContextInvalidatedError(err)) {
    stopEnhancer();
    return;
  }
  console.warn("[catalyst] Chrome API error", safeErrorMessage(err));
}

function chromeGet(key) {
  return new Promise((resolve) => {
    if (enhancerStopped || !key) {
      resolve(undefined);
      return;
    }
    try {
      chrome.storage.local.get(key, (o) => {
        const err = getChromeLastError();
        if (err) {
          handleChromeApiError(err);
          resolve(undefined);
          return;
        }
        resolve(o?.[key]);
      });
    } catch (err) {
      handleChromeApiError(err);
      resolve(undefined);
    }
  });
}
function chromeSet(key, val) {
  return new Promise((resolve) => {
    if (enhancerStopped || !key || val === undefined) {
      resolve(false);
      return;
    }
    try {
      chrome.storage.local.set({ [key]: val }, () => {
        const err = getChromeLastError();
        if (err) {
          handleChromeApiError(err);
          resolve(false);
          return;
        }
        resolve(true);
      });
    } catch (err) {
      handleChromeApiError(err);
      resolve(false);
    }
  });
}

// Settings live in chrome.storage.sync so they roam across a user's devices.
// Mirrors chromeGet/chromeSet, including the graceful degradation on errors
// (sync still works as a local store when the user isn't signed into Chrome).
function chromeGetSync(key) {
  return new Promise((resolve) => {
    if (enhancerStopped || !key) {
      resolve(undefined);
      return;
    }
    try {
      chrome.storage.sync.get(key, (o) => {
        const err = getChromeLastError();
        if (err) {
          handleChromeApiError(err);
          resolve(undefined);
          return;
        }
        resolve(o?.[key]);
      });
    } catch (err) {
      handleChromeApiError(err);
      resolve(undefined);
    }
  });
}
function chromeSetSync(key, val) {
  return new Promise((resolve) => {
    if (enhancerStopped || !key || val === undefined) {
      resolve(false);
      return;
    }
    try {
      chrome.storage.sync.set({ [key]: val }, () => {
        const err = getChromeLastError();
        if (err) {
          handleChromeApiError(err);
          resolve(false);
          return;
        }
        resolve(true);
      });
    } catch (err) {
      handleChromeApiError(err);
      resolve(false);
    }
  });
}

function handleAsyncError(err, scope = "runtime") {
  if (isExtensionContextInvalidatedError(err)) {
    stopEnhancer();
    return;
  }
  console.warn(`[catalyst] ${scope} error`, safeErrorMessage(err));
}

function safeErrorMessage(err) {
  return err?.message || String(err || "unknown error");
}

function isExtensionContextInvalidatedError(err) {
  return /extension context invalidated/i.test(safeErrorMessage(err));
}

function findHeadingByText(text) {
  const target = normalizeText(text).toLowerCase();
  return Array.from(document.querySelectorAll("h1,h2,h3,[role='heading']")).find(
    (el) => normalizeText(el.textContent).toLowerCase() === target
  );
}
function findHeadingAfter(anchor, text) {
  const target = normalizeText(text).toLowerCase();
  const headings = Array.from(document.querySelectorAll("h1,h2,h3,[role='heading']"));
  return headings.find((el) => {
    if (normalizeText(el.textContent).toLowerCase() !== target) return false;
    if (!anchor) return true;
    return Boolean(anchor.compareDocumentPosition(el) & Node.DOCUMENT_POSITION_FOLLOWING);
  });
}
function findElementByText(text) {
  const target = normalizeText(text).toLowerCase();
  return Array.from(document.querySelectorAll("main *, #__nuxt *")).find(
    (el) => normalizeText(el.textContent).toLowerCase() === target
  );
}
// Longest text an element may contain and still count as a "small" leaf label
// rather than a wrapping container.
const SMALL_TEXT_MAX_LEN = 80;
function findSmallTextElement(root, text, exact) {
  const target = normalizeText(text).toLowerCase();
  return Array.from(root.querySelectorAll("*")).find((el) => {
    if (el.id === "be-total-xp") return false;
    const value = normalizeText(el.textContent);
    if (value.length > SMALL_TEXT_MAX_LEN) return false; // skip containers; want a leaf label
    const lowered = value.toLowerCase();
    return exact ? lowered === target : lowered.includes(target);
  });
}
