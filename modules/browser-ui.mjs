import { recordDebugEvent } from "./debug-journal.mjs";
// Zen Tab Sorting — browser-context UI: tidy button, command, workspace hooks.

import { CONFIG, LOG } from "./config.mjs";
import { domCache } from "./tabs.mjs";
import { handleOrganizeClick } from "./click-handler.mjs";

// Lucide "wand-sparkles" — the magic wand with a sparkle around the tip.
// Inline SVG (not an icon-font / external file) so it inherits currentColor from
// the toolbar theme and animates cleanly with the .zao-wiggling class.
// Minimalist Zen magic wand icon with clean star sparkle
const WAND_ICON_SVG = `
  <svg xmlns="http://www.w3.org/2000/svg" width="14" height="14" viewBox="0 0 24 24"
       fill="none" stroke="currentColor" stroke-width="1.75"
       stroke-linecap="round" stroke-linejoin="round">
    <path d="m4 20 10-10"/>
    <path d="m13 7 4 4"/>
    <path d="M18 2.5v5"/>
    <path d="M15.5 5h5"/>
  </svg>
`;

const buttonXul = () => `
  <toolbarbutton
    id="${CONFIG.BUTTON_ID}"
    class="toolbarbutton-1 chromeclass-toolbar-additional"
    command="${CONFIG.COMMAND_ID}"
    tooltiptext="Auto Sort Tabs">
    <hbox class="toolbarbutton-box" align="center">
      ${WAND_ICON_SVG}
    </hbox>
  </toolbarbutton>
`;

export const ensureOrganizeButton = (target) => {
  if (!target) return null;
  const existing = target.querySelector?.(`#${CONFIG.BUTTON_ID}`);
  if (existing) return existing;

  try {
    const nativeClearButton = target.matches?.(".zen-workspace-close-unpinned-tabs-button")
      ? target
      : target.querySelector?.(".zen-workspace-close-unpinned-tabs-button");

    const buttonFragment = window.MozXULElement.parseXULToFragment(buttonXul());
    const button = buttonFragment.firstChild;

    const onBtnClick = (event) => {
      event?.preventDefault?.();
      event?.stopPropagation?.();
      recordDebugEvent("BUTTON-CLICK", "Klick auf #tab-wand-button registriert");
      handleOrganizeClick();
    };
    button.addEventListener("click", onBtnClick);
    button.addEventListener("command", onBtnClick);

    if (nativeClearButton && nativeClearButton.parentNode) {
      nativeClearButton.parentNode.insertBefore(button, nativeClearButton);
      return button;
    }
    if (target.classList?.contains("pinned-tabs-container-separator")) {
      target.appendChild(button);
      return button;
    }
    target.appendChild(button);
    return button;
  } catch (e) {
    console.error(`${LOG} ensureOrganizeButton error:`, e);
  }
  return null;
};

export const addButtonToAllSeparators = () => {
  try {
    // 1. Every native Clear button in the sidebar (places wand button directly to its left)
    const clearButtons = document.querySelectorAll(".zen-workspace-close-unpinned-tabs-button");
    for (const clearBtn of clearButtons) {
      if (!clearBtn.parentElement?.querySelector(`#${CONFIG.BUTTON_ID}`)) {
        ensureOrganizeButton(clearBtn);
      }
    }

    // 2. All separators across all workspaces
    const separators = domCache.getSeparators();
    if (separators && separators.length > 0) {
      separators.forEach(ensureOrganizeButton);
    }

    // 3. Active workspace pinned container
    const activePinned = window.gZenWorkspaces?.pinnedTabsContainer;
    if (activePinned) {
      const sep = activePinned.querySelector(".pinned-tabs-container-separator");
      if (sep) ensureOrganizeButton(sep);
    }

    // 4. Fallback if no button exists anywhere in the window
    if (!document.querySelector(`#${CONFIG.BUTTON_ID}`)) {
      const periphery = document.querySelector("#tabbrowser-arrowscrollbox-periphery");
      if (periphery) ensureOrganizeButton(periphery);
    }
  } catch (e) {
    console.error(`${LOG} addButtonToAllSeparators error:`, e);
  }
};

export const setupCommand = () => {
  if (typeof window !== "undefined" && !window._zaoGlobalClickListener) {
    window._zaoGlobalClickListener = (event) => {
      const btn = event.target?.closest?.(`#${CONFIG.BUTTON_ID}`);
      if (btn) {
        event.preventDefault();
        event.stopPropagation();
        recordDebugEvent("CAPTURE-CLICK", "Globaler Window-Klick auf #tab-wand-button registriert");
        handleOrganizeClick();
      }
    };
    window.addEventListener("click", window._zaoGlobalClickListener, true);
    window.addEventListener("command", window._zaoGlobalClickListener, true);
  }

  const zenCommands = domCache.getCommandSet();
  if (!zenCommands) return;

  if (!zenCommands.querySelector(`#${CONFIG.COMMAND_ID}`)) {
    try {
      const cmd = window.MozXULElement.parseXULToFragment(
        `<command id="${CONFIG.COMMAND_ID}"/>`
      ).firstChild;
      zenCommands.appendChild(cmd);
    } catch (e) {
      console.error(`${LOG} command create error:`, e);
    }
  }

  // DOM-expando guard rather than a module-level flag — a module re-import
  // (during dev) would reset a module variable, accumulating listeners. The
  // expando survives module reloads because it's pinned to the DOM element.
  if (!zenCommands._zaoCommandListener) {
    const listener = (event) => {
      if (event.target.id === CONFIG.COMMAND_ID) handleOrganizeClick();
    };
    zenCommands.addEventListener("command", listener);
    zenCommands._zaoCommandListener = listener;
  }
};

// Re-inject the tidy button on workspace changes (the separator element changes per workspace).
export const setupWorkspaceHooks = () => {
  if (typeof window.gZenWorkspaces === "undefined") return;
  // Guard against double-install: dev reloads of the entry script would
  // otherwise stack our wrappers, doubling the calls per workspace switch.
  if (window.gZenWorkspaces._zaoHooksInstalled) return;
  window.gZenWorkspaces._zaoHooksInstalled = true;

  const originalOnTabBrowserInserted = window.gZenWorkspaces.onTabBrowserInserted;
  const originalUpdateTabsContainers = window.gZenWorkspaces.updateTabsContainers;

  window.gZenWorkspaces.onTabBrowserInserted = function (event) {
    if (typeof originalOnTabBrowserInserted === "function") {
      try {
        originalOnTabBrowserInserted.call(window.gZenWorkspaces, event);
      } catch (e) {
        console.error(`${LOG} hook onTabBrowserInserted error:`, e);
      }
    }
    domCache.invalidate();
    addButtonToAllSeparators();
  };

  window.gZenWorkspaces.updateTabsContainers = function (...args) {
    if (typeof originalUpdateTabsContainers === "function") {
      try {
        originalUpdateTabsContainers.apply(window.gZenWorkspaces, args);
      } catch (e) {
        console.error(`${LOG} hook updateTabsContainers error:`, e);
      }
    }
    domCache.invalidate();
    addButtonToAllSeparators();
  };

  window.addEventListener("ZenWorkspaceChange", () => {
    domCache.invalidate();
    addButtonToAllSeparators();
  });

  window.addEventListener("TabSelect", () => {
    addButtonToAllSeparators();
  });
};
