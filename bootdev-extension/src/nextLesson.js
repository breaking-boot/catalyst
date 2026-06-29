// nextLesson.js
// Next Lesson top-nav shortcut and Alt+N keyboard shortcut.
// Source of truth: /v1/dashboard_content -> CurrentLessonUUID.

const NEXT_LESSON_KEY = "be_next_lesson_href";

let nextLessonHref = null;
let nextLessonRefreshRequestedAt = 0;

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
  if (href) await rememberNextLessonHref(href);
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
  if (!isFeatureEnabled("nextLesson")) {
    removeNextLessonNav();
    return;
  }
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

function getDashboardLessonHref(json) {
  const data = json?.data ?? json;
  const explicit = normalizeLessonHref(data?.CurrentLessonUUID);
  if (explicit) return explicit;

  const incomplete = findFirstIncompleteLesson(data?.CurrentCourseProgress);
  if (incomplete?.UUID) return normalizeLessonHref(incomplete.UUID);

  const courseLesson = findFirstIncompleteLesson(data?.CurrentCourse);
  if (courseLesson?.UUID) return normalizeLessonHref(courseLesson.UUID);

  return null;
}

function findFirstIncompleteLesson(progress) {
  const chapters = Array.isArray(progress?.Chapters) ? progress.Chapters : [];
  for (const chapter of chapters) {
    const lessons = Array.isArray(chapter?.Lessons) ? chapter.Lessons : [];
    const lesson = lessons.find((l) => l?.IsRequired !== false && l?.IsComplete === false && l?.IsReset !== true);
    if (lesson) return lesson;
  }
  return null;
}

function bindNextLessonShortcut() {
  document.addEventListener("keydown", (event) => {
    if (!isFeatureEnabled("nextLesson")) return;
    if (!nextLessonHref || !event.altKey || event.ctrlKey || event.metaKey || event.shiftKey) return;
    if (event.key.toLowerCase() !== "n") return;
    if (isEditableTarget(event.target)) return;

    event.preventDefault();
    location.href = nextLessonHref;
  });
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
      // top < 90: keep to links in the top nav band, not duplicates lower in the page
      return isVisible(el) && rect.top >= 0 && rect.top < 90;
    });
    if (link) return link;
  }

  const mobileMenu = document.getElementById("mobile-menu");
  return mobileMenu?.querySelector('a[href="/training-grounds"], a[href="/training"], a[href="/courses"], a[href="/dashboard"]') || null;
}
