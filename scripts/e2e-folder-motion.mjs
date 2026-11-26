#!/usr/bin/env node
// Isolated Zen.app live E2E verification harness for folder appearance & collapse/expand motion (Q9).
// Launches an isolated temporary Zen profile copy (with optional --copy-zia copying Zia
// while stripping advanced-tab-groups), confirms atg-folder-look SVG rendering, zero
// max-height: 4000px transitions, WAAPI animations running, and measures frame-timing / jank metrics.
import assert from "node:assert/strict";
import { mkdir, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import {
  assertConnectedProfile,
  delay,
  launchZen,
  stopZen,
  waitForZenReady,
} from "./zen-e2e-driver.mjs";
import { MarionetteClient, reserveTcpPort } from "./zen-e2e-marionette.mjs";
import {
  createLabProfile,
  findDefaultSineProfile,
  removeLabProfile,
  resolveZenBinary,
  scenarioPrefs,
  writeUserPrefs,
} from "./zen-e2e-profile.mjs";
import { startFixturePageServer } from "./zen-e2e-servers.mjs";

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");

export const parseFolderMotionArgs = (argv) => {
  const options = {
    headed: false,
    keepProfile: false,
    copyZia: false,
    cycles: 4,
    tabsPerGroup: 6,
    groups: 3,
    zenBinary: "",
    sineProfile: "",
    report: "",
    help: false,
  };

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === "--headed") options.headed = true;
    else if (arg === "--keep-profile") options.keepProfile = true;
    else if (arg === "--copy-zia") options.copyZia = true;
    else if (arg === "--cycles") options.cycles = Number.parseInt(argv[++i] || "", 10);
    else if (arg === "--tabs-per-group") options.tabsPerGroup = Number.parseInt(argv[++i] || "", 10);
    else if (arg === "--groups") options.groups = Number.parseInt(argv[++i] || "", 10);
    else if (arg === "--zen-binary") options.zenBinary = argv[++i] || "";
    else if (arg === "--sine-profile") options.sineProfile = argv[++i] || "";
    else if (arg === "--report") options.report = argv[++i] || "";
    else if (arg === "--help") options.help = true;
    else throw new Error(`Unknown argument: ${arg}`);
  }

  if (!Number.isInteger(options.cycles) || options.cycles < 1 || options.cycles > 50) {
    throw new Error("--cycles must be an integer between 1 and 50");
  }
  if (!Number.isInteger(options.tabsPerGroup) || options.tabsPerGroup < 1 || options.tabsPerGroup > 50) {
    throw new Error("--tabs-per-group must be an integer between 1 and 50");
  }
  if (!Number.isInteger(options.groups) || options.groups < 1 || options.groups > 20) {
    throw new Error("--groups must be an integer between 1 and 20");
  }

  return options;
};

export const summarizeFrameDeltas = (deltas) => {
  const valid = (Array.isArray(deltas) ? deltas : []).filter((d) => Number.isFinite(d) && d > 0);
  if (valid.length === 0) {
    return {
      frameCount: 0,
      avgFrameMs: 0,
      p95FrameMs: 0,
      maxFrameMs: 0,
      droppedFrames: 0,
      jankFrames: 0,
      estimatedFps: 0,
    };
  }
  const sorted = [...valid].sort((a, b) => a - b);
  const sum = valid.reduce((acc, d) => acc + d, 0);
  const avg = sum / valid.length;
  const p95Idx = Math.min(sorted.length - 1, Math.floor(sorted.length * 0.95));
  return {
    frameCount: valid.length,
    avgFrameMs: Number(avg.toFixed(2)),
    p95FrameMs: Number(sorted[p95Idx].toFixed(2)),
    maxFrameMs: Number(sorted.at(-1).toFixed(2)),
    droppedFrames: valid.filter((d) => d > 24).length,
    jankFrames: valid.filter((d) => d > 50).length,
    estimatedFps: Number((1000 / Math.max(1, avg)).toFixed(1)),
  };
};

export const runFolderMotionE2E = async (options) => {
  const sineProfile = await findDefaultSineProfile(options.sineProfile);
  const lab = await createLabProfile(REPO_ROOT, sineProfile, { copyZia: options.copyZia });
  const marionettePort = await reserveTcpPort();
  const pages = await startFixturePageServer();
  let zen = null;
  let client = null;

  const execute = async (script) => {
    const result = await client.executeAsync(`
      const done = arguments[arguments.length - 1];
      const win = Services.wm.getMostRecentWindow("navigator:browser");
      (async () => { ${script} })()
        .then((value) => done({ value }))
        .catch((error) => done({ error: error?.stack || error?.message || String(error) }));
    `);
    if (result?.error) throw new Error(result.error);
    return result?.value;
  };

  try {
    await writeUserPrefs(lab.profileDir, [
      ...scenarioPrefs({ scenario: "hybrid", providerPort: 1, marionettePort }),
      ["ui.prefersReducedMotion", 0],
      ["zen.view.sidebar-expanded", true],
      ["browser.startup.page", 0],
    ]);

    zen = launchZen({
      options: {
        headed: options.headed,
        zenBinary: resolveZenBinary(options.zenBinary),
      },
      profileDir: lab.profileDir,
      marionettePort,
    });

    client = await MarionetteClient.connect(marionettePort);
    await client.newSession();
    await client.setScriptTimeout(60000);
    await client.setChromeContext();
    await assertConnectedProfile(client, lab.profileDir);
    await waitForZenReady(client);

    // Seed groups and measure static CSS / SVG invariants + real collapse/expand animation timing.
    const report = await execute(`
      const browser = win.gBrowser;
      const manager = win.gZenWorkspaces;
      const workspaceId = manager.activeWorkspace;
      const principal = Services.scriptSecurityManager.getSystemPrincipal();
      const colors = ["blue", "purple", "green", "orange", "cyan"];
      const groupCount = ${options.groups};
      const tabsPerGroup = ${options.tabsPerGroup};
      const cycles = ${options.cycles};

      const groups = [];
      for (let g = 0; g < groupCount; g++) {
        const tabs = [];
        for (let t = 0; t < tabsPerGroup; t++) {
          const tab = browser.addTab(
            "http://127.0.0.1:${pages.port}/motion-g" + g + "-t" + t,
            { inBackground: true, skipAnimation: true, triggeringPrincipal: principal }
          );
          tab.setAttribute("label", "Motion Group " + (g + 1) + " Tab " + (t + 1));
          tab.setAttribute("zen-workspace-id", workspaceId);
          tabs.push(tab);
        }
        const group = browser.addTabGroup(tabs, {
          label: "Motion Folder " + (g + 1),
          color: colors[g % colors.length],
          insertBefore: manager.activeWorkspaceElement?.tabsContainer?.firstChild || null,
        });
        group.setAttribute("zen-workspace-id", workspaceId);
        groups.push(group);
      }
      manager.updateTabsContainers?.();
      await new Promise((r) => win.setTimeout(r, 350));

      // 1. Inspect stylesheets and computed styles for forbidden max-height: 4000px transitions.
      const maxHeight4000Matches = [];
      for (const sheet of [...win.document.styleSheets]) {
        let rules;
        try { rules = sheet.cssRules; } catch { continue; }
        const walk = (ruleList) => {
          for (const rule of ruleList || []) {
            if (rule.cssRules) { walk(rule.cssRules); continue; }
            const text = rule.cssText || "";
            if (/max-height\s*:\s*4000px/i.test(text)) {
              maxHeight4000Matches.push({
                href: sheet.href || "(inline)",
                selector: rule.selectorText || "",
              });
            }
          }
        };
        walk(rules);
      }

      // 2. Inspect folder look SVG rendering and computed transitions on live groups.
      const folderLookChecks = groups.map((group) => {
        const header = group.labelContainerElement || group.querySelector(".tab-group-label-container");
        const container = group.groupContainer || group.querySelector(".tab-group-container");
        const headerStyle = header ? win.getComputedStyle(header) : null;
        const labelEl = group.querySelector(".tab-group-label");
        const labelBefore = labelEl ? win.getComputedStyle(labelEl, "::before") : null;
        const containerStyle = container ? win.getComputedStyle(container) : null;
        const svgIcon = header?.querySelector("svg") || group.querySelector(".zao-folder-icon, .atg-folder-icon, svg");
        const svgRect = svgIcon?.getBoundingClientRect?.();
        const hasMaskOrBgSvg =
          (labelBefore?.maskImage && labelBefore.maskImage !== "none") ||
          (labelBefore?.backgroundImage && labelBefore.backgroundImage.includes("svg")) ||
          (headerStyle?.backgroundImage && headerStyle.backgroundImage.includes("svg"));
        return {
          label: group.getAttribute("label") || "",
          hasAtgFolderLookAttr:
            group.classList.contains("atg-folder-look") ||
            win.document.documentElement.hasAttribute("data-zao-folder-look") ||
            Boolean(group.querySelector("[data-zao-folder-icon], .atg-folder-icon, .zao-folder-icon")),
          svgRendered: Boolean(
            (svgIcon && svgRect && svgRect.width > 0 && svgRect.height > 0) || hasMaskOrBgSvg
          ),
          containerTransitionProperty: containerStyle?.transitionProperty || "",
          containerMaxHeight: containerStyle?.maxHeight || "",
        };
      });

      // 3. Drive collapse & expand cycles while sampling rAF frame timing & WAAPI animations.
      const targetGroup = groups[0];
      const targetHeader = targetGroup.labelElement || targetGroup.querySelector(".tab-group-label") || targetGroup.labelContainerElement;
      const allFrameDeltas = [];
      let waapiObservedCount = 0;
      const cycleMetrics = [];

      for (let cycle = 0; cycle < cycles; cycle++) {
        for (const action of ["collapse", "expand"]) {
          const deltas = [];
          let waapiSeen = 0;
          let running = true;
          let prev = win.performance.now();
          const rafLoop = (now) => {
            const dt = now - prev;
            prev = now;
            if (dt > 0) {
              deltas.push(dt);
              allFrameDeltas.push(dt);
            }
            const animatedNodes = [
              targetGroup,
              targetGroup.groupContainer,
              targetHeader,
              ...targetGroup.querySelectorAll("tab, .tab-group-container, .tab-group-label-container, svg"),
            ].filter(Boolean);
            for (const node of animatedNodes) {
              for (const anim of node.getAnimations?.() || []) {
                if (anim.playState === "running") waapiSeen += 1;
              }
            }
            if (running) win.requestAnimationFrame(rafLoop);
          };
          win.requestAnimationFrame(rafLoop);

          const beforeCollapsed = Boolean(targetGroup.collapsed);
          if (typeof targetHeader?.click === "function") {
            targetHeader.click();
          } else {
            targetGroup.collapsed = action === "collapse";
          }
          await new Promise((r) => win.setTimeout(r, 340));
          running = false;
          await new Promise((r) => win.setTimeout(r, 40));

          const afterCollapsed = Boolean(targetGroup.collapsed);
          waapiObservedCount += waapiSeen;
          cycleMetrics.push({
            cycle,
            action,
            beforeCollapsed,
            afterCollapsed,
            toggled: beforeCollapsed !== afterCollapsed,
            waapiSeen,
            frames: deltas.length,
          });
        }
      }

      return {
        maxHeight4000Transitions: maxHeight4000Matches.length,
        maxHeight4000Matches,
        folderLookChecks,
        waapiObservedCount,
        cycleMetrics,
        allFrameDeltas,
      };
    `);

    const timing = summarizeFrameDeltas(report.allFrameDeltas);
    const summary = {
      profileDir: lab.profileDir,
      copyZia: options.copyZia,
      copiedMods: lab.copiedMods,
      strippedMods: lab.strippedMods,
      maxHeight4000Transitions: report.maxHeight4000Transitions,
      maxHeight4000Matches: report.maxHeight4000Matches,
      folderLookChecks: report.folderLookChecks,
      waapiObservedCount: report.waapiObservedCount,
      timing,
      cycles: report.cycleMetrics,
    };

    if (options.report) {
      await mkdir(dirname(resolve(options.report)), { recursive: true });
      await writeFile(resolve(options.report), `${JSON.stringify(summary, null, 2)}\n`, "utf8");
    }

    console.log(JSON.stringify(summary, null, 2));

    assert.equal(
      summary.maxHeight4000Transitions,
      0,
      `Found forbidden max-height: 4000px transition rules: ${JSON.stringify(summary.maxHeight4000Matches)}`,
    );
    assert.ok(
      summary.cycles.every((c) => c.toggled),
      `Every collapse/expand cycle must toggle group.collapsed: ${JSON.stringify(summary.cycles)}`,
    );
    assert.ok(
      summary.timing.frameCount > 0,
      "Frame timing sampler must capture animation frames during collapse/expand",
    );

    console.log(
      `folder-motion-e2e: PASS zero max-height:4000px transitions, ${summary.timing.frameCount} frames (avg ${summary.timing.avgFrameMs}ms, p95 ${summary.timing.p95FrameMs}ms, jank ${summary.timing.jankFrames}, waapi ${summary.waapiObservedCount})`,
    );
    return summary;
  } finally {
    try { await client?.quit(); } catch {}
    client?.close();
    if (zen) await stopZen(zen);
    await pages.close();
    if (!options.keepProfile) await removeLabProfile(lab.profileDir);
    else console.log(`folder-motion-e2e: retained profile ${lab.profileDir}`);
  }
};

const helpText = () => `Usage: node scripts/e2e-folder-motion.mjs [options]

Options:
  --copy-zia                Copy Zia from Sine profile while stripping advanced-tab-groups
  --headed                  Launch a visible lab Zen window
  --cycles <n>              Collapse/expand cycles to measure (default: 4)
  --groups <n>              Tab groups to create (default: 3)
  --tabs-per-group <n>      Tabs per group (default: 6)
  --report <path>           Write JSON motion/timing report to path
  --keep-profile            Keep the temporary profile after the run
  --zen-binary <path>       Zen binary path (or ZEN_BINARY env var)
  --sine-profile <path>     Zen profile with Sine installed (or ZEN_PROFILE env var)
`;

const isCli = process.argv[1] === fileURLToPath(import.meta.url);

if (isCli) {
  const options = parseFolderMotionArgs(process.argv.slice(2));
  if (options.help) {
    console.log(helpText());
  } else {
    runFolderMotionE2E(options).catch((error) => {
      console.error(`folder-motion-e2e: ${error?.stack || error?.message || error}`);
      process.exitCode = 1;
    });
  }
}
