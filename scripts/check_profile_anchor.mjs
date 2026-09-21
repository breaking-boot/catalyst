#!/usr/bin/env node
// Unit checks for the profile page's injection anchor, exercised against the
// REAL shipped code: bootdev-extension/src/utils.js and src/profile.js are
// evaluated in a vm sandbox and the helpers are pulled off the
// __BOOTDEV_ENHANCER_TEST__ hook (inert in production because that global never
// exists on the real page).
//
// Run from anywhere:  node scripts/check_profile_anchor.mjs
// Exits non-zero on any failure (same spirit as the node --check gate).
//
// Why this exists: Boot.dev rebuilt the profile page on 2026-09-18 and the
// feature's anchor lookups silently stopped describing it. Measured on the live
// page: the card carries no "@handle" text node (the "@" is an icon) and
// renders the level as separate "LEVEL" and "209" elements, so the old scope
// lookup matched nothing; the level lookup then searched the whole document,
// where the ONLY "Level <n>" text is the signed-in user's own level in the
// page header — so the badge was injected into the nav, showing whichever
// user's response had arrived last.
//
// The rules pinned here are the ones that failure violated:
//   1. the card is found first, and the anchor is taken from inside it;
//   1b. the anchor is the level progress bar's row when there is one, so the
//       badge sits under the bar whose figures it consolidates, and the name
//       heading only when the card carries no bar;
//   2. nothing in the page chrome (nav / header / mobile menu) is ever chosen;
//   3. the tightest matching container wins, so a page wrapper cannot stand in
//      for the card;
//   4. no card means NO anchor — never a document-wide fallback.
//
// The repo has no DOM implementation, so this file carries a small one: enough
// selector support for the queries profile.js actually issues.

import { readFileSync } from "node:fs";
import vm from "node:vm";

const SRC = new URL("../bootdev-extension/src/", import.meta.url);

// --- a very small DOM -------------------------------------------------------
// Supports exactly what profile.js asks for: comma-separated selectors, the
// descendant combinator ("main section"), tag names, #id and [attr] /
// [attr="value"]. Anything more would be a DOM implementation, not a test.

class El {
  constructor(tag, attrs = {}, children = []) {
    this.tagName = tag.toUpperCase();
    this.attrs = attrs;
    this.children = [];
    this.parentElement = null;
    this.text = "";
    for (const child of children) this.append(child);
  }
  append(child) {
    if (typeof child === "string") {
      this.text += (this.text ? " " : "") + child;
      return this;
    }
    child.parentElement = this;
    this.children.push(child);
    return this;
  }
  get id() { return this.attrs.id || ""; }
  getAttribute(name) { return this.attrs[name] ?? null; }
  setAttribute(name, value) { this.attrs[name] = String(value); }
  get textContent() {
    return [this.text, ...this.children.map((c) => c.textContent)].filter(Boolean).join(" ");
  }
  get descendants() {
    return this.children.flatMap((c) => [c, ...c.descendants]);
  }
  matches(selector) {
    return splitSelector(selector).some((parts) => matchChain(this, parts));
  }
  closest(selector) {
    let node = this;
    while (node) {
      if (node.matches(selector)) return node;
      node = node.parentElement;
    }
    return null;
  }
  querySelectorAll(selector) {
    return this.descendants.filter((el) => el.matches(selector));
  }
  querySelector(selector) {
    return this.querySelectorAll(selector)[0] || null;
  }
}

const splitSelector = (selector) =>
  selector.split(",").map((part) => part.trim().split(/\s+/).filter(Boolean)).filter((p) => p.length);

function matchSimple(el, simple) {
  const attr = /^\[([^\]=]+)(?:=["']?([^\]"']*)["']?)?\]$/.exec(simple);
  if (attr) {
    const value = el.getAttribute(attr[1]);
    if (value == null) return false;
    return attr[2] === undefined || value === attr[2];
  }
  if (simple.startsWith("#")) return el.id === simple.slice(1);
  return el.tagName === simple.toUpperCase();
}

// The last simple selector must match the element; the rest must match
// ancestors, in order.
function matchChain(el, parts) {
  if (!matchSimple(el, parts[parts.length - 1])) return false;
  let node = el.parentElement;
  for (let i = parts.length - 2; i >= 0; i -= 1) {
    while (node && !matchSimple(node, parts[i])) node = node.parentElement;
    if (!node) return false;
    node = node.parentElement;
  }
  return true;
}

// --- evaluate utils.js + profile.js in a sandbox ----------------------------

const testHook = {};
let root = new El("body");
const sandbox = {
  window: { __BOOTDEV_ENHANCER_TEST__: testHook },
  document: {
    addEventListener() {}, removeEventListener() {},
    getElementById: (id) => root.querySelectorAll(`[id=${JSON.stringify(id)}]`)[0] || null,
    querySelectorAll: (selector) => root.querySelectorAll(selector),
    querySelector: (selector) => root.querySelector(selector),
  },
  location: { origin: "https://www.boot.dev", pathname: "/u/a-fleming" },
  console,
  URL,
  chrome: { runtime: { getURL: (p) => `chrome-extension://catalyst-test/${p}` } },
  setTimeout: () => 0, clearTimeout() {}, setInterval: () => 0, clearInterval() {},
};
vm.createContext(sandbox);
for (const file of ["utils.js", "profile.js"]) {
  vm.runInContext(readFileSync(new URL(file, SRC), "utf8"), sandbox, { filename: file });
}
const { findProfileCard, findProfileBadgeAnchor, isPageChrome, findProfileProgressRow } = testHook.profile;

// --- page builders ----------------------------------------------------------
// Mirrors the rebuilt page as measured on 2026-09-19: the viewer's own level
// lives in the nav as a single "Level <n>" string; the profile card is a
// <section> holding the name heading, the handle WITHOUT an "@", and a
// progress bar carrying role="progressbar".

const viewerNav = () =>
  new El("nav", {}, [
    new El("div", {}, [new El("span", {}, ["Archmage"]), new El("p", {}, ["Level 209"])]),
    new El("a", { href: "/leaderboard" }, ["Leaderboard"]),
  ]);

function profilePage({ fullName, handle, level, withBar = true, extraCardText = "" }) {
  const card = new El("section", {}, [
    new El("div", {}, [
      new El("h2", {}, [fullName]),
      new El("span", {}, [handle]),
      extraCardText ? new El("p", {}, [extraCardText]) : new El("span", {}, []),
      new El("div", {}, [
        new El("span", {}, ["LEVEL"]),
        new El("span", {}, [String(level)]),
        withBar
          ? new El("div", { role: "progressbar", "aria-label": "Progress to next level", "aria-valuenow": "7716" }, [])
          : new El("span", {}, []),
        new El("span", {}, ["7,716 XP"]),
        new El("span", {}, ["17,040 XP"]),
      ]),
    ]),
  ]);
  const main = new El("main", {}, [card]);
  const bar = card.querySelector('[role="progressbar"]');
  return {
    body: new El("body", {}, [viewerNav(), main]),
    card,
    heading: card.querySelector("h2"),
    progressRow: bar ? bar.parentElement : null,
  };
}

// --- checks -----------------------------------------------------------------

let failures = 0;
const check = (name, actual, expected) => {
  const ok = actual === expected;
  if (!ok) {
    failures += 1;
    console.error(`FAIL  ${name}\n        expected: ${expected}\n        actual:   ${actual}`);
  } else {
    console.log(`ok    ${name}`);
  }
};

// 1. Own profile: the viewer's level is in the nav AND the card describes them.
{
  const page = profilePage({ fullName: "Aaron Fleming", handle: "a-fleming", level: 209 });
  root = page.body;
  const profile = { Handle: "a-fleming", FirstName: "Aaron", LastName: "Fleming", Level: 209 };
  check("own profile: card is the section", findProfileCard(profile), page.card);
  check("own profile: anchor is the progress bar's row", findProfileBadgeAnchor(profile), page.progressRow);
  check("own profile: anchor is not page chrome", isPageChrome(findProfileBadgeAnchor(profile)), false);
}

// 2. Another user's profile — the ONLY "Level <n>" on the page belongs to the
//    viewer, in the nav. This is the case that used to inject into the header.
{
  const page = profilePage({ fullName: "Saleh Rammah", handle: "young-pancake", level: 45 });
  root = page.body;
  const profile = { Handle: "young-pancake", FirstName: "Saleh", LastName: "Rammah", Level: 45 };
  const anchor = findProfileBadgeAnchor(profile);
  check("other profile: anchor is that user's progress row", anchor, page.progressRow);
  check("other profile: anchor is not in the nav", isPageChrome(anchor), false);
}

// 3. A page-level wrapper must not stand in for the card.
{
  const page = profilePage({ fullName: "Aaron Fleming", handle: "a-fleming", level: 209 });
  const wrapper = new El("section", {}, [page.card]);
  root = new El("body", {}, [viewerNav(), new El("main", {}, [wrapper])]);
  const profile = { Handle: "a-fleming", FirstName: "Aaron", LastName: "Fleming", Level: 209 };
  check("tightest container wins over its wrapper", findProfileCard(profile), page.card);
}

// 4. No card on the page -> no anchor. Never a document-wide fallback, which is
//    what reached the header.
{
  root = new El("body", {}, [viewerNav(), new El("main", {}, [new El("section", {}, ["Something else entirely"])])]);
  const profile = { Handle: "a-fleming", FirstName: "Aaron", LastName: "Fleming", Level: 209 };
  check("no card: no card", findProfileCard(profile), null);
  check("no card: no anchor", findProfileBadgeAnchor(profile), null);
}

// 5. A card without a progress bar falls back to the name heading, so a
//    redesign that drops the bar degrades rather than breaks.
{
  const page = profilePage({ fullName: "Dan Hjartland", handle: "squashd", level: 174, withBar: false });
  root = page.body;
  const profile = { Handle: "squashd", FirstName: "Dan", LastName: "Hjartland", Level: 174 };
  check("no progress bar: anchor falls back to the name heading", findProfileBadgeAnchor(profile), page.heading);
}

// 5b. The bar is preferred over the heading when both are present — the badge
//     consolidates the bar's own two labels, so it belongs beneath them.
{
  const page = profilePage({ fullName: "Aaron Fleming", handle: "a-fleming", level: 209 });
  root = page.body;
  const profile = { Handle: "a-fleming", FirstName: "Aaron", LastName: "Fleming", Level: 209 };
  const anchor = findProfileBadgeAnchor(profile);
  check("the progress row wins over the name heading", anchor === page.heading, false);
  check("and it is the bar's own row", anchor, page.progressRow);
}

// 6. A card whose text runs past the wrapper ceiling is not a card.
{
  const page = profilePage({
    fullName: "Aaron Fleming", handle: "a-fleming", level: 209,
    extraCardText: "x".repeat(testHook.profile.constants.PROFILE_CARD_MAX_TEXT + 50),
  });
  root = page.body;
  const profile = { Handle: "a-fleming", FirstName: "Aaron", LastName: "Fleming", Level: 209 };
  check("oversized container is rejected", findProfileCard(profile), null);
}

// 6b. A progress bar sitting in the page chrome is never an anchor — the nav
//     carries its own level progress meter.
{
  const navBar = new El("nav", {}, [
    new El("div", {}, [new El("div", { role: "progressbar", "aria-label": "Progress to next level" }, [])]),
  ]);
  const card = new El("section", {}, [new El("h2", {}, ["Aaron Fleming"])]);
  root = new El("body", {}, [navBar, new El("main", {}, [card])]);
  check("a progress bar in the chrome is not used as the row", findProfileProgressRow(card), null);
}

// 7. The chrome test covers all three containers.
{
  const inNav = new El("nav", {}, [new El("h2", {}, ["Aaron Fleming"])]);
  const inHeader = new El("header", {}, [new El("h2", {}, ["Aaron Fleming"])]);
  const inMobile = new El("div", { id: "mobile-menu" }, [new El("h2", {}, ["Aaron Fleming"])]);
  root = new El("body", {}, [inNav, inHeader, inMobile]);
  check("nav counts as chrome", isPageChrome(inNav.querySelector("h2")), true);
  check("header counts as chrome", isPageChrome(inHeader.querySelector("h2")), true);
  check("mobile menu counts as chrome", isPageChrome(inMobile.querySelector("h2")), true);
}

console.log(failures ? `\n${failures} check(s) failed` : "\nall profile anchor checks passed");
process.exit(failures ? 1 : 0);
