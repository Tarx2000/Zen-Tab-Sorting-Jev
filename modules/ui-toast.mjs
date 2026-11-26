// Zen Tab Sorting — shared toast / in-browser notification helper.
//
// Displays a non-intrusive, floating toast banner directly inside the active
// Zen Browser window, with accessible status/alert roles, optional action
// button (Cancel / Undo), and a live { update, dismiss } handle.
//
// Falls back to nsIAlertsService and console logging when DOM toast insertion
// is not available (e.g. background contexts or Node test harnesses).

import { LOG, HTML_NS } from "./config.mjs";

const DEFAULT_TOAST_DURATION_MS = 5500;
const MAX_VISIBLE_TOASTS = 3;
const DISMISS_ANIMATION_MS = 220;
const SVG_NS = "http://www.w3.org/2000/svg";

const NOOP_HANDLE = Object.freeze({
  update() {},
  dismiss() {},
});

const TOAST_ICON_PATHS = {
  success: "M5 12.5 9.5 17 19 7.5",
  warning: "M12 3.5 21 19.5H3L12 3.5Z M12 10v4 M12 17.2h.01",
  error: "M12 3.5a8.5 8.5 0 1 0 0 17 8.5 8.5 0 0 0 0-17Z M15 9l-6 6 M9 9l6 6",
  info: "M12 3.5q.8 4.2 5 5-4.2.8-5 5-.8-4.2-5-5 4.2-.8 5-5Z M18.5 15.5q.4 1.6 2 2-1.6.4-2 2-.4-1.6-2-2 1.6-.4 2-2Z",
};

const createHtmlElement = (doc, tag) =>
  typeof doc.createElementNS === "function"
    ? doc.createElementNS(HTML_NS, tag)
    : doc.createElement(tag);

const renderIconContents = (doc, iconSpan, type) => {
  iconSpan.textContent = "";
  while (iconSpan.firstChild) iconSpan.firstChild.remove();
  if (typeof doc.createElementNS === "function") {
    const svg = doc.createElementNS(SVG_NS, "svg");
    svg.setAttribute("viewBox", "0 0 24 24");
    svg.setAttribute("width", "15");
    svg.setAttribute("height", "15");
    svg.setAttribute("fill", "none");
    svg.setAttribute("stroke", "currentColor");
    svg.setAttribute("stroke-width", "1.9");
    svg.setAttribute("stroke-linecap", "round");
    svg.setAttribute("stroke-linejoin", "round");
    svg.setAttribute("aria-hidden", "true");
    const path = doc.createElementNS(SVG_NS, "path");
    path.setAttribute("d", TOAST_ICON_PATHS[type] || TOAST_ICON_PATHS.info);
    svg.appendChild(path);
    iconSpan.appendChild(svg);
    return;
  }
  iconSpan.textContent = type === "error" || type === "warning" ? "!" : type === "success" ? "✓" : "•";
};

const applyToastRole = (toast, type) => {
  if (type === "error") {
    toast.setAttribute("role", "alert");
    toast.setAttribute("aria-live", "assertive");
  } else {
    toast.setAttribute("role", "status");
    toast.setAttribute("aria-live", "polite");
  }
  toast.setAttribute("aria-atomic", "true");
};

const resolveWindow = () => {
  if (typeof window !== "undefined" && window?.document) return window;
  try {
    if (typeof Services !== "undefined" && Services?.wm?.getMostRecentWindow) {
      const win = Services.wm.getMostRecentWindow("navigator:browser");
      if (win?.document) return win;
    }
  } catch {}
  return null;
};

/**
 * Display an in-browser toast notification.
 *
 * @param {string} message
 * @param {object} [options]
 * @param {"info"|"warning"|"error"|"success"} [options.type="info"]
 * @param {number} [options.duration=5500]  Pass 0 or Infinity for persistent toasts.
 * @param {Window} [options.targetWindow]
 * @param {{ label: string, onClick: (handle: object) => void, keepOpen?: boolean }} [options.action]
 * @returns {{ update: (msg?: string, opts?: object) => void, dismiss: () => void }}
 */
export const showToast = (
  message,
  { type = "info", duration = DEFAULT_TOAST_DURATION_MS, targetWindow, action = null } = {},
) => {
  if (!message) return NOOP_HANDLE;
  const win = targetWindow || resolveWindow();

  // 1. In-DOM floating toast inside the active browser window
  if (win?.document && (typeof win.document.createElementNS === "function" || typeof win.document.createElement === "function")) {
    try {
      const doc = win.document;
      const setTimer = typeof win.setTimeout === "function" ? win.setTimeout.bind(win) : setTimeout;
      const clearTimer = typeof win.clearTimeout === "function" ? win.clearTimeout.bind(win) : clearTimeout;

      let container = doc.getElementById("zao-toast-container");
      if (!container) {
        container = createHtmlElement(doc, "div");
        container.id = "zao-toast-container";
        container.className = "zao-toast-container";
        const root = doc.body || doc.documentElement;
        root.appendChild(container);
      }

      // Cap simultaneous visible toasts at MAX_VISIBLE_TOASTS.
      const activeToasts = [...container.children].filter(
        (child) => !child.classList?.contains("zao-toast-dismissing"),
      );
      while (activeToasts.length >= MAX_VISIBLE_TOASTS) {
        const oldest = activeToasts.shift();
        if (typeof oldest?._zaoDismiss === "function") oldest._zaoDismiss();
        else oldest?.remove?.();
      }

      let currentType = type;
      let currentDuration = duration;
      let dismissed = false;
      let autoTimer = null;
      let exitTimer = null;
      let actionBtn = null;

      const toast = createHtmlElement(doc, "div");
      toast.className = `zao-toast zao-toast-${currentType}`;
      applyToastRole(toast, currentType);

      const iconSpan = createHtmlElement(doc, "span");
      iconSpan.className = "zao-toast-icon";
      renderIconContents(doc, iconSpan, currentType);
      toast.appendChild(iconSpan);

      const msgSpan = createHtmlElement(doc, "span");
      msgSpan.className = "zao-toast-message";
      msgSpan.textContent = String(message);
      toast.appendChild(msgSpan);

      const closeBtn = createHtmlElement(doc, "button");
      closeBtn.className = "zao-toast-close";
      closeBtn.type = "button";
      closeBtn.setAttribute("aria-label", "Close");
      closeBtn.textContent = "×";
      toast.appendChild(closeBtn);

      const clearAutoTimer = () => {
        if (autoTimer != null) {
          clearTimer(autoTimer);
          autoTimer = null;
        }
      };

      const scheduleAutoDismiss = (ms) => {
        clearAutoTimer();
        if (dismissed || !Number.isFinite(ms) || ms <= 0) return;
        autoTimer = setTimer(removeToast, ms);
      };

      const removeToast = () => {
        if (dismissed) return;
        dismissed = true;
        clearAutoTimer();
        if (!toast.isConnected) return;
        toast.classList.add("zao-toast-dismissing");
        exitTimer = setTimer(() => {
          exitTimer = null;
          try { toast.remove(); } catch {}
          if (container && container.children.length === 0) {
            try { container.remove(); } catch {}
          }
        }, DISMISS_ANIMATION_MS);
      };

      const setAction = (nextAction) => {
        if (actionBtn) {
          actionBtn.remove();
          actionBtn = null;
        }
        if (!nextAction?.label) return;
        actionBtn = createHtmlElement(doc, "button");
        actionBtn.className = "zao-toast-action";
        actionBtn.type = "button";
        actionBtn.textContent = String(nextAction.label);
        actionBtn.addEventListener("click", (e) => {
          e.stopPropagation();
          try { nextAction.onClick?.(handle); } catch (err) {
            console.error(`${LOG} toast action failed:`, err);
          }
          if (!nextAction.keepOpen) removeToast();
        });
        toast.insertBefore(actionBtn, closeBtn);
      };

      const handle = {
        update(nextMsg, nextOpts = {}) {
          if (dismissed || !toast.isConnected) return;
          if (nextMsg != null) msgSpan.textContent = String(nextMsg);
          if (nextOpts.type && nextOpts.type !== currentType) {
            toast.classList.remove(`zao-toast-${currentType}`);
            currentType = nextOpts.type;
            toast.classList.add(`zao-toast-${currentType}`);
            renderIconContents(doc, iconSpan, currentType);
            applyToastRole(toast, currentType);
          }
          if ("action" in nextOpts) setAction(nextOpts.action);
          if ("duration" in nextOpts) {
            currentDuration = nextOpts.duration;
            scheduleAutoDismiss(currentDuration);
          }
        },
        dismiss: removeToast,
      };

      toast._zaoDismiss = removeToast;
      setAction(action);

      closeBtn.addEventListener("click", (e) => {
        e.stopPropagation();
        removeToast();
      });

      toast.addEventListener("mouseenter", () => {
        if (dismissed) return;
        clearAutoTimer();
      });
      toast.addEventListener("mouseleave", () => {
        if (dismissed) return;
        if (Number.isFinite(currentDuration) && currentDuration > 0) {
          scheduleAutoDismiss(Math.min(currentDuration, 2500));
        }
      });

      container.appendChild(toast);
      scheduleAutoDismiss(currentDuration);

      console.log(`${LOG} toast: ${message}`);
      return handle;
    } catch (e) {
      console.warn(`${LOG} in-DOM toast failed, trying alert service:`, e);
    }
  }

  // 2. Fallback to nsIAlertsService / OS notification
  try {
    const Cc = globalThis.Cc || globalThis.Components?.classes;
    const Ci = globalThis.Ci || globalThis.Components?.interfaces;
    if (Cc && Ci) {
      const alertsService = Cc["@mozilla.org/alerts-service;1"]?.getService(Ci.nsIAlertsService);
      alertsService?.showAlertNotification?.(null, "Zen Tab Sorting", message);
      console.log(`${LOG} toast (alertService): ${message}`);
      return NOOP_HANDLE;
    }
  } catch {}

  console.warn(`${LOG} toast (fallback): ${message}`);
  return NOOP_HANDLE;
};
