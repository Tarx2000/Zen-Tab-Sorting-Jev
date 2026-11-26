import { existsSync } from "node:fs";
import { access, cp, mkdir, mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { basename, isAbsolute, join, resolve } from "node:path";

import { hybridRules } from "./zen-e2e-fixtures.mjs";

const LAB_COPY_EXCLUDE_NAMES = new Set([".debug-journal.md", ".git", ".omo", "node_modules"]);
const ZIA_MOD_PATTERN = /(^|[-_])zia($|[-_])/i;
const ATG_MOD_PATTERN = /advanced[-_]?tab[-_]?groups|^atg$/i;

export const getZenBinaryCandidates = ({
  platform = process.platform,
  env = process.env,
} = {}) => {
  const home = env.HOME || env.USERPROFILE || homedir() || "";
  if (platform === "darwin") {
    return [
      "/Applications/Zen.app/Contents/MacOS/zen",
      "/Applications/Zen Browser.app/Contents/MacOS/zen",
      ...(home ? [join(home, "Applications", "Zen.app", "Contents", "MacOS", "zen")] : []),
    ];
  }
  if (platform === "win32") {
    const localAppData = env.LOCALAPPDATA || (home ? join(home, "AppData", "Local") : "");
    const programFiles = env.ProgramFiles || "C:\\Program Files";
    const programFilesX86 = env["ProgramFiles(x86)"] || "C:\\Program Files (x86)";
    return [
      ...(localAppData ? [join(localAppData, "Zen Browser", "zen.exe")] : []),
      join(programFiles, "Zen Browser", "zen.exe"),
      join(programFilesX86, "Zen Browser", "zen.exe"),
      "zen.exe",
    ];
  }
  // Linux and other POSIX systems
  return [
    "/usr/bin/zen-browser",
    "/usr/bin/zen",
    "/usr/local/bin/zen-browser",
    "/usr/local/bin/zen",
    "/opt/zen/zen",
    "/opt/zen-browser/zen",
    ...(home ? [join(home, ".local", "bin", "zen-browser"), join(home, ".local", "bin", "zen")] : []),
    "zen-browser",
  ];
};

export const resolveZenBinary = (
  explicitBinary = "",
  { platform = process.platform, env = process.env, exists = existsSync } = {},
) => {
  const direct = String(explicitBinary || "").trim();
  if (direct) return direct;
  const fromEnv = String(env.ZEN_BINARY || "").trim();
  if (fromEnv) return fromEnv;
  const candidates = getZenBinaryCandidates({ platform, env });
  for (const candidate of candidates) {
    try {
      if (exists(candidate)) return candidate;
    } catch {}
  }
  return candidates[0];
};

export const getZenProfileRoots = ({
  platform = process.platform,
  env = process.env,
} = {}) => {
  const home = env.HOME || env.USERPROFILE || homedir() || "";
  if (platform === "darwin") {
    return [join(home, "Library", "Application Support", "zen")];
  }
  if (platform === "win32") {
    const appData = env.APPDATA || (home ? join(home, "AppData", "Roaming") : "");
    return [
      ...(appData ? [join(appData, "zen"), join(appData, "Zen")] : []),
    ];
  }
  const xdgConfig = env.XDG_CONFIG_HOME || (home ? join(home, ".config") : "");
  return [
    join(home, ".zen"),
    ...(xdgConfig ? [join(xdgConfig, "zen")] : []),
    join(home, ".var", "app", "app.zen_browser.zen", ".zen"),
  ];
};

export const parseProfilesIni = (profilesIniText, baseDir) => {
  const paths = [];
  let currentPath = null;
  let isRelative = true;

  const flush = () => {
    if (!currentPath) return;
    const resolved = !isRelative || isAbsolute(currentPath)
      ? currentPath
      : resolve(baseDir, currentPath);
    paths.push(resolved);
    currentPath = null;
    isRelative = true;
  };

  for (const rawLine of String(profilesIniText || "").split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith(";") || line.startsWith("#")) continue;
    if (line.startsWith("[") && line.endsWith("]")) {
      flush();
      continue;
    }
    const eq = line.indexOf("=");
    if (eq === -1) continue;
    const key = line.slice(0, eq).trim();
    const val = line.slice(eq + 1).trim();
    if (key === "Path") currentPath = val;
    else if (key === "IsRelative") isRelative = val !== "0";
  }
  flush();
  return paths;
};

export const findDefaultSineProfile = async (
  explicitProfile = "",
  { platform = process.platform, env = process.env } = {},
) => {
  const direct = String(explicitProfile || env.ZEN_PROFILE || env.SINE_PROFILE || "").trim();
  if (direct) return direct;

  const roots = getZenProfileRoots({ platform, env });
  for (const root of roots) {
    let profilesIni;
    try {
      profilesIni = await readFile(join(root, "profiles.ini"), "utf8");
    } catch (error) {
      if (error && typeof error === "object" && "code" in error && error.code === "ENOENT") continue;
      throw error;
    }
    const profilePaths = parseProfilesIni(profilesIni, root);
    for (const profilePath of profilePaths) {
      if (await hasSineEngine(profilePath)) return profilePath;
    }
  }
  throw new Error(
    "Could not find a Zen profile with Sine installed; set ZEN_PROFILE (or SINE_PROFILE) or pass --sine-profile",
  );
};

export const createLabProfile = async (repoRoot, sineProfile, { copyZia = false } = {}) => {
  const profileDir = await mkdtemp(join(tmpdir(), "zen-tab-sorting-e2e-"));
  const chromeDir = join(profileDir, "chrome");
  const modsDir = join(chromeDir, "sine-mods");
  await mkdir(modsDir, { recursive: true });

  for (const name of ["JS", "locales", "utils"]) {
    const source = join(sineProfile, "chrome", name);
    // Recent Sine installs no longer ship the optional locale/util directories.
    try { await access(source); }
    catch (error) { if (name !== "JS" && error.code === "ENOENT") continue; throw error; }
    await cp(source, join(chromeDir, name), { recursive: true });
  }

  await cp(repoRoot, join(modsDir, "zen-tab-sorting"), {
    recursive: true,
    filter: (source) => !LAB_COPY_EXCLUDE_NAMES.has(basename(source)),
  });

  const theme = JSON.parse(await readFile(join(repoRoot, "theme.json"), "utf8"));
  theme.enabled = true;
  theme.origin = "e2e-local";
  theme["no-updates"] = true;

  const modsManifest = { "zen-tab-sorting": theme };
  const copiedMods = ["zen-tab-sorting"];
  const strippedMods = [];

  if (copyZia) {
    const sourceModsDir = join(sineProfile, "chrome", "sine-mods");
    let sourceManifest = {};
    try {
      sourceManifest = JSON.parse(await readFile(join(sourceModsDir, "mods.json"), "utf8"));
    } catch {}

    for (const [modId, meta] of Object.entries(sourceManifest)) {
      const label = `${modId} ${meta?.name || ""}`;
      if (ATG_MOD_PATTERN.test(modId) || ATG_MOD_PATTERN.test(String(meta?.name || ""))) {
        strippedMods.push(modId);
        continue;
      }
      if (!ZIA_MOD_PATTERN.test(modId) && !ZIA_MOD_PATTERN.test(label)) continue;
      const modSourceDir = join(sourceModsDir, modId);
      try {
        await access(modSourceDir);
        await cp(modSourceDir, join(modsDir, modId), {
          recursive: true,
          filter: (source) => !LAB_COPY_EXCLUDE_NAMES.has(basename(source)),
        });
        modsManifest[modId] = { ...meta, enabled: true, "no-updates": true };
        copiedMods.push(modId);
      } catch {}
    }

    // Also scan sine-mods subdirectories in case Zia was installed manually without mods.json metadata.
    try {
      for (const entry of await readdir(sourceModsDir, { withFileTypes: true })) {
        if (!entry.isDirectory()) continue;
        const modId = entry.name;
        if (ATG_MOD_PATTERN.test(modId)) {
          if (!strippedMods.includes(modId)) strippedMods.push(modId);
          continue;
        }
        if (modsManifest[modId] || !ZIA_MOD_PATTERN.test(modId)) continue;
        await cp(join(sourceModsDir, modId), join(modsDir, modId), {
          recursive: true,
          filter: (source) => !LAB_COPY_EXCLUDE_NAMES.has(basename(source)),
        });
        let ziaTheme = { id: modId, name: modId, enabled: true, "no-updates": true };
        try {
          ziaTheme = {
            ...JSON.parse(await readFile(join(sourceModsDir, modId, "theme.json"), "utf8")),
            enabled: true,
            "no-updates": true,
          };
        } catch {}
        modsManifest[modId] = ziaTheme;
        copiedMods.push(modId);
      }
    } catch {}
  }

  await writeFile(join(modsDir, "mods.json"), JSON.stringify(modsManifest), "utf8");
  return { profileDir, copiedMods, strippedMods };
};

export const removeLabProfile = async (profileDir) => {
  await rm(profileDir, { recursive: true, force: true });
};

export const writeUserPrefs = async (profileDir, prefs) => {
  const lines = prefs.map(([name, value]) => {
    const encoded = typeof value === "string" ? JSON.stringify(value) : String(value);
    return `user_pref(${JSON.stringify(name)}, ${encoded});`;
  });
  await writeFile(join(profileDir, "user.js"), `${lines.join("\n")}\n`, "utf8");
};

export const scenarioPrefs = ({ scenario, providerPort, marionettePort }) => {
  if (scenario === "jev-hybrid") {
    return [
      ["sine.allow-unsafe-js", true],
      ["sine.mods.disable-all", false],
      ["sine.auto-updates", false],
      ["sine.engine.auto-update", false],
      ["browser.startup.cache", false],
      ["browser.startup.page", 0],
      ["zen.welcome-screen.seen", true],
      ["marionette.port", marionettePort],
      ["extensions.zen-auto-organize.migration-version", "2"],
      ["extensions.zen-auto-organize.ai-engine", "jev"],
      ["extensions.zen-auto-organize.ai-fallback-provider", "custom"],
      ["extensions.zen-auto-organize.ai-jev-provider", "typesafe"],
      ["extensions.zen-auto-organize.ai-jev-api-key", "zen-tab-sorting-e2e-jev-key"],
      ["extensions.zen-auto-organize.ai-provider-consent", true],
      ["extensions.zen-auto-organize.ai-sort-mode", "rules-first"],
      ["extensions.zen-auto-organize.ai-new-group-behavior", "transient"],
      ["extensions.zen-auto-organize.ai-existing-behavior", "transient"],
      ["extensions.zen-auto-organize.ai-custom-endpoint", `http://127.0.0.1:${providerPort}/v1`],
      ["extensions.zen-auto-organize.ai-custom-api-key", "zen-tab-sorting-e2e-local-key"],
      ["extensions.zen-auto-organize.ai-custom-model", "zen-tab-sorting-e2e"],
      ["extensions.zen-auto-organize.ai-custom-format", "openai"],
      ["extensions.zen-auto-organize.use-domain-rules", true],
      ["extensions.zen-auto-organize.rules-json", JSON.stringify(hybridRules())],
    ];
  }

  const mode = scenario === "full-ai" ? "full-ai" : "hybrid";
  const rules = scenario === "hybrid" ? hybridRules() : [];
  return [
    ["sine.allow-unsafe-js", true],
    ["sine.mods.disable-all", false],
    ["sine.auto-updates", false],
    ["sine.engine.auto-update", false],
    ["browser.startup.cache", false],
    ["browser.startup.page", 0],
    ["zen.welcome-screen.seen", true],
    ["marionette.port", marionettePort],
    ["extensions.zen-auto-organize.ai-engine", "custom"],
    ["extensions.zen-auto-organize.ai-provider-consent", true],
    ["extensions.zen-auto-organize.ai-sort-mode", mode],
    ["extensions.zen-auto-organize.ai-new-group-behavior", "transient"],
    ["extensions.zen-auto-organize.ai-existing-behavior", "transient"],
    ["extensions.zen-auto-organize.ai-custom-endpoint", `http://127.0.0.1:${providerPort}/v1`],
    ["extensions.zen-auto-organize.ai-custom-api-key", "zen-tab-sorting-e2e-local-key"],
    ["extensions.zen-auto-organize.ai-custom-model", "zen-tab-sorting-e2e"],
    ["extensions.zen-auto-organize.ai-custom-format", "openai"],
    ["extensions.zen-auto-organize.use-domain-rules", scenario === "hybrid"],
    ["extensions.zen-auto-organize.rules-json", JSON.stringify(rules)],
  ];
};

const hasSineEngine = async (profilePath) => {
  try {
    await access(join(profilePath, "chrome", "JS", "sine.sys.mjs"));
    return true;
  } catch (error) {
    if (error instanceof Error && "code" in error && error.code === "ENOENT") return false;
    throw error;
  }
};
