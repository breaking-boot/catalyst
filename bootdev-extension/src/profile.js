// profile.js
// Cumulative XP display on public user profile pages (/u/<username>).
// Handles: handleProfileStats (and any related helpers).

function isProfilePage() {
  return /^\/u\/[^/]+\/?$/.test(location.pathname);
}

// ===========================================================================
// FEATURE 2: Cumulative XP on profiles
// ===========================================================================
function handlePublicUserResponse(username, isStats, json) {
  updatePersonalUserData(username, isStats, json);
  if (!isStats) {
    handleProfileStats(json);
  }
}

function handleProfileStats(json) {
  if (!isProfilePage()) return;

  const profile = json?.data ?? json;
  const totalXp = profile?.XP ?? null;
  if (totalXp == null) return;

  waitFor(() => findProfileLevelAnchor(profile) || findProfileAnchor(profile)).then((anchor) => {
    if (!isProfilePage()) return;
    if (!anchor) return;
    let badge = document.getElementById("be-total-xp");
    if (!badge) {
      badge = document.createElement("div");
      badge.id = "be-total-xp";
      badge.className = "be-profile-total-xp";
    }
    const progress = getLevelProgress(profile);
    const progressMarkup = progress
      ? `<div class="be-profile-level-xp">${fmtNum(progress.current)} / ${fmtNum(progress.total)} XP</div>
         <div class="be-profile-remaining-xp">Remaining: <strong>${fmtNum(progress.remaining)} XP</strong></div>`
      : "";
    badge.innerHTML = `<div>Total XP: <strong>${fmtNum(totalXp)}</strong></div>${progressMarkup}`;
    anchor.insertAdjacentElement("afterend", badge);
    if (progress) removeNativeProfileLevelXp(anchor, progress.current);
    renderProfilePersonalAddButton(profile, badge);
  });
}

function getLevelProgress(profile) {
  const current = num(profile?.XPForLevel);
  const total = num(profile?.XPTotalForLevel);
  if (current == null || total == null || total <= 0) return null;

  return {
    current,
    total,
    remaining: Math.max(0, total - current),
  };
}

function findProfileAnchor(profile) {
  const fullName = getProfileFullName(profile);
  return (
    (fullName && findHeadingByText(fullName)) ||
    (profile?.Handle && findElementByText(`@ ${profile.Handle}`)) ||
    (profile?.Handle && findElementByText(`@${profile.Handle}`)) ||
    null
  );
}

function findProfileLevelAnchor(profile) {
  const level = profile?.Level;
  if (level == null) return null;

  const levelText = `Level ${level}`;
  const scope = findProfileSummaryScope(profile) || document;
  return (
    findSmallTextElement(scope, levelText, true) ||
    findSmallTextElement(scope, levelText, false)
  );
}

function findProfileSummaryScope(profile) {
  const fullName = getProfileFullName(profile);
  const levelText = profile?.Level == null ? "" : `Level ${profile.Level}`;
  const handleNeedles = profile?.Handle
    ? [`@ ${profile.Handle}`, `@${profile.Handle}`]
    : [];
  if (!fullName && !handleNeedles.length && !levelText) return null;

  const candidates = Array.from(document.querySelectorAll("main section, main article, main div, #__nuxt section, #__nuxt article, #__nuxt div"))
    .map((el) => ({ el, text: normalizeText(el.textContent) }))
    .filter(({ text }) => {
      if (text.length > 650) return false; // skip page-level wrappers; the summary card's text is short
      if (fullName && !text.includes(fullName)) return false;
      if (handleNeedles.length && !handleNeedles.some((handle) => text.includes(handle))) return false;
      if (levelText && !text.includes(levelText)) return false;
      return true;
    })
    .sort((a, b) => a.text.length - b.text.length);

  return candidates[0]?.el || null;
}

function getProfileFullName(profile) {
  return [profile?.FirstName, profile?.LastName]
    .filter(Boolean)
    .join(" ")
    .trim();
}

function removeProfileXpBadge() {
  document.getElementById("be-total-xp")?.remove();
  document.getElementById("be-profile-personal-add")?.remove();
}

function removeNativeProfileLevelXp(anchor, currentXp) {
  const target = `${fmtNum(currentXp)} XP`.toLowerCase();
  const scope = findProfileSummaryScope({}) || anchor.parentElement || document;
  const duplicate = Array.from(scope.querySelectorAll("*"))
    .filter((el) => !el.closest("#be-total-xp"))
    .map((el) => ({ el, text: normalizeText(el.textContent).toLowerCase() }))
    .filter(({ text }) => text === target)
    .sort((a, b) => a.el.children.length - b.el.children.length)[0]?.el;

  duplicate?.remove();
}

function renderProfilePersonalAddButton(profile, anchor) {
  const handle = normalizeHandle(profile?.Handle);
  if (!isValidHandle(handle) || !anchor) return;

  let button = document.getElementById("be-profile-personal-add");
  if (!button) {
    button = document.createElement("button");
    button.id = "be-profile-personal-add";
    button.className = "be-profile-personal-add";
    button.type = "button";
  }

  const added = isPersonalHandle(handle);
  button.disabled = added;
  button.textContent = added ? "In Personal Leaderboards" : "Add to Personal Leaderboards";
  button.onclick = added
    ? null
    : async () => {
        button.disabled = true;
        button.textContent = "Adding...";
        await addPersonalHandle(handle);
        const message = personalFeedback?.text || (isPersonalHandle(handle) ? `Added @${handle}` : "Could not add user");
        toast(message);
        renderProfilePersonalAddButton(profile, anchor);
      };

  anchor.insertAdjacentElement("afterend", button);
}
