export const GROUP_SELECTOR = "tab-group, zen-folder, tab-split-view-wrapper";
export const NORMAL_GROUP_SELECTOR = "tab-group:not([split-view-group])";

const SIDEBAR_COPY_SELECTOR =
  "[drag-image], [data-zao-animation], #zen-library, zen-library, [id^='zen-library-'], [id^='zenLibrary']";

const toElement = (node) => {
  if (!node) return null;
  if (node.nodeType === 1) return node;
  if (node.nodeType !== undefined) return node.parentElement || null;
  // Support lightweight DOM test doubles without a numeric nodeType.
  return typeof node.closest === "function" || typeof node.hasAttribute === "function"
    ? node
    : node.parentElement || null;
};

// Native drag images and Zen Library rows are copies, never sortable groups.
export const isSidebarCopy = (node) => {
  const element = toElement(node);
  if (!element) return false;
  // Fast-path direct checks before walking ancestors with .closest(...).
  if (typeof element.hasAttribute === "function") {
    if (element.hasAttribute("drag-image") || element.hasAttribute("data-zao-animation")) return true;
  }
  const id = element.id;
  if (typeof id === "string" && (id === "zen-library" || id.startsWith("zen-library-") || id.startsWith("zenLibrary"))) {
    return true;
  }
  const tag = element.localName || element.tagName?.toLowerCase?.();
  if (tag === "zen-library") return true;
  if (element.nodeType === 1 && !element.parentElement) return false;
  return Boolean(element.closest?.(SIDEBAR_COPY_SELECTOR));
};

export const groupHeader = (group) => group?.labelContainerElement ||
  group?.querySelector?.(":scope > .tab-group-label-container") || group;
