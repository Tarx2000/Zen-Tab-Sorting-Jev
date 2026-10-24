export const GROUP_SELECTOR = "tab-group, zen-folder, tab-split-view-wrapper";

// Native drag images and Zen Library rows are copies, never sortable groups.
export const isSidebarCopy = (element) => Boolean(element?.closest?.(
  "[drag-image], [data-zao-animation], #zen-library, zen-library, [id^='zen-library-'], [id^='zenLibrary']"
));

export const groupHeader = (group) => group?.labelContainerElement ||
  group?.querySelector?.(":scope > .tab-group-label-container") || group;
