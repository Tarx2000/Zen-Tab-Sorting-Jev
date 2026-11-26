// Zen Tab Sorting — lightweight DE/EN internationalization helper.
// Detects Zen/Firefox UI locale and resolves localized strings for toasts,
// UI controls, errors, progress states, and undo feedback.

const STRINGS = {
  en: {
    // Toasts & general feedback
    "toast.noActiveWorkspace": "No active workspace found.",
    "toast.noEligibleTabs": "No sortable tabs found in the current workspace.",
    "toast.noUngroupedTabs": "No ungrouped tabs left to sort.",
    "toast.sortAborted": "Sorting cancelled.",
    "toast.sortFailed": "Sorting failed.",
    "toast.undo": "Undo",
    "toast.undoDone": "Restored {count} item(s).",
    "toast.undoPartial": "Restored {restored} item(s); {failed} could not be restored.",
    "toast.undoUnavailable": "Nothing to undo.",
    "toast.cancel": "Cancel",

    // Workspace sorting toasts & UI
    "workspace.needTwoSpaces": "At least two Spaces in this window are required to sort.",
    "workspace.noUnits": "No sortable tabs or folders found.",
    "workspace.summary": "{moved} item(s) moved, {kept} kept, {excluded} excluded.",
    "workspace.summaryWithErrors": "{moved} item(s) moved, {kept} kept, {excluded} excluded. {errors} error(s) — see error report.",
    "workspace.menuLabel": "Auto-sort all Spaces",
    "workspace.menuBusy": "Sorting Spaces…",
    "workspace.menuTooltip": "Sort tabs and complete groups of this window into existing Spaces with Jev",
    "workspace.errorReportAria": "Errors while sorting Spaces",
    "workspace.errorReportTitle": "{count} item(s) could not be sorted",
    "workspace.close": "Close",
    "workspace.runName": "Workspace Sorting",
    "workspace.groupStateName": "Group State",
    "workspace.groupStateSaveError": "Could not save group state for the next restart",

    // Context menus & browser UI
    "menu.addToRule": "Add to Rule…",
    "menu.addHostToRule": "Add \"{host}\" to Rule…",
    "menu.noRulesYet": "(no rules defined yet)",
    "menu.skip": "Skip",
    "menu.skipChecked": "✓ Skip",
    "menu.dissolveGroup": "Dissolve group",
    "menu.dissolveNamedGroup": "Dissolve group \"{name}\"",
    "menu.moveToFolder": "Move to Folder…",
    "menu.noFoldersYet": "(no folders in this workspace)",
    "menu.searchFolders": "Filter folders…",
    "menu.unnamedGroup": "(unnamed)",
    "ui.wandTooltip": "Auto Sort Tabs",
    "ui.wandCancelTooltip": "Cancel sorting",

    // Progress
    "progress.sorting": "Sorting tabs…",
    "progress.classifying": "Classifying tabs…",
    "progress.applying": "Applying changes…",
    "progress.cancelling": "Cancelling…",

    // Errors
    "error.elementChanged": "Item was modified during calculation",
    "error.elementOrSpaceChanged": "Item or target Space was modified during calculation",
    "error.targetSpaceMissing": "Target Space no longer exists",
    "error.transferUnsupported": "Zen does not support this transfer",
    "error.folderTransferUnavailable": "Zen folder transfer is not available",
    "error.splitViewTransferUnsupported": "Split View transfer across Spaces is not supported in this Zen version",
    "error.glanceBlocked": "Glance tab cannot be moved across Spaces",
    "error.transferIncomplete": "Zen did not complete the transfer",
    "error.transferFailed": "Transfer failed",
    "error.sortAborted": "Sorting cancelled",
    "error.jevTimeout": "Jev request timed out",
    "error.jevConnection": "Jev connection failed",
    "error.jevInvalidJson": "Jev response is not valid JSON",
    "error.jevHttpFailed": "Jev request failed (HTTP {status})",
    "error.jevConsentRequired": "Please enable data-sending consent in the Jev settings first.",
    "error.jevKeyRequired": "Please enter a Jev access key first.",
  },
  de: {
    // Toasts & general feedback
    "toast.noActiveWorkspace": "Kein aktiver Workspace gefunden.",
    "toast.noEligibleTabs": "Keine sortierbaren Tabs im aktuellen Workspace gefunden.",
    "toast.noUngroupedTabs": "Keine ungruppierten Tabs zum Sortieren übrig.",
    "toast.sortAborted": "Sortierung abgebrochen.",
    "toast.sortFailed": "Sortierung fehlgeschlagen.",
    "toast.undo": "Rückgängig",
    "toast.undoDone": "{count} Element(e) wiederhergestellt.",
    "toast.undoPartial": "{restored} Element(e) wiederhergestellt; {failed} konnten nicht zurückgesetzt werden.",
    "toast.undoUnavailable": "Nichts zum Rückgängigmachen.",
    "toast.cancel": "Abbrechen",

    // Workspace sorting toasts & UI
    "workspace.needTwoSpaces": "Zum Sortieren werden mindestens zwei Spaces in diesem Fenster benötigt.",
    "workspace.noUnits": "Keine sortierbaren Tabs oder Ordner gefunden.",
    "workspace.summary": "{moved} Elemente verschoben, {kept} bleiben, {excluded} ausgenommen.",
    "workspace.summaryWithErrors": "{moved} Elemente verschoben, {kept} bleiben, {excluded} ausgenommen. {errors} Fehler – Details im Fehlerbericht.",
    "workspace.menuLabel": "Alle Spaces automatisch sortieren",
    "workspace.menuBusy": "Spaces werden sortiert …",
    "workspace.menuTooltip": "Tabs und vollständige Gruppen dieses Fensters mit Jev in vorhandene Spaces sortieren",
    "workspace.errorReportAria": "Fehler beim Sortieren der Spaces",
    "workspace.errorReportTitle": "{count} Elemente konnten nicht einsortiert werden",
    "workspace.close": "Schließen",
    "workspace.runName": "Workspace-Sortierung",
    "workspace.groupStateName": "Gruppenstatus",
    "workspace.groupStateSaveError": "Gruppenstatus konnte nicht für den nächsten Neustart gespeichert werden",

    // Context menus & browser UI
    "menu.addToRule": "Zu Regel hinzufügen …",
    "menu.addHostToRule": "„{host}“ zu Regel hinzufügen …",
    "menu.noRulesYet": "(noch keine Regeln definiert)",
    "menu.skip": "Überspringen",
    "menu.skipChecked": "✓ Überspringen",
    "menu.dissolveGroup": "Gruppe auflösen",
    "menu.dissolveNamedGroup": "Gruppe „{name}“ auflösen",
    "menu.moveToFolder": "In Ordner verschieben …",
    "menu.noFoldersYet": "(keine Ordner in diesem Workspace)",
    "menu.searchFolders": "Ordner filtern …",
    "menu.unnamedGroup": "(unbenannt)",
    "ui.wandTooltip": "Tabs automatisch sortieren",
    "ui.wandCancelTooltip": "Sortierung abbrechen",

    // Progress
    "progress.sorting": "Tabs werden sortiert …",
    "progress.classifying": "Tabs werden klassifiziert …",
    "progress.applying": "Änderungen werden angewendet …",
    "progress.cancelling": "Wird abgebrochen …",

    // Errors
    "error.elementChanged": "Element wurde während der Berechnung verändert",
    "error.elementOrSpaceChanged": "Element oder Ziel-Space wurde während der Berechnung verändert",
    "error.targetSpaceMissing": "Ziel-Space existiert nicht mehr",
    "error.transferUnsupported": "Zen unterstützt diesen Transfer nicht",
    "error.folderTransferUnavailable": "Zen-Ordnertransfer nicht verfügbar",
    "error.splitViewTransferUnsupported": "Split-View-Transfer zwischen Spaces wird in dieser Zen-Version nicht unterstützt",
    "error.glanceBlocked": "Glance-Tab kann nicht zwischen Spaces verschoben werden",
    "error.transferIncomplete": "Zen hat den Transfer nicht vollständig ausgeführt",
    "error.transferFailed": "Transfer fehlgeschlagen",
    "error.sortAborted": "Sortierung abgebrochen",
    "error.jevTimeout": "Jev-Zeitlimit erreicht",
    "error.jevConnection": "Jev-Verbindung fehlgeschlagen",
    "error.jevInvalidJson": "Jev-Antwort ist kein gültiges JSON",
    "error.jevHttpFailed": "Jev-Anfrage fehlgeschlagen (HTTP {status})",
    "error.jevConsentRequired": "Bitte zuerst die Datenfreigabe in den Jev-Einstellungen aktivieren.",
    "error.jevKeyRequired": "Bitte zuerst einen Jev-Zugangsschlüssel hinterlegen.",
  },
};

const normalizeLocale = (raw) => {
  if (typeof raw !== "string") return null;
  const trimmed = raw.trim().toLowerCase();
  if (!trimmed) return null;
  if (trimmed === "de" || trimmed.startsWith("de-") || trimmed.startsWith("de_")) return "de";
  return "en";
};

export const getLocale = (win = globalThis.window) => {
  try {
    const localeService = globalThis.Services?.locale;
    const fromService =
      localeService?.appLocaleAsBCP47 ||
      localeService?.requestedLocale ||
      localeService?.requestedLocales?.[0];
    const resolvedService = normalizeLocale(fromService);
    if (resolvedService) return resolvedService;
  } catch {}

  try {
    const docLang = win?.document?.documentElement?.getAttribute?.("lang");
    const resolvedDoc = normalizeLocale(docLang);
    if (resolvedDoc) return resolvedDoc;
  } catch {}

  try {
    const navLang = win?.navigator?.language || globalThis.navigator?.language;
    const resolvedNav = normalizeLocale(navLang);
    if (resolvedNav) return resolvedNav;
  } catch {}

  return "en";
};

export const t = (key, params = null, win = globalThis.window) => {
  const locale = getLocale(win);
  const template = STRINGS[locale]?.[key] ?? STRINGS.en[key] ?? String(key);
  if (!params || typeof params !== "object") return template;
  return template.replace(/\{([a-zA-Z0-9_]+)\}/g, (match, name) =>
    Object.hasOwn(params, name) && params[name] !== undefined && params[name] !== null
      ? String(params[name])
      : match,
  );
};

export const SUPPORTED_LOCALES = Object.freeze(["de", "en"]);
