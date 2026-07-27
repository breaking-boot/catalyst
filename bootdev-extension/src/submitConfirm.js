// submitConfirm.js
// Optional confirmation before a code-lesson submission (setting `submitConfirm`,
// default OFF). Guards pointer activation only: a capture-phase click listener
// on document cancels the first click and opens a dialog; confirming re-invokes
// Boot.dev's own Submit button. The native control is never replaced, wrapped,
// or cloned, so its disabled state, loading animation, and tooltip stay as the
// site defines them.
//
// Two facts make this safe (verified 2026-07-26, see the evidence bundle):
//   - The Submit button carries a single bubble-phase `click` listener, so a
//     document capture listener runs first and can cancel it.
//   - Guarding only trusted clicks with a click count (event.detail > 0) means
//     keyboard activation and every programmatic .click() pass through
//     untouched — including our own on confirm. That preserves Boot.dev's
//     ctrl+shift+enter shortcut and makes recursion structurally impossible.
//
// Evidence and design decisions: reference_data/catalyst_versions/
// v0.11.0_submit_confirmation_and_cli_shortcuts/implementation_plan.md

const SUBMIT_CONFIRM_FEATURE = "submitConfirm";
const SUBMIT_CONFIRM_DIALOG_ID = "be-submit-confirm";
const SUBMIT_CONFIRM_TITLE_ID = "be-submit-confirm-title";
const SUBMIT_CONFIRM_BODY_ID = "be-submit-confirm-body";
// The console controls container. A plain id, not a hashed class.
const SUBMIT_CONSOLE_SCOPE_ID = "console-resizer";

let submitConfirmClickHandler = null;

// ---------------------------------------------------------------------------
// Pure helpers (exercised by scripts/check_lesson_features.mjs)
// ---------------------------------------------------------------------------

// Pointer activation: a trusted click carrying a click count. Keyboard
// activation of a focused button reports detail 0; scripted clicks are
// untrusted. Both are deliberately out of scope.
function isPointerActivation(event) {
  return Boolean(event) && event.isTrusted === true && Number(event.detail) > 0;
}

// Run and Solution share every class with Submit; the button's own text is the
// only stable difference between them.
function isSubmitButtonLabel(text) {
  return normalizeText(text).toLowerCase() === "submit";
}

// ---------------------------------------------------------------------------
// Finding the native Submit button
// ---------------------------------------------------------------------------

// An exact "Submit" text match alone could hit an unrelated control (a feedback
// form, a modal), so require a stable anchor too: the console controls' id, or
// the native tooltip that describes this button.
function hasSubmitCorroborator(button) {
  if (button.closest(`#${SUBMIT_CONSOLE_SCOPE_ID}`)) return true;

  const describer = button.closest("[aria-describedby]");
  const tooltipId = describer?.getAttribute("aria-describedby");
  const tooltip = tooltipId ? document.getElementById(tooltipId) : null;
  return Boolean(tooltip && normalizeText(tooltip.textContent).toLowerCase().includes("submit"));
}

function isGuardedSubmitButton(button) {
  if (!(button instanceof Element) || button.disabled) return false;
  if (!isSubmitButtonLabel(button.textContent)) return false;
  return hasSubmitCorroborator(button);
}

function findSubmitButtonFromEvent(event) {
  const target = event.target instanceof Element ? event.target : null;
  const button = target?.closest("button");
  return button && isGuardedSubmitButton(button) ? button : null;
}

// Used at confirm time. Re-resolving beats holding the node from the click: Vue
// may have re-rendered the controls in between, leaving a detached element that
// would swallow the submission silently.
function findSubmitButtonInPage() {
  // Console controls first (the common case, and the cheapest scan), then the
  // whole page — a confirmed submission must not be dropped just because the
  // controls moved out of that container.
  const scopes = [document.getElementById(SUBMIT_CONSOLE_SCOPE_ID), document.body];
  for (const scope of scopes) {
    if (!scope) continue;
    for (const button of scope.querySelectorAll("button")) {
      if (isGuardedSubmitButton(button)) return button;
    }
  }
  return null;
}

// ---------------------------------------------------------------------------
// The guard
// ---------------------------------------------------------------------------

function handleSubmitConfirmClick(event) {
  if (enhancerStopped || !isFeatureEnabled(SUBMIT_CONFIRM_FEATURE)) return;
  if (!isPointerActivation(event)) return;
  if (!lessonUuidFromPath()) return;

  const button = findSubmitButtonFromEvent(event);
  if (!button) return; // anything unrecognized submits natively — fail open

  // Cancel this activation completely. preventDefault also covers the implicit
  // form submission a type="submit" button would otherwise trigger.
  event.preventDefault();
  event.stopPropagation();
  event.stopImmediatePropagation();

  // Double-click: swallow the second activation rather than stacking dialogs.
  if (document.getElementById(SUBMIT_CONFIRM_DIALOG_ID)) return;
  openSubmitConfirmDialog();
}

// ---------------------------------------------------------------------------
// Dialog
// ---------------------------------------------------------------------------

function openSubmitConfirmDialog() {
  if (!document.body) return;

  const dialog = document.createElement("dialog");
  dialog.id = SUBMIT_CONFIRM_DIALOG_ID;
  dialog.className = "be-confirm";
  dialog.setAttribute("aria-labelledby", SUBMIT_CONFIRM_TITLE_ID);
  dialog.setAttribute("aria-describedby", SUBMIT_CONFIRM_BODY_ID);

  const title = document.createElement("h2");
  title.id = SUBMIT_CONFIRM_TITLE_ID;
  title.className = "be-confirm-title";
  title.textContent = "Submit this code?";

  const body = document.createElement("p");
  body.id = SUBMIT_CONFIRM_BODY_ID;
  body.className = "be-confirm-body";
  body.textContent = "A failed submission can cost armor and Sharpshooter progress. Run your code first if you aren't sure.";

  const cancel = document.createElement("button");
  cancel.type = "button";
  cancel.className = "be-confirm-btn";
  cancel.textContent = "Cancel";
  cancel.addEventListener("click", () => closeSubmitConfirmDialog());

  const confirm = document.createElement("button");
  confirm.type = "button";
  confirm.className = "be-confirm-btn be-confirm-btn-primary";
  confirm.textContent = "Submit";
  confirm.addEventListener("click", () => {
    closeSubmitConfirmDialog();
    runNativeSubmit();
  });

  const actions = document.createElement("div");
  actions.className = "be-confirm-actions";
  actions.append(cancel, confirm);

  dialog.append(title, body, actions);
  // Escape, handled two ways on purpose. The native `cancel` event is the
  // spec path, but on Boot.dev it never fires — something on the page
  // preventDefaults the Escape keydown before the dialog's close-watcher sees
  // it, so Escape only moved the focus ring (observed 2026-07-26). The keydown
  // listener below is the one that actually closes; it sits on the dialog, which
  // holds focus while modal, and stops the key from reaching the page's own
  // Escape handling. Both paths call the same close, and closing twice is a
  // no-op.
  dialog.addEventListener("cancel", () => closeSubmitConfirmDialog());
  dialog.addEventListener("keydown", (event) => {
    if (event.key !== "Escape") return;
    event.preventDefault();
    event.stopPropagation();
    closeSubmitConfirmDialog();
  });
  dialog.addEventListener("close", () => dialog.remove());
  document.body.appendChild(dialog);

  try {
    dialog.showModal();
  } catch (err) {
    // Never strand the click the user actually made: if the dialog can't open,
    // fall through to the native action.
    handleAsyncError(err, "submitConfirm");
    dialog.remove();
    runNativeSubmit();
    return;
  }

  // Cancel takes focus deliberately: a feature that exists to stop accidental
  // submissions must not submit on a reflexive Enter.
  cancel.focus();
}

function closeSubmitConfirmDialog() {
  const dialog = document.getElementById(SUBMIT_CONFIRM_DIALOG_ID);
  if (!dialog) return;
  try {
    if (dialog.open) dialog.close();
  } catch (err) {
    handleAsyncError(err, "submitConfirm");
  }
  dialog.remove();
}

function runNativeSubmit() {
  const button = findSubmitButtonInPage();
  if (!button) {
    toast("Submit isn't available right now — use the button on the page.");
    return;
  }
  // Untrusted by definition, so the guard above ignores it: exactly one native
  // submission, no recursion.
  button.click();
}

// Idempotent per-render check: drop a dialog left open when the route leaves the
// lesson or the feature is switched off.
function ensureSubmitConfirmUiState() {
  if (enhancerStopped) return;
  if (!document.getElementById(SUBMIT_CONFIRM_DIALOG_ID)) return;
  if (!isFeatureEnabled(SUBMIT_CONFIRM_FEATURE) || !lessonUuidFromPath()) {
    closeSubmitConfirmDialog();
  }
}

function bindSubmitConfirm() {
  if (submitConfirmClickHandler) return;
  submitConfirmClickHandler = (event) => {
    try {
      handleSubmitConfirmClick(event);
    } catch (err) {
      handleAsyncError(err, "submitConfirm");
    }
  };
  document.addEventListener("click", submitConfirmClickHandler, true);
}

// Called from stopEnhancer so the listener doesn't outlive an invalidated context.
function unbindSubmitConfirm() {
  if (!submitConfirmClickHandler) return;
  document.removeEventListener("click", submitConfirmClickHandler, true);
  submitConfirmClickHandler = null;
}

// Test hook: scripts/check_lesson_features.mjs predefines this global before
// evaluating the file. Never defined on the real page.
if (typeof window !== "undefined" && window.__BOOTDEV_ENHANCER_TEST__) {
  window.__BOOTDEV_ENHANCER_TEST__.submitConfirm = { isPointerActivation, isSubmitButtonLabel };
}
