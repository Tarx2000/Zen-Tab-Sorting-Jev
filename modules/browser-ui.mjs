import { recordDebugEvent } from "./debug-journal.mjs";
// Zen Tab Sorting — browser-context UI: tidy button, command, workspace hooks.

import { CONFIG, LOG } from "./config.mjs";
import { domCache } from "./tabs.mjs";
import { handleOrganizeClick } from "./click-handler.mjs";
import { updateSortButtonState } from "./sort-session.mjs";

const LIBRARY_CARD = ".zen-library-space[data-uuid]";
const BUTTONS = `[id^="${CONFIG.BUTTON_ID}"]`;
const isOrganizeButton = (node) => node?.hasAttribute?.("data-zao-library-organize") || node?.id === CONFIG.BUTTON_ID ||
  /^tab-wand-button(?:-copy)+$/.test(node?.id || "");
const libraryCard = (node) => node?.closest?.(LIBRARY_CARD);

// Library strips clone sidebar markup, including our icon, but not listeners.
// Replace those copies with one persistent header action. The native separator
// is hidden when all tabs are grouped, so it cannot host an always-usable icon.
export const reconcileLibraryButtons = () => {
  // Native Library clones arbitrary tab/group attributes during TabMove. The
  // original's animation cleanup cannot reach those copies, so discard its
  // transient marker when a strip is rebuilt (including previously stale rows).
  for (const copy of document.querySelectorAll(`zen-library [data-zao-in-flight]`)) copy.removeAttribute("data-zao-in-flight");
  for (const card of document.querySelectorAll(LIBRARY_CARD)) {
    const header = card.querySelector(".zen-library-space-header");
    if (!header) continue;
    const buttons = [...card.querySelectorAll(BUTTONS)].filter(isOrganizeButton);
    let button = buttons.find((node) => node.hasAttribute("data-zao-library-organize"));
    if (!button) {
      button = window.MozXULElement.parseXULToFragment(buttonXul()).firstChild;
      button.id = `${CONFIG.BUTTON_ID}-library-${card.dataset.uuid}`;
      button.setAttribute("data-zao-library-organize", "true");
    }
    for (const duplicate of buttons) if (duplicate !== button) duplicate.remove();
    if (button.parentElement !== header) header.insertBefore(button, header.querySelector("toolbarbutton"));
    button.classList.add("zao-organize-button");
    button.removeAttribute("command");
    button.setAttribute("tooltiptext", "Tabs in diesem Space automatisch sortieren");
    updateSortButtonState(button, window);
  }
};

const dispatchOrganize = (event) => {
  const button = event.target?.closest?.(BUTTONS);
  if (!isOrganizeButton(button) || (event.type === "click" && event.button !== 0)) return;
  event.preventDefault();
  event.stopImmediatePropagation();
  if (button.disabled || window._zaoSortSession) return;
  const card = libraryCard(button);
  recordDebugEvent("BUTTON-CLICK", card ? "Library-Space sortieren" : "Aktiven Space sortieren");
  void handleOrganizeClick(card ? { workspaceId: card.dataset.uuid, fromLibrary: true } : {})
    .catch((error) => console.error(`${LOG} organize command failed:`, error));
};

// Both shapes share one fixed footprint; session state drives the soft change.
const WAND_ICON_SVG = `
  <svg class="zao-wand-icon" aria-hidden="true" xmlns="http://www.w3.org/2000/svg" width="14" height="14" viewBox="0 0 24 24"
       fill="none" stroke="currentColor" stroke-width="1.75"
       stroke-linecap="round" stroke-linejoin="round">
    <path d="m4 20 10-10"/>
    <path d="m13 7 4 4"/>
    <path d="M18 2.5v5"/>
    <path d="M15.5 5h5"/>
  </svg>
  <svg class="zao-loading-icon" aria-hidden="true" xmlns="http://www.w3.org/2000/svg" width="14" height="14" viewBox="0 0 24 24"
       fill="none" stroke="currentColor" stroke-width="1.75" stroke-linecap="round">
    <path d="M12 3a9 9 0 1 1-9 9"/>
  </svg>
`;

const buttonXul = () => `
  <toolbarbutton
    id="${CONFIG.BUTTON_ID}"
    class="toolbarbutton-1 chromeclass-toolbar-additional zao-organize-button"
    command="${CONFIG.COMMAND_ID}"
    tooltiptext="Auto Sort Tabs">
    <hbox class="toolbarbutton-box zao-organize-icon" align="center">
      ${WAND_ICON_SVG}
    </hbox>
  </toolbarbutton>
`;

export const ensureOrganizeButton = (target) => {
  if (!target || libraryCard(target)) return null;
  const scope = target.matches?.(".zen-workspace-close-unpinned-tabs-button") ? target.parentElement : target;
  const existing = scope?.querySelector?.(`#${CONFIG.BUTTON_ID}`);
  if (existing) return existing;

  try {
    const nativeClearButton = target.matches?.(".zen-workspace-close-unpinned-tabs-button")
      ? target
      : target.querySelector?.(".zen-workspace-close-unpinned-tabs-button");

    const buttonFragment = window.MozXULElement.parseXULToFragment(buttonXul());
    const button = buttonFragment.firstChild;
    updateSortButtonState(button, window);

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
      if (libraryCard(clearBtn)) continue;
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
    reconcileLibraryButtons();
    for (const button of document.querySelectorAll(".zao-organize-button")) updateSortButtonState(button, window);
  } catch (e) {
    console.error(`${LOG} addButtonToAllSeparators error:`, e);
  }
};

export const setupCommand = () => {
  if (typeof window !== "undefined" && !window._zaoGlobalClickListener) {
    window._zaoGlobalClickListener = dispatchOrganize;
    window.addEventListener("click", window._zaoGlobalClickListener, true);
    window.addEventListener("command", window._zaoGlobalClickListener, true);
  }

  const library = document.querySelector("zen-library");
  if (library && !window._zaoLibraryButtonObserver) {
    window._zaoLibraryButtonObserver = new window.MutationObserver(reconcileLibraryButtons);
    window._zaoLibraryButtonObserver.observe(library, { childList: true, subtree: true });
    reconcileLibraryButtons();
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

export const teardownOrganizeUI = () => {
  window._zaoLibraryButtonObserver?.disconnect();
  delete window._zaoLibraryButtonObserver;
  if (window._zaoGlobalClickListener) {
    window.removeEventListener("click", window._zaoGlobalClickListener, true);
    window.removeEventListener("command", window._zaoGlobalClickListener, true);
    delete window._zaoGlobalClickListener;
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
