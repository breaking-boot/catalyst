// nextLesson.js
// Next Lesson top-nav shortcut and Alt+N keyboard shortcut.
// Source of truth: /v1/dashboard_content -> CurrentLessonUUID.

const NEXT_LESSON_KEY = "be_next_lesson_href";

let nextLessonHref = null;
let nextLessonRefreshRequestedAt = 0;
let nextLessonKeydownHandler = null;

// The nav link is injected only after Vue has hydrated the page. See the
// hydration watcher in injected.js for why: an extra child present in the nav
// list at hydration time displaces every following label against its href, and
// the measured result was Boot.dev's own "Leaderboard" item pointing at
// /pricing. `notePageHydrated` is called from the content-script router when
// the page context reports mount complete; it stays true for the life of the
// document, because hydration happens once and client-side re-renders are
// safe.
let pageHydrated = false;
// Set when the coherence check below finds a displaced nav anyway. The link
// stays out for the rest of the document rather than being re-added on the
// next scan, so a broken assumption costs this feature and nothing else.
let navInjectionAbandoned = false;

function notePageHydrated(reason) {
  if (pageHydrated) return;
  pageHydrated = true;
  if (reason === "timeout") {
    console.debug("[catalyst] hydration not detected; injecting the nav link on the timeout path");
  }
  renderNextLessonNav();
}

// Boot.dev's own nav items, and where each one's href should start. Used only
// to answer "did our injection displace this nav?", never to repair it.
const NAV_LINK_EXPECTATIONS = [
  { label: "dashboard", href: /^\/dashboard/ },
  { label: "courses", href: /^\/courses/ },
  { label: "training", href: /^\/training/ },
  { label: "billing", href: /^\/(pricing|billing|settings)/ },
  { label: "leaderboard", href: /^\/leaderboard/ },
  { label: "community", href: /(community|discord)/i },
  { label: "guilds", href: /^\/guilds/ },
];

// True only for the DISPLACEMENT signature: a known nav label carrying a
// different known label's href. Boot.dev simply changing where one of its own
// items points is not displacement and must not disable the feature — which is
// why a plain "href does not match its own pattern" is deliberately not enough.
function navLooksDisplaced() {
  for (const link of document.querySelectorAll("nav a[href]")) {
    if (link.id === "be-next-lesson-nav") continue;
    const label = normalizeText(link.textContent).toLowerCase();
    const rule = NAV_LINK_EXPECTATIONS.find((item) => item.label === label);
    if (!rule) continue;
    const href = link.getAttribute("href") || "";
    if (rule.href.test(href)) continue;
    if (NAV_LINK_EXPECTATIONS.some((other) => other !== rule && other.href.test(href))) return true;
  }
  return false;
}

function isDashboardPage() {
  return /^\/dashboard\/?$/.test(location.pathname);
}

function isLessonPage() {
  return /^\/lessons\//.test(location.pathname);
}

function normalizeLessonHref(value) {
  if (!value) return null;
  const raw = String(value).trim();
  if (!raw) return null;

  if (/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(raw)) {
    return `/lessons/${raw}`;
  }

  try {
    const parsed = new URL(raw, location.origin);
    if (parsed.origin !== location.origin && parsed.hostname !== "www.boot.dev") return null;
    if (!parsed.pathname.startsWith("/lessons/")) return null;
    return parsed.pathname + parsed.search + parsed.hash;
  } catch (_) {
    return null;
  }
}

async function loadNextLessonHref() {
  const stored = (await chromeGet(NEXT_LESSON_KEY)) || {};
  if (enhancerStopped) return;
  nextLessonHref = normalizeLessonHref(stored.href || stored);
}

// ===========================================================================
// FEATURE 3: Next Lesson button in the top navigation
// ===========================================================================
async function handleDashboardContent(json) {
  const href = getDashboardLessonHref(json);
  if (href) {
    await rememberNextLessonHref(href);
    return;
  }
  // A stored href has no expiry, so if CurrentLessonUUID were ever renamed the
  // nav link would keep working and keep pointing at a lesson finished weeks
  // ago — stale rather than absent, and therefore invisible. No expiry is added
  // (that would break the legitimate "away for a while" case); the breadcrumb
  // is the fix. Only meaningful on a well-formed response, hence the shape test.
  const data = json?.data ?? json;
  if (isPlainObject(data) && Object.keys(data).length) {
    warnOnce(
      "dashboard-lesson-uuid",
      "dashboard_content had no readable CurrentLessonUUID — Next Lesson may be stale. " +
      "See getDashboardLessonHref() in nextLesson.js."
    );
  }
}

function refreshNextLessonFromDashboardSoon() {
  const now = Date.now();
  if (now - nextLessonRefreshRequestedAt < 1200) return;
  nextLessonRefreshRequestedAt = now;
  setTrackedTimeout(() => requestDashboardContentIfUseful(0), 700);
  setTrackedTimeout(() => requestDashboardContentIfUseful(0), 3000);
}

async function rememberNextLessonHref(href) {
  const normalized = normalizeLessonHref(href);
  if (!normalized || normalized === nextLessonHref) return;

  nextLessonHref = normalized;
  await chromeSet(NEXT_LESSON_KEY, { href: normalized, updatedAt: Date.now() });
  renderNextLessonNav();
}

function removeNextLessonNav() {
  document.getElementById("be-next-lesson-nav")?.remove();
}

function renderNextLessonNav() {
  if (!isFeatureEnabled("nextLesson") || navInjectionAbandoned) {
    removeNextLessonNav();
    return;
  }
  // Waiting for hydration is the whole fix; injecting before it is what
  // corrupted Boot.dev's nav. Nothing is removed here — the link simply is not
  // placed yet, and notePageHydrated re-runs this.
  if (!pageHydrated) return;
  const existing = document.getElementById("be-next-lesson-nav");
  if (!nextLessonHref) {
    existing?.remove();
    return;
  }

  waitFor(() => findTopNavInsertionPoint(), 3000).then((anchor) => {
    if (!anchor || !nextLessonHref) return;
    // FRAGILE: hashed class, may break on redeploy. `div.group` is the nav-item
    // wrapper; the `li` fallback and the anchor itself keep this working if it goes.
    const target = anchor.closest("div.group, li") || anchor;

    let link = document.getElementById("be-next-lesson-nav");
    if (!link) {
      link = document.createElement("a");
      link.id = "be-next-lesson-nav";
      link.className = "be-next-lesson-nav";
      link.textContent = "Next Lesson";
    }

    link.setAttribute("href", nextLessonHref);
    link.setAttribute("title", "Next Lesson (Alt+N)");
    link.setAttribute("aria-label", "Next Lesson (Alt+N)");
    if (link.previousElementSibling !== target || link.parentElement !== target.parentElement) {
      target.insertAdjacentElement("afterend", link);
    }

    // Belt to the hydration wait. If the nav is displaced even so, take the
    // link back out and stay out: a missing Next Lesson link is a small loss,
    // while a displaced nav sends Boot.dev's own middle clicks to the wrong
    // page. Removing our element does not repair hrefs Vue has already
    // mis-paired — only a client-side re-render does that — so this is a
    // stop-doing-harm measure, and the breadcrumb is how it gets noticed.
    if (navLooksDisplaced()) {
      link.remove();
      navInjectionAbandoned = true;
      warnOnce(
        "nav:displaced",
        "Boot.dev's nav links are displaced against their labels, so Catalyst removed its " +
        "Next Lesson link and will not re-add it on this page. This should not happen now " +
        "that the link waits for hydration — see navLooksDisplaced() in nextLesson.js."
      );
    }
  });
}

function captureNextLessonFromDom() {
  const dashboardHref = findDashboardContinueHref();
  if (dashboardHref) {
    rememberNextLessonHref(dashboardHref);
    return;
  }

  if (!nextLessonHref) {
    const lessonHref = findLessonNextHref();
    if (lessonHref) rememberNextLessonHref(lessonHref);
  }
}

function findDashboardContinueHref() {
  if (!/^\/dashboard\/?$/.test(location.pathname)) return null;

  const links = Array.from(document.querySelectorAll('a[href^="/lessons/"]'));
  const link = links.find((a) => normalizeText(a.textContent).toLowerCase() === "continue learning");
  return link?.getAttribute("href") || null;
}

function findLessonNextHref() {
  if (!/^\/lessons\//.test(location.pathname)) return null;

  const links = Array.from(document.querySelectorAll('a[href^="/lessons/"]'));
  const currentPath = location.pathname.replace(/\/$/, "");
  const nextLink = links.find((a) => {
    const path = new URL(a.getAttribute("href"), location.origin).pathname.replace(/\/$/, "");
    if (path === currentPath) return false;
    const text = normalizeText(a.textContent).toLowerCase();
    if (text === "next") return true;

    const tooltip = a.closest(".tooltip-box")?.textContent || a.parentElement?.textContent || "";
    const tooltipText = normalizeText(tooltip).toLowerCase();
    return tooltipText.includes("next") && (a.querySelector(".sr-only") || a.querySelector("svg"));
  });

  return nextLink?.getAttribute("href") || null;
}

// Every field is read in both casings via pickField (utils.js). /v1/dashboard_content
// was PascalCase when this was written and is entirely camelCase as of the
// 2026-08-15 capture, which silently broke all three tiers below: the feature
// looked healthy only because captureNextLessonFromDom() kept the stored href
// alive, one navigation behind. Boot.dev migrates per DTO and has flipped in
// both directions, so committing to camelCase alone would just re-arm the same
// failure.
function getDashboardLessonHref(json) {
  const data = json?.data ?? json;
  const explicit = normalizeLessonHref(pickField(data, "CurrentLessonUUID", "currentLessonUUID"));
  if (explicit) return explicit;

  const incomplete = findFirstIncompleteLesson(pickField(data, "CurrentCourseProgress", "currentCourseProgress"));
  if (incomplete) return normalizeLessonHref(pickField(incomplete, "UUID", "uuid"));

  const courseLesson = findFirstIncompleteLesson(pickField(data, "CurrentCourse", "currentCourse"));
  if (courseLesson) return normalizeLessonHref(pickField(courseLesson, "UUID", "uuid"));

  return null;
}

// The comparisons stay strict on purpose. An absent field must mean "unknown",
// not "incomplete" — a loose test would send the user back to lesson 1 of the
// course the next time one of these names changes.
function findFirstIncompleteLesson(progress) {
  const chapters = pickField(progress, "Chapters", "chapters");
  if (!Array.isArray(chapters)) return null;
  for (const chapter of chapters) {
    const lessons = pickField(chapter, "Lessons", "lessons");
    if (!Array.isArray(lessons)) continue;
    const lesson = lessons.find((l) =>
      pickField(l, "IsRequired", "isRequired") !== false &&
      pickField(l, "IsComplete", "isComplete") === false &&
      pickField(l, "IsReset", "isReset") !== true);
    if (lesson) return lesson;
  }
  return null;
}

function bindNextLessonShortcut() {
  if (nextLessonKeydownHandler) return;
  nextLessonKeydownHandler = (event) => {
    if (!isFeatureEnabled("nextLesson")) return;
    if (!nextLessonHref || !event.altKey || event.ctrlKey || event.metaKey || event.shiftKey) return;
    if (event.key.toLowerCase() !== "n") return;
    // Focus is deliberately not consulted: Boot.dev's own next-lesson shortcut
    // (ctrl+.) works while typing in the editor or an answer box, and Alt+N
    // means the same thing wherever you are.
    event.preventDefault();
    location.href = nextLessonHref;
  };
  document.addEventListener("keydown", nextLessonKeydownHandler);
}

// Called from stopEnhancer so the listener doesn't outlive an invalidated context.
function unbindNextLessonShortcut() {
  if (!nextLessonKeydownHandler) return;
  document.removeEventListener("keydown", nextLessonKeydownHandler);
  nextLessonKeydownHandler = null;
}

function findTopNavInsertionPoint() {
  const desktopCandidates = [
    'nav a[href="/training-grounds"]',
    'nav a[href="/training"]',
    'nav a[href="/courses"]',
    'nav a[href="/dashboard"]',
  ];

  for (const selector of desktopCandidates) {
    const link = Array.from(document.querySelectorAll(selector)).find((el) => {
      const rect = el.getBoundingClientRect();
      // Keep to links in the top nav band, not duplicates lower in the page.
      return isVisible(el) && rect.top >= 0 && rect.top < TOP_NAV_BAND_PX;
    });
    if (link) return link;
  }

  const mobileMenu = document.getElementById("mobile-menu");
  return mobileMenu?.querySelector('a[href="/training-grounds"], a[href="/training"], a[href="/courses"], a[href="/dashboard"]') || null;
}

// Test hook: scripts/check_next_lesson.mjs predefines this global before
// evaluating the file. Never defined on the real page.
if (typeof window !== "undefined" && window.__BOOTDEV_ENHANCER_TEST__) {
  window.__BOOTDEV_ENHANCER_TEST__.nextLesson = {
    getDashboardLessonHref,
    findFirstIncompleteLesson,
    normalizeLessonHref,
    navLooksDisplaced,
    NAV_LINK_EXPECTATIONS,
  };
}
