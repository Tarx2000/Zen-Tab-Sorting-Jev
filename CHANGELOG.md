# Changelog

## 1.12.1 — 2026-10-24

### Fixed
- Library cards show one working Autosort icon. Clicks sort the selected card’s
  real Space, refresh its copied rows, and preserve the previous Space selection.
- ChatGPT token rotation persists replacement tokens even when provider settings
  were passed as a snapshot; concurrent refresh requests share a window-wide lock.
- Terminal refresh errors stop immediately, retain the issued client registration,
  and ask for a new sign-in instead of retrying them as JSON schema failures.
- Provider errors display one notification instead of duplicate toasts.

### Tests
- Isolated native Library click/grouping tests and ChatGPT rotation/recovery cases.

## 1.12.0 — 2026-10-24

### Added
- Native Space-menu action to sort all Spaces in the current window with Jev.
- Indivisible transfer of existing groups, nested folders, empty folders, pinned
  tabs and split views, preserving their objects, hierarchy and containers.
- Space-name authority, weak context for generic names, and a strict improvement
  of more than ten percentage points over the current Space before moving.
- One retry per failed Workspace operation, partial progress and a final error
  report without an Undo action or fallback-LLM calls.
- Zen Motion sorting flights, layout movement, background route summaries and
  reduced-motion support, shared by ordinary Autosort and Workspace sorting.
- Isolated native Workspace E2E harness and classification regression tests.

### Fixed
- Zero-sized native group drag images now use Zen's visible-header source option.
- Native reorder targeting at group header edges, including current Firefox drag
  MIME types; nested group headers hide when their parent is collapsed.
- Browser drag/Library copies no longer participate in grouping/state hooks.
- Concurrent sort entry points share a window lock. Ordinary Autosort defers all
  mutations until planning completes; canceling Plan Mode leaves the tabs alone.
- Collapsed-state persistence uses group IDs instead of colliding group names.
- Per-window SessionStore metadata preserves normal-group Spaces, nesting and
  collapsed state when Zen restores a session.
- Test profiles support current Sine layouts and skip the first-run welcome UI.

## 1.11.0 — 2026-10-24

### Added
- **Floating in-browser toast notifications**: Elegant, non-intrusive in-window toast alerts in Zen Browser that immediately inform users of quota limits (e.g. ChatGPT subscription sharing limit), errors, and sort status.
- **Dedicated ChatGPT Subscription Sharing limit detection**: Detects subscription sharing usage limits with clear German toast alerts and advice on alternatives (PrimaLabs, API keys, or JEV-only mode).
- **Empty folder support in JEV**: User-created empty folders in the active workspace are now preserved as target categories for JEV instead of being ignored.

### Fixed
- **JEV Stage 1 bypass bug**: Fixed an issue where `isFreshLike` forced `liveExistingGroups` to an empty array in Full AI mode, inadvertently skipping JEV Stage 1 entirely. JEV now always queries the active workspace groups.
- **Graceful JEV-only fallback**: When Stage 2 (ChatGPT / Fallback-LLM) fails or encounters a usage/quota limit, JEV Stage 1 assignments to existing groups are safely applied and preserved, and remaining tabs stay untouched without crashing the sort process.
- **Enhanced debug logging**: Added `STAGE-1-SKIPPED`, `STAGE-1-ERROR`, and `STAGE-2-FALLBACK-ABORTED` journal events for transparent diagnostic tracing.

## 1.0.2 — 2026-06-01

### Added
- **Local AI engine now honours the "When AI creates a new group" dropdown** with all three behaviours: Auto-add, Transient, Fresh categories (previously Ollama-only).
- **Local Fresh mode.** Clusters every tab into new hostname/intent-named groups using the bundled embedding model.
- **Plan Mode (identify-only) modal now works for the Local engine**, not just Ollama.
- **Page-context snippets** (`og:type`, `og:site_name`, first `h1`, description) are now fetched and fed to both engines for better classification.
- **3rd-phase fuzzy name dedupe for Ollama Fresh.** Catches near-duplicate cluster names like "Content Unavailable" + "Content Unavailability" or "Communication Apps" + "Communication Tools".
- **Stickiness in Ollama unified mode.** Tabs already in an existing group can't be pulled into brand-new AI-invented groups — only into other existing groups.
- **Skip Domains** setting (carry-over polish on top of 1.0.1's section).
- **Strict rule enforcement** option that ejects tabs from a group when their hostname isn't listed in that group's rule.
- **Drag-handle reorder** of rules in the settings rules editor.
- **Right-click "Dissolve group"** on tab-groups; **"Add to Rule…" submenu** on tabs.
- **Collapsed-group state persists across browser restarts.**
- **Chunking + hostname-dedupe for Local AI** on workspaces with >75 unmatched tabs. Configurable batch size; soft-cap confirmation modal at >500 tabs.
- **First-time warning modal** when selecting the Ollama or Local AI engine (fires once per engine).
- **README "Choosing an AI model" table** with qwen2.5 size variants.

### Changed
- **Ollama generate timeout raised from 60s → 180s.** Accommodates qwen2.5:7b classifying 100+ unique tabs in one pass.
- **Unified-classifier prompt** now carries an explicit anti-catch-all instruction so the model stops dumping unrelated tabs into a generic existing rule like "Utils".

### Fixed
- **Auto-sort into a collapsed group.** Target group now re-collapses correctly and the newly-added tabs are properly `aria-hidden`.
- **Collapse state survives session restore.** Zen's session save drops the `collapsed` attribute; we re-apply it from a persisted pref on workspace load.
- **In-progress rules with no domains yet** now survive a browser restart and show up in the right-click "Add to Rule…" submenu.

## 1.0.1 — 2026-05-19

### Added
- **Tab right-click "Add to Rule…" submenu.** Hover the new entry on any tab → submenu lists every rule (✓ + disabled for rules that already contain the hostname) plus a **Skip** entry that adds the hostname to the Skip Domains list. Replaces the previous passive auto-add-on-drag behaviour with explicit user intent.
- **Skip Domains** section in settings. Hostnames in this list never get touched by the wand — matching tabs are ejected from any group and parked at the top of the workspace on every click.
- **Strict rule enforcement** toggle under Look & Feel. When on, any tab inside a group whose rule doesn't list its hostname is ejected to the top when you click the wand. Off by default.
- **Backup & Restore Export** now downloads a real JSON file to your default Downloads folder (`wand-backup-<N>groups-<YYYYMMDD-HHmmss>.json`) and registers it in Firefox's downloads panel.
- **Backup file format upgraded** from a bare rules array to `{ rules: [...], skipDomains: [...] }` so the skip-domains list rides along. Import still accepts the legacy bare-array shape.
- Section descriptions under Group Rules / Skip Domains / Backup & Restore / Look & Feel / AI Sorting separators.

### Changed
- **Removed the global TabGrouped auto-add hook.** It listened for any tab joining a group and silently appended the tab's hostname to the matching rule. The hook couldn't reliably distinguish user actions from Zen's async session-restore re-attaches (which fire after we explicitly ungroup a tab), leading to surprise rule bloat. Rule growth now goes through three explicit paths only: the settings rule editor, the right-click submenu, and AI Pass 2.
- **Pass 1 + dedupe no longer grow rules as a side effect.** The wand click is now idempotent on the rules list when AI is off — clicking it never changes your rules.
- Section headers (Group Rules / Skip Domains / Backup & Restore / Look & Feel / AI Sorting) all share Sine's native separator styling for a uniform look.

### Fixed
- **Sticky-drag on Windows.** After the wand sorted tabs, the first drag attempt on any moved tab would silently fail; second attempt worked. Root cause: raw `tabsContainer.insertBefore` left Firefox's `_tPos` cache stale. Now triggers `gZenWorkspaces.updateTabsContainers()` + a cache touch at click end.
- **Plan Mode modal transparency on Windows.** The modal inherited Zen's translucent toolbar background. Switched to opaque `Canvas` system colour.
- **Strict-mode ejection now uses `gBrowser.ungroupTab`** before reparenting, so Zen's group bookkeeping stays in sync and the tab actually stays out of the group.

## 1.0.0 — Initial public release

- Two-pass tab organization: deterministic domain rules first, optional AI fallback (Firefox's bundled smart-tab-embedding model or a local Ollama daemon).
- Pill-table rules editor in settings with per-rule colour picker.
- Plan Mode interactive modal for AI Pass 2 (preview the proposed plan, keep/skip groups, re-assign).
- Backup & Restore export/import (rules only).
- Per-workspace toolbar wand button with wiggle / AI-thinking pulse animations.
- Live re-styling on Minimal Style toggle.
- Optional Ollama warmup preference for low-latency first clicks.
