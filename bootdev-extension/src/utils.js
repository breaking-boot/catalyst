// utils.js
// Shared helpers available to all feature modules. Loaded first by manifest.json.
// No feature logic here.

let enhancerStopped = false;
let trackedTimeouts = new Set();

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
// Poll for an element/condition (SPA routes render async).
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

function normalizeImageUrl(value) {
  if (!value) return "";
  try {
    const parsed = new URL(value, location.origin);
    return `${parsed.origin}${parsed.pathname}`;
  } catch (_) {
    return String(value).split("?")[0];
  }
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

function toast(text) {
  const t = document.createElement("div");
  t.className = "be-toast";
  t.textContent = text;
  document.body.appendChild(t);
  requestAnimationFrame(() => t.classList.add("be-toast-in"));
  setTimeout(() => {
    t.classList.remove("be-toast-in");
    setTimeout(() => t.remove(), 400);
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
function findSmallTextElement(root, text, exact) {
  const target = normalizeText(text).toLowerCase();
  return Array.from(root.querySelectorAll("*")).find((el) => {
    if (el.id === "be-total-xp") return false;
    const value = normalizeText(el.textContent);
    if (value.length > 80) return false;
    const lowered = value.toLowerCase();
    return exact ? lowered === target : lowered.includes(target);
  });
}
