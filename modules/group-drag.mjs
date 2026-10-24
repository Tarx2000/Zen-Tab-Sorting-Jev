// Header edge targeting follows Advanced Tab Groups (MIT, 12th-devs).
// See THIRD_PARTY_NOTICES.md. Native Zen owns the drag image and all moves.
import { isSidebarCopy } from "./sidebar-elements.mjs";

export const setupGroupDrag = (win = globalThis.window) => {
  if (win._zaoGroupDrag) return;
  const doc = win.document;
  const headers = new Map();
  let edgeHeader = null;
  const managed = (group) => group?.localName === "tab-group" &&
    !group.hasAttribute("split-view-group") && !group.isZenFolder && !isSidebarCopy(group) &&
    Boolean(group.closest("zen-workspace"));
  const service = win.gBrowser.tabContainer.tabDragAndDrop;
  const nativeStart = service?.startTabDrag;
  const start = function(event, tab, options = {}, ...rest) {
    const group = tab?.group;
    const rect = tab?.classList?.contains("tab-group-label") && managed(group) ? group.getBoundingClientRect() : null;
    if (!options.dragImageSource && rect && (rect.width < 2 || rect.height < 2)) {
      // Some native tab-group layouts use display:contents. Their visible
      // header has bounds, but the group itself is 0x0. Let Zen's existing
      // dragImageSource option measure and clone the header instead. This also
      // gives Zen the correct cursor offset, with exactly one setDragImage.
      const header = group.labelContainerElement || tab;
      const properties = ["--tab-group-color", "--tab-group-color-invert", "--tab-group-color-pale", "--tab-group-line-color"];
      const previous = properties.map((name) => [name, header.style.getPropertyValue(name), header.style.getPropertyPriority(name)]);
      const computed = win.getComputedStyle(group);
      for (const name of properties) header.style.setProperty(name, computed.getPropertyValue(name));
      try { return nativeStart.call(this, event, tab, { ...options, dragImageSource: header }, ...rest); }
      finally {
        for (const [name, value, priority] of previous) {
          if (value) header.style.setProperty(name, value, priority);
          else header.style.removeProperty(name);
        }
      }
    }
    return nativeStart.call(this, event, tab, options, ...rest);
  };
  if (nativeStart) service.startTabDrag = start;
  const nativeOver = service?.handle_dragover;
  const over = function(event, ...args) {
    const result = nativeOver.call(this, event, ...args);
    const header = event.target.closest?.(".tab-group-label-container[data-zao-edge-reorder]");
    const group = header?.closest("tab-group");
    if (!managed(group) || this._splitDropReady) return result;
    try {
      const type = [...event.dataTransfer.types].find((value) => value === "application/x-moz-tabbrowser-tab" || value === "application/x-moz-tab");
      if (!type) return result;
      const dragged = event.dataTransfer.mozGetDataAt(type, 0);
      const data = dragged?._dragData;
      const moving = dragged?.group || dragged;
      if (!data || moving === group || moving?.contains?.(group) || Boolean(dragged.pinned) !== Boolean(group.labelElement.pinned)) return result;
      const rect = header.getBoundingClientRect();
      const before = event.clientY < rect.top + rect.height / 2;
      // Native geometry can resolve a display:contents group to the hidden
      // placeholder instead of its header. Correct the native target and native
      // indicator together, so the displayed position is the actual drop.
      data.dropElement = group;
      data.dropBefore = before;
      data.animDropElementIndex = group.labelElement.elementIndex + (before ? 0 : 1);
      data.shouldCreateGroupOnDrop = false;
      data.shouldDropIntoCollapsedTabGroup = false;
      this.clearDragOverVisuals?.();
      this._placeDropIndicator?.({ left: rect.left + 2, width: rect.width - 4, top: before ? rect.top : rect.bottom });
      win.gBrowser.tabContainer.removeAttribute("movingtab-addToGroup");
    } catch { /* Older Zen versions retain their own native targeting. */ }
    return result;
  };
  if (nativeOver) service.handle_dragover = over;
  const prepare = (root) => {
    const groups = root.matches?.("tab-group") ? [root] : root.querySelectorAll?.("tab-group") || [];
    for (const group of groups) {
      if (!managed(group)) continue;
      const header = group.labelContainerElement || group.querySelector(":scope > .tab-group-label-container");
      if (!header || headers.has(header)) continue;
      headers.set(header, header.classList.contains("zen-drop-target"));
      header.classList.add("zen-drop-target");
    }
  };
  const restore = () => {
    if (edgeHeader?.isConnected) edgeHeader.classList.add("zen-drop-target");
    edgeHeader?.removeAttribute("data-zao-edge-reorder");
    edgeHeader = null;
  };
  const onDragOver = (event) => {
    const types = [...(event.dataTransfer?.types || [])];
    if (!types.some((type) => ["application/x-moz-tabbrowser-tab", "application/x-moz-tab", "text/tab"].includes(type))) return;
    const header = event.target.closest?.(".tab-group-label-container");
    const group = header?.closest("tab-group");
    if (!managed(group)) { restore(); return; }
    if (edgeHeader && edgeHeader !== header) restore();
    const rect = header.getBoundingClientRect();
    if (!rect.height) return;
    const threshold = Math.min(0.45, Math.max(0.05,
      (win.Services || globalThis.Services).prefs.getIntPref("zen.tabs.folder-dragover-threshold-percent", 20) / 100));
    const overlap = (event.clientY - rect.top) / rect.height;
    const count = group.childGroupsAndTabs?.length || 0;
    const edge = overlap < threshold || (overlap > 1 - threshold && (group.collapsed || count < 2));
    header.classList.toggle("zen-drop-target", !edge);
    header.toggleAttribute("data-zao-edge-reorder", edge);
    edgeHeader = edge ? header : null;
    // No preventDefault, stopPropagation or second setDragImage: Zen decides.
  };
  const observer = new win.MutationObserver((mutations) => {
    for (const mutation of mutations) for (const node of mutation.addedNodes) if (node.nodeType === 1 && !isSidebarCopy(node)) prepare(node);
    for (const header of headers.keys()) if (!header.isConnected) headers.delete(header);
  });
  prepare(doc);
  observer.observe(win.gBrowser.tabContainer, { childList: true, subtree: true });
  doc.addEventListener("dragover", onDragOver, true);
  for (const name of ["drop", "dragend", "dragleave"]) doc.addEventListener(name, restore, true);
  win._zaoGroupDrag = { headers, observer, onDragOver, restore, service, nativeStart, start, nativeOver, over };
};

export const teardownGroupDrag = (win = globalThis.window) => {
  const state = win?._zaoGroupDrag;
  if (!state) return;
  state.restore();
  state.observer.disconnect();
  win.document.removeEventListener("dragover", state.onDragOver, true);
  for (const name of ["drop", "dragend", "dragleave"]) win.document.removeEventListener(name, state.restore, true);
  for (const [header, originallyTarget] of state.headers) if (!originallyTarget) header.classList.remove("zen-drop-target");
  if (state.service?.startTabDrag === state.start) state.service.startTabDrag = state.nativeStart;
  if (state.service?.handle_dragover === state.over) state.service.handle_dragover = state.nativeOver;
  delete win._zaoGroupDrag;
};
