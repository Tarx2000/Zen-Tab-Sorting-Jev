// Zen Tab Sorting — shared toast / in-browser notification helper.
//
// Displays a non-intrusive, modern floating toast banner directly inside the
// active Zen Browser window, so users get immediate visual feedback when errors,
// quota exhaustion, or status events occur.
//
// Falls through to Zen's gZenUIManager / nsIAlertsService and console when
// DOM toast insertion is not available (e.g. background threads or test harnesses).

import { LOG } from "./config.mjs";

const DEFAULT_TOAST_DURATION_MS = 5500;
const SVG_NS = "http://www.w3.org/2000/svg";

const TOAST_ICON_PATHS = {
  success: "M5 12.5 9.5 17 19 7.5",
  warning: "M12 3.5 21 19.5H3L12 3.5Z M12 10v4 M12 17.2h.01",
  error: "M12 3.5a8.5 8.5 0 1 0 0 17 8.5 8.5 0 0 0 0-17Z M15 9l-6 6 M9 9l6 6",
  info: "M12 3.5q.8 4.2 5 5-4.2.8-5 5-.8-4.2-5-5 4.2-.8 5-5Z M18.5 15.5q.4 1.6 2 2-1.6.4-2 2-.4-1.6-2-2 1.6-.4 2-2Z",
};

const createToastIcon = (doc, type) => {
  const iconSpan = doc.createElement("span");
  iconSpan.className = "zao-toast-icon";
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
    return iconSpan;
  }
  iconSpan.textContent = type === "error" || type === "warning" ? "!" : type === "success" ? "✓" : "•";
  return iconSpan;
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
 * @param {number} [options.duration=5500]
 */
export const showToast = (message, { type = "info", duration = DEFAULT_TOAST_DURATION_MS, targetWindow } = {}) => {
  if (!message) return;
  const win = targetWindow || resolveWindow();

  // 1. In-DOM floating toast inside the active browser window
  if (win?.document?.createElement) {
    try {
      const doc = win.document;
      let container = doc.getElementById("zao-toast-container");
      if (!container) {
        container = doc.createElement("div");
        container.id = "zao-toast-container";
        container.className = "zao-toast-container";
        const root = doc.body || doc.documentElement;
        root.appendChild(container);
      }

      const toast = doc.createElement("div");
      toast.className = `zao-toast zao-toast-${type}`;

      const iconSpan = createToastIcon(doc, type);
      toast.appendChild(iconSpan);

      const msgSpan = doc.createElement("span");
      msgSpan.className = "zao-toast-message";
      msgSpan.textContent = String(message);
      toast.appendChild(msgSpan);

      const closeBtn = doc.createElement("button");
      closeBtn.className = "zao-toast-close";
      closeBtn.type = "button";
      closeBtn.setAttribute("aria-label", "Close");
      closeBtn.textContent = "×";
      toast.appendChild(closeBtn);

      const removeToast = () => {
        if (!toast.isConnected) return;
        toast.classList.add("zao-toast-dismissing");
        setTimeout(() => {
          try { toast.remove(); } catch {}
          if (container && container.children.length === 0) {
            try { container.remove(); } catch {}
          }
        }, 220);
      };

      closeBtn.addEventListener("click", (e) => {
        e.stopPropagation();
        removeToast();
      });

      container.appendChild(toast);

      let timer = setTimeout(removeToast, duration);
      toast.addEventListener("mouseenter", () => clearTimeout(timer));
      toast.addEventListener("mouseleave", () => {
        timer = setTimeout(removeToast, 2500);
      });

      console.log(`${LOG} toast: ${message}`);
      return;
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
      return;
    }
  } catch {}

  console.warn(`${LOG} toast (no gZenUIManager): ${message}`);
};
