#!/usr/bin/env node
// Unit checks for the leaderboard avatar signature, exercised against the REAL
// shipped code: bootdev-extension/src/utils.js and src/leaderboard.js are
// evaluated in a vm sandbox and the helpers are pulled off the
// __BOOTDEV_ENHANCER_TEST__ hook (inert in production because that global never
// exists on the real page).
//
// Run from anywhere:  node scripts/check_leaderboard_avatar.mjs
// Exits non-zero on any failure (same spirit as the node --check gate).
//
// Why this exists: patchPersonalRow/patchAllTimeCard patch a row in place and
// never touched the avatar subtree, so a row first drawn before its profile
// arrived (fresh install, or straight after a backup import — the backup
// carries handles and snapshots but not profiles) kept its silhouette and its
// missing frame until the page was reloaded. Reproduced 2026-08-15 across all
// 40 rows. The signature is what tells the patchers the subtree changed, so the
// cases that must produce DIFFERENT signatures are pinned here.
//
// The repo has no DOM implementation, so this covers the signature and the
// markup that carries it; the in-place replacement itself is manual-verified.

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import vm from "node:vm";

const SRC = new URL("../bootdev-extension/src/", import.meta.url);

// --- evaluate utils.js + leaderboard.js in a sandbox -------------------------

const testHook = {};
const sandbox = {
  window: { __BOOTDEV_ENHANCER_TEST__: testHook },
  document: { addEventListener() {}, removeEventListener() {}, getElementById: () => null },
  location: { origin: "https://www.boot.dev", pathname: "/leaderboard" },
  console,
  URL,
  // leaderboard.js resolves ROLE_FRAME_URLS at load.
  chrome: { runtime: { getURL: (p) => `chrome-extension://catalyst-test/${p}` } },
  setTimeout: () => 0,
  clearTimeout() {},
  setInterval: () => 0,
  clearInterval() {},
};
vm.createContext(sandbox);
for (const file of ["utils.js", "leaderboard.js"]) {
  const url = new URL(file, SRC);
  vm.runInContext(readFileSync(url, "utf8"), sandbox, { filename: fileURLToPath(url) });
}

const hooks = testHook.leaderboard;
if (!hooks) {
  console.error("FAIL: leaderboard.js did not expose test hooks");
  process.exit(1);
}
const { leaderAvatarSignature, renderLeaderAvatar, getRoleFrameIndex } = hooks;
const escapeHtml = sandbox.escapeHtml;

// --- tiny assert -------------------------------------------------------------

let failures = 0;
let checks = 0;
function check(label, actual, expected) {
  checks += 1;
  const a = JSON.stringify(actual);
  const e = JSON.stringify(expected);
  if (a !== e) {
    failures += 1;
    console.error(`FAIL: ${label}\n  expected ${e}\n  got      ${a}`);
  }
}

// A personal-board row as getPersonalRows() builds it: before the profile
// fetch lands there is no avatar, no Role and no Level.
const beforeProfile = { handle: "katcodes", displayHandle: "katcodes", name: "katcodes", avatar: "", Handle: "katcodes" };
const afterProfile = {
  ...beforeProfile,
  name: "Kat",
  avatar: "https://storage.googleapis.com/avatars/kat.png",
  Role: "archmage",
  Level: 100,
};

// --- the case the bug was made of -------------------------------------------

check(
  "signature changes when the profile arrives",
  leaderAvatarSignature(beforeProfile, beforeProfile.name) !== leaderAvatarSignature(afterProfile, afterProfile.name),
  true
);
check(
  "identical entries produce an identical signature",
  leaderAvatarSignature(afterProfile, afterProfile.name) === leaderAvatarSignature({ ...afterProfile }, afterProfile.name),
  true
);
check(
  "a new avatar image changes the signature",
  leaderAvatarSignature(afterProfile, afterProfile.name) !==
    leaderAvatarSignature({ ...afterProfile, avatar: "https://storage.googleapis.com/avatars/kat2.png" }, afterProfile.name),
  true
);
check(
  "a promotion changes the signature",
  leaderAvatarSignature({ ...afterProfile, Role: "mage", Level: 95 }, afterProfile.name) !==
    leaderAvatarSignature(afterProfile, afterProfile.name),
  true
);
// The avatar's alt text is the one thing in the subtree no other patch
// statement covers, so a rename has to rebuild it too.
check(
  "a display-name change alone changes the signature",
  leaderAvatarSignature(afterProfile, "Kat") !== leaderAvatarSignature(afterProfile, "Katherine"),
  true
);

// --- frame resolution feeding the signature ----------------------------------

check("role resolves its frame index", getRoleFrameIndex({ Role: "archmage" }), 9);
check("level-only entry resolves a frame index", getRoleFrameIndex({ Level: 95 }), 8);
check("level below the first tier resolves none", getRoleFrameIndex({ Level: 4 }), -1);
check("unknown entry resolves none", getRoleFrameIndex({}), -1);
// Boot.dev picks the frame from level. The role names were re-ordered when the
// tiers were replaced (2026-11-13), so a role stored under the old scheme must
// not override the level, and the name map follows the current order.
check("level wins over a role name from the old scheme", getRoleFrameIndex({ Role: "Pupil", Level: 25 }), 1);
check(
  "current role order resolves when no level is known",
  ["Pupil", "Apprentice", "Scholar", "Acolyte", "Disciple", "Arcanist", "Evoker", "Sorcerer", "Mage", "Archmage"].map(
    (Role) => getRoleFrameIndex({ Role })
  ),
  [0, 1, 2, 3, 4, 5, 6, 7, 8, 9]
);
// num(null) is 0, which would read a missing level as "below the first tier".
check("a null level falls through to the role", getRoleFrameIndex({ Role: "Apprentice", Level: null }), 1);
check("level bands match the tiers", [10, 19, 20, 99, 100, 220].map((Level) => getRoleFrameIndex({ Level })), [0, 0, 1, 8, 9, 9]);
check("bundled frame is the webp asset", hooks.getRoleFrameUrl({ Level: 100 }), "chrome-extension://catalyst-test/assets/frames/9.webp");

// --- frame drift: native frames compared with the bundled set ----------------
// Probing Boot.dev's old URLs could not see the 2026-11-13 art change (the old
// files kept answering 200), so the check reads what the leaderboard renders.

const { findNativeFrameDrift } = hooks;
const nativeArchmage = { src: "/_nuxt/9.Boakwkj9.webp", transform: "scale(1.25)" };
check(
  "frames matching the bundled set report nothing",
  findNativeFrameDrift([nativeArchmage, { src: "/_nuxt/0.PXCuyib3.webp", transform: "scale(1.65)" }]),
  []
);
check(
  "an absolute src resolves to the same path",
  findNativeFrameDrift([{ ...nativeArchmage, src: "https://www.boot.dev/_nuxt/9.Boakwkj9.webp" }]),
  []
);
check(
  "replaced art is reported once per path",
  findNativeFrameDrift([
    { src: "/_nuxt/9.Cmx5X891.png", transform: "scale(1.25)" },
    { src: "/_nuxt/9.Cmx5X891.png", transform: "scale(1.25)" },
  ]),
  ["unrecognized frame /_nuxt/9.Cmx5X891.png"]
);
check(
  "a changed tier scale is reported",
  findNativeFrameDrift([{ ...nativeArchmage, transform: "scale(1.3)" }]),
  ["tier 9 scaled 1.3, Catalyst uses 1.25"]
);
check("a frame with no inline scale reports nothing", findNativeFrameDrift([{ src: nativeArchmage.src }]), []);
check(
  "role and equivalent level agree",
  leaderAvatarSignature({ ...afterProfile, Role: undefined }, afterProfile.name) ===
    leaderAvatarSignature(afterProfile, afterProfile.name),
  true
);

// --- the markup carries the signature ----------------------------------------

for (const [label, entry, name] of [
  ["profile-less row", beforeProfile, beforeProfile.name],
  ["complete row", afterProfile, afterProfile.name],
  ["url needing escaping", { ...afterProfile, avatar: "https://x.test/a.png?w=1&h=2" }, afterProfile.name],
]) {
  const markup = renderLeaderAvatar(entry, name);
  const expected = `data-be-avatar-sig="${escapeHtml(leaderAvatarSignature(entry, name))}"`;
  check(`${label}: markup stamps the signature`, markup.includes(expected), true);
}

check(
  "profile-less row renders the silhouette and no frame",
  (() => {
    const markup = renderLeaderAvatar(beforeProfile, beforeProfile.name);
    return markup.includes("be-leader-avatar-fallback") && !markup.includes("be-leader-frame");
  })(),
  true
);
check(
  "complete row renders both the image and the frame",
  (() => {
    const markup = renderLeaderAvatar(afterProfile, afterProfile.name);
    return markup.includes("be-leader-avatar-img") && markup.includes("be-leader-frame");
  })(),
  true
);

// --- casing: a board entry renders identically either way --------------------
// The rows above are the shape getPersonalRows() builds. These are raw API
// entries, which is where the 2026-08-19 PascalCase -> camelCase migration hit:
// ProfileImageURL and Role/Level stopped resolving, so every row fell back to a
// silhouette with no frame while still rendering. Same entry, both spellings,
// same output.

const apiEntryPascal = {
  Handle: "katcodes", FirstName: "Kat", Role: "archmage", Level: 100,
  ProfileImageURL: "https://storage.googleapis.com/avatars/kat.png",
};
const apiEntryCamel = {
  handle: "katcodes", firstName: "Kat", role: "archmage", level: 100,
  profileImageURL: "https://storage.googleapis.com/avatars/kat.png",
};

check(
  "casing: signature identical for a PascalCase and camelCase entry",
  leaderAvatarSignature(apiEntryCamel, "Kat"),
  leaderAvatarSignature(apiEntryPascal, "Kat")
);
check(
  "casing: camelCase entry resolves its role frame",
  getRoleFrameIndex(apiEntryCamel),
  getRoleFrameIndex(apiEntryPascal)
);
check(
  "casing: camelCase entry renders the image and the frame",
  (() => {
    const markup = renderLeaderAvatar(apiEntryCamel, "Kat");
    return markup.includes("be-leader-avatar-img") && markup.includes("be-leader-frame");
  })(),
  true
);
check(
  "casing: an entry readable in neither spelling still renders the silhouette",
  (() => {
    const markup = renderLeaderAvatar({ Handle: "x", pfp: "y.png", rank: "archmage" }, "x");
    return markup.includes("be-leader-avatar-fallback") && !markup.includes("be-leader-frame");
  })(),
  true
);

// --- report ------------------------------------------------------------------

if (failures) {
  console.error(`\n${failures} of ${checks} checks failed`);
  process.exit(1);
}
console.log(`ok — ${checks} checks passed`);
