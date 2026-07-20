/**
 * Theme Injector: Converts DesktopTheme JSON to CSS variable overrides
 * and injects them into the Electron renderer via CDP.
 *
 * Works alongside the translation injection — both use the same
 * Page.addScriptToEvaluateOnNewDocument + Runtime.evaluate pattern.
 */

import { existsSync, readFileSync } from "node:fs"
import path from "node:path"
import { fileURLToPath, pathToFileURL } from "node:url"
import type { DesktopTheme, PageVisualConfig, ThemeMode, VisualThemeConfig } from "./theme-manager.js"

const INJECTION_MARKER = "__OPENCODE_ZH_THEME__"
const VISUAL_MARKER = "__OPENCODE_ZH_VISUALS__"

const V2_FALLBACKS: Record<string, string[]> = {
  "text-base": ["v2-text-text-base"],
  "text-strong": ["v2-text-text-strong", "v2-text-text-base"],
  "text-muted": ["v2-text-text-muted"],
  "text-faint": ["v2-text-text-faint"],
  "background-base": ["v2-background-bg-deep"],
  "background-weak": ["v2-background-bg-layer-03"],
  "background-strong": ["v2-background-bg-layer-02"],
  "background-stronger": ["v2-background-bg-layer-02"],
  "surface-base": ["v2-background-bg-base", "v2-background-bg-layer-01"],
  "border-base": ["v2-border-border-base"],
  "border-muted": ["v2-border-border-muted"],
  "accent-base": [
    "v2-background-bg-accent",
    "v2-text-text-accent",
    "v2-icon-icon-accent",
  ],
}

function addVariable(variables: Map<string, string>, name: string, value: string): void {
  variables.set(name.startsWith("--") ? name : `--${name}`, value)
}

/** Build all variables consumed by both legacy and Desktop v2 UI styles. */
function buildVariableEntries(
  overrides: Record<string, string>,
  v2Overrides: Record<string, string>,
): Array<[string, string]> {
  const variables = new Map<string, string>()
  for (const [token, color] of Object.entries(overrides)) {
    addVariable(variables, token, color)
    if (!token.startsWith("color-")) addVariable(variables, `color-${token}`, color)
  }

  for (const [token, color] of Object.entries(v2Overrides)) {
    addVariable(variables, token.startsWith("v2-") ? token : `v2-${token}`, color)
  }

  for (const [token, color] of Object.entries(overrides)) {
    for (const fallback of V2_FALLBACKS[token] ?? []) {
      if (!variables.has(`--${fallback}`)) addVariable(variables, fallback, color)
    }
  }
  return [...variables.entries()]
}

/** Build a CSS rule string that sets CSS variables on :root. */
function buildCssBlock(
  overrides: Record<string, string>,
  v2Overrides: Record<string, string> = {},
): string {
  const lines = buildVariableEntries(overrides, v2Overrides)
    .map(([name, value]) => `    ${name}: ${value};`)
  return `:root {\n${lines.join("\n")}\n  }`
}

function clampNumber(value: unknown, min: number, max: number): number | undefined {
  if (typeof value !== "number" || !Number.isFinite(value)) return undefined
  return Math.min(max, Math.max(min, value))
}

function normalizeVisuals(value: VisualThemeConfig | undefined): VisualThemeConfig | undefined {
  if (!value) return undefined
  return {
    backgroundImage: typeof value.backgroundImage === "string" ? value.backgroundImage : undefined,
    backgroundPosition: typeof value.backgroundPosition === "string" ? value.backgroundPosition : "center",
    backgroundSize: value.backgroundSize === "contain" || value.backgroundSize === "auto" ? value.backgroundSize : "cover",
    backgroundOpacity: clampNumber(value.backgroundOpacity, 0, 1) ?? 1,
    overlayColor: typeof value.overlayColor === "string" ? value.overlayColor : undefined,
    glassOpacity: clampNumber(value.glassOpacity, 0, 1) ?? 0.48,
    glassBlur: clampNumber(value.glassBlur, 0, 40) ?? 18,
    glassSaturation: clampNumber(value.glassSaturation, 50, 200) ?? 120,
    atmosphere: value.atmosphere !== false,
    atmosphereOpacity: clampNumber(value.atmosphereOpacity, 0, 1) ?? 0.65,
    animation: value.animation === true,
  }
}

function resolveVisualAsset(value: string | undefined, baseDirectory: string): string | undefined {
  if (!value) return undefined
  if (/^data:/i.test(value)) return value
  if (/^https?:/i.test(value)) return value
  // For file:// and local paths, read the file and convert to data URI
  // to avoid Electron CSP blocking file:// in CSS background-image
  const absolutePath = /^(?:file:)/i.test(value)
    ? fileURLToPath(value)
    : path.resolve(baseDirectory, value)
  if (!existsSync(absolutePath)) return undefined
  const ext = path.extname(absolutePath).toLowerCase()
  const buffer = readFileSync(absolutePath)
  const mime = ext === ".svg" ? "image/svg+xml"
    : ext === ".png" ? "image/png"
    : ext === ".jpg" || ext === ".jpeg" ? "image/jpeg"
    : ext === ".gif" ? "image/gif"
    : ext === ".webp" ? "image/webp"
    : "application/octet-stream"
  return `data:${mime};base64,${buffer.toString("base64")}`
}

function prepareThemeAssets(theme: DesktopTheme, baseDirectory: string): DesktopTheme {
  const resolve = (visuals: VisualThemeConfig | undefined): VisualThemeConfig | undefined => {
    const normalized = normalizeVisuals(visuals)
    if (!normalized) return undefined
    return { ...normalized, backgroundImage: resolveVisualAsset(normalized.backgroundImage, baseDirectory) }
  }
  return {
    ...theme,
    light: { ...theme.light, visuals: resolve(theme.light.visuals) },
    dark: { ...theme.dark, visuals: resolve(theme.dark.visuals) },
    pages: Object.fromEntries(
      Object.entries(theme.pages ?? {}).map(([page, visuals]) => [page, { ...visuals, ...resolve(visuals) }]),
    ) as DesktopTheme["pages"],
  }
}

/**
 * Build the JavaScript injection string for a theme.
 * This runs inside the renderer process via CDP.
 *
 * The script:
 * 1. Detects light/dark mode from the document
 * 2. Creates a <style> element with CSS variable overrides
 * 3. Watches for theme mode changes via MutationObserver
 * 4. Persists across page navigations (via addScriptToEvaluateOnNewDocument)
 */
export function buildThemeInjectionScript(theme: DesktopTheme): string {
  // Build a JS object mapping mode → CSS string for runtime switching
  // Includes legacy, semantic, and Desktop v2 variables.
  const lightEntries = buildVariableEntries(
    theme.light.overrides ?? {},
    theme.light.v2Overrides ?? {},
  ).map(([key, value]) => `    ${JSON.stringify(key)}: ${JSON.stringify(value)}`).join(",\n")
  const darkEntries = buildVariableEntries(
    theme.dark.overrides ?? {},
    theme.dark.v2Overrides ?? {},
  ).map(([key, value]) => `    ${JSON.stringify(key)}: ${JSON.stringify(value)}`).join(",\n")
  const visualConfig = JSON.stringify({
    light: normalizeVisuals(theme.light.visuals),
    dark: normalizeVisuals(theme.dark.visuals),
    pages: theme.pages ?? {},
  })

  return `(function () {
  "use strict";

  var MARKER = "${INJECTION_MARKER}";
  var VISUAL_MARKER = "${VISUAL_MARKER}";

  // Clean up previous instance
  var prev = window[MARKER];
  if (prev && typeof prev.cleanup === "function") prev.cleanup();

  var styleEl = null;
  var observer = null;
  var cleanupFns = [];
  var visualCleanup = null;

  var LIGHT_VARS = {
${lightEntries}
  };
  var DARK_VARS = {
${darkEntries}
  };
  var VISUAL_CONFIG = ${visualConfig};

  function detectMode() {
    // 1. Check data-theme attribute on <html>
    var dataTheme = document.documentElement.getAttribute("data-theme");
    if (dataTheme === "light" || dataTheme === "dark") return dataTheme;

    // 2. Check OpenCode's own theme state via data-theme on body
    var bodyTheme = document.body && document.body.getAttribute("data-theme");
    if (bodyTheme === "light" || bodyTheme === "dark") return bodyTheme;

    // 3. Fall back to prefers-color-scheme
    if (window.matchMedia && window.matchMedia("(prefers-color-scheme: light)").matches) return "light";
    return "dark";
  }

  function applyVars(vars) {
    if (!styleEl) {
      styleEl = document.createElement("style");
      styleEl.id = "opencode-zh-theme";
      (document.head || document.documentElement).appendChild(styleEl);
    }
    var lines = [":root {"];
    for (var key in vars) {
      if (Object.prototype.hasOwnProperty.call(vars, key)) {
        lines.push("    " + key + ": " + vars[key] + " !important;");
      }
    }
    lines.push("  }");
    styleEl.textContent = lines.join("\\n");
  }

  function sync() {
    var mode = detectMode();
    var vars = mode === "light" ? LIGHT_VARS : DARK_VARS;
    applyVars(vars);
    console.log("[opencode-zh-theme] Applied " + mode + " theme (" + Object.keys(vars).length + " variables)");
  }

  function cleanup() {
    if (observer) { observer.disconnect(); observer = null; }
    if (styleEl && styleEl.parentNode) { styleEl.parentNode.removeChild(styleEl); styleEl = null; }
    for (var i = 0; i < cleanupFns.length; i++) cleanupFns[i]();
    cleanupFns = [];
    if (visualCleanup) { visualCleanup(); visualCleanup = null; }
  }

  window[MARKER] = { cleanup: cleanup };

  // Initial apply
  sync();

  // Watch for data-theme changes on <html> and <body>
  observer = new MutationObserver(function (mutations) {
    for (var i = 0; i < mutations.length; i++) {
      var m = mutations[i];
      if (m.type === "attributes" && (m.attributeName === "data-theme" || m.attributeName === "class")) {
        sync();
        return;
      }
    }
  });
  observer.observe(document.documentElement, { attributes: true, attributeFilter: ["data-theme", "class"] });
  if (document.body) {
    observer.observe(document.body, { attributes: true, attributeFilter: ["data-theme", "class"] });
  }

  // Watch prefers-color-scheme media query
  if (window.matchMedia) {
    var mqLight = window.matchMedia("(prefers-color-scheme: light)");
    var handler = function () { sync(); };
    if (mqLight.addEventListener) {
      mqLight.addEventListener("change", handler);
      cleanupFns.push(function () { mqLight.removeEventListener("change", handler); });
    } else if (mqLight.addListener) {
      mqLight.addListener(handler);
      cleanupFns.push(function () { mqLight.removeListener(handler); });
    }
  }

  function startVisualRuntime() {
    var previous = window[VISUAL_MARKER];
    if (previous && typeof previous.cleanup === "function") previous.cleanup();

    var hasPageVisuals = VISUAL_CONFIG.pages && Object.keys(VISUAL_CONFIG.pages).length > 0;
    if (!VISUAL_CONFIG.light && !VISUAL_CONFIG.dark && !hasPageVisuals) return function () {};

    var visualStyle = null;
    var background = null;
    var glass = null;
    var atmosphere = null;
    var pageObserver = null;
    var routeTimer = null;
    var originalPush = history.pushState;
    var originalReplace = history.replaceState;

    function element(id, className) {
      var node = document.getElementById(id);
      if (!node) {
        node = document.createElement("div");
        node.id = id;
        node.className = className;
        (document.body || document.documentElement).appendChild(node);
      }
      return node;
    }

    function pageName() {
      var pathname = String(location.pathname || "").toLowerCase();
      if (pathname.includes("settings") || pathname.includes("preferences")) return "settings";
      if (pathname.includes("session") || pathname.includes("chat")) return "session";
      if (pathname.includes("project") || pathname.includes("workspace")) return "project";
      var text = document.body ? String(document.body.innerText || "").slice(0, 4000) : "";
      // The tab bar contains "新建会话" even while a conversation is open.
      // Conversation landmarks must win over tab labels.
      if (text.includes("复制消息") || text.includes("复制回复") || text.includes("跳转到最新")) return "session";
      if (text.includes("配色方案") || text.includes("Appearance")) return "settings";
      if (text.includes("所有文件") || text.includes("All files") || text.includes("文件变更")) return "project";
      if (text.includes("新建会话") || text.includes("New session")) return "home";
      if (pathname === "/" || pathname === "/index.html" || pathname === "") return "home";
      if (text.includes("Ask anything") || text.includes("随便问点什么")) return "session";
      return "unknown";
    }

    function currentVisuals() {
      var mode = detectMode();
      var base = VISUAL_CONFIG[mode] || {};
      var page = pageName();
      var override = VISUAL_CONFIG.pages && VISUAL_CONFIG.pages[page];
      return Object.assign({}, base, override || {});
    }

    function cssUrl(value) {
      if (!value) return "none";
      return "url(\\"" + String(value).replace(/\\"/g, "%22") + "\\")";
    }

    function applyVisuals() {
      var config = currentVisuals();
      document.documentElement.setAttribute("data-opencode-zh-page", pageName());
      // Make html/body backgrounds transparent so our fixed layers show through
      document.documentElement.style.setProperty("background-color", "transparent", "important");
      if (document.body) document.body.style.setProperty("background-color", "transparent", "important");
      if (!visualStyle) {
        visualStyle = document.createElement("style");
        visualStyle.id = "opencode-zh-visuals";
        (document.head || document.documentElement).appendChild(visualStyle);
      }
      var animation = config.animation && !(window.matchMedia && window.matchMedia("(prefers-reduced-motion: reduce)").matches);
      var image = cssUrl(config.backgroundImage);
      visualStyle.textContent = [
        ":root {",
        "  --skin-glass-opacity: " + (config.glassOpacity ?? 0.48) + ";",
        "  --skin-glass-blur: " + (config.glassBlur ?? 18) + "px;",
        "  --skin-glass-saturation: " + (config.glassSaturation ?? 120) + "%;",
        "  --skin-background-opacity: " + (config.backgroundOpacity ?? 1) + ";",
        "  --skin-atmosphere-opacity: " + (config.atmosphereOpacity ?? 0.65) + ";",
        "}",
        "#opencode-zh-background, #opencode-zh-glass, #opencode-zh-atmosphere { position: fixed; inset: 0; pointer-events: none; transition: opacity 280ms ease, background-color 280ms ease, filter 280ms ease; }",
        "#opencode-zh-background { z-index: 2147483000; background-image: " + image + "; background-position: " + (config.backgroundPosition || "center") + "; background-size: " + (config.backgroundSize || "cover") + "; background-repeat: no-repeat; opacity: var(--skin-background-opacity); mix-blend-mode: screen; filter: saturate(1.15) brightness(1.1); }",
        "#opencode-zh-glass { z-index: 2147482998; background: " + (config.overlayColor || "rgb(14 26 36 / 48%)") + "; opacity: var(--skin-glass-opacity); mix-blend-mode: soft-light; backdrop-filter: blur(var(--skin-glass-blur)) saturate(var(--skin-glass-saturation)); -webkit-backdrop-filter: blur(var(--skin-glass-blur)) saturate(var(--skin-glass-saturation)); }",
        "#opencode-zh-atmosphere { z-index: 2147482999; display: " + (config.atmosphere === false ? "none" : "block") + "; opacity: var(--skin-atmosphere-opacity); mix-blend-mode: screen; background: radial-gradient(circle at 18% 12%, rgb(85 169 232 / 32%), transparent 34%), radial-gradient(circle at 82% 72%, rgb(45 154 181 / 26%), transparent 38%); " + (animation ? "animation: opencode-zh-atmosphere-pulse 14s ease-in-out infinite alternate;" : "") + " }",
        "body > *:not(#opencode-zh-background):not(#opencode-zh-glass):not(#opencode-zh-atmosphere) { position: relative; z-index: 3; }",
        ".bg-v2-background-bg-deep { background-color: color-mix(in srgb, var(--v2-background-bg-deep) 62%, transparent) !important; }",
        ".bg-v2-background-bg-base, .bg-background-base { background-color: color-mix(in srgb, var(--v2-background-bg-base) 72%, transparent) !important; }",
        ".bg-v2-background-bg-base[class*='z-[70]'] { background-color: var(--v2-background-bg-base) !important; }",
        ".bg-background-stronger { background-color: color-mix(in srgb, var(--background-stronger) 76%, transparent) !important; }",
        "@keyframes opencode-zh-atmosphere-pulse { from { transform: scale(1); } to { transform: scale(1.04); } }",
        "@media (prefers-reduced-motion: reduce) { #opencode-zh-background, #opencode-zh-glass, #opencode-zh-atmosphere { transition: none; animation: none !important; } }",
        "@media (forced-colors: active) { #opencode-zh-background, #opencode-zh-glass, #opencode-zh-atmosphere { opacity: 0 !important; mix-blend-mode: normal !important; backdrop-filter: none !important; -webkit-backdrop-filter: none !important; } }",
        "@media (prefers-reduced-transparency: reduce) { #opencode-zh-background { opacity: calc(var(--skin-background-opacity) * 0.5) !important; } #opencode-zh-glass { backdrop-filter: none !important; -webkit-backdrop-filter: none !important; background: rgb(14 26 36 / 72%) !important; } #opencode-zh-atmosphere { opacity: calc(var(--skin-atmosphere-opacity) * 0.4) !important; } }",
      ].join("\\n");
    }

    function scheduleApply() {
      if (routeTimer) clearTimeout(routeTimer);
      routeTimer = setTimeout(applyVisuals, 60);
    }

    function cleanupVisuals() {
      if (routeTimer) clearTimeout(routeTimer);
      if (pageObserver) pageObserver.disconnect();
      [visualStyle, background, glass, atmosphere].forEach(function(node) { if (node && node.parentNode) node.parentNode.removeChild(node); });
      document.documentElement.removeAttribute("data-opencode-zh-page");
      // Restore html/body backgrounds
      document.documentElement.style.removeProperty("background-color");
      if (document.body) document.body.style.removeProperty("background-color");
      history.pushState = originalPush;
      history.replaceState = originalReplace;
      delete window[VISUAL_MARKER];
    }

    function mount() {
      background = element("opencode-zh-background", "opencode-zh-visual-layer");
      glass = element("opencode-zh-glass", "opencode-zh-visual-layer");
      atmosphere = element("opencode-zh-atmosphere", "opencode-zh-visual-layer");
      applyVisuals();
      history.pushState = function() { var result = originalPush.apply(this, arguments); scheduleApply(); return result; };
      history.replaceState = function() { var result = originalReplace.apply(this, arguments); scheduleApply(); return result; };
      window.addEventListener("popstate", scheduleApply);
      pageObserver = new MutationObserver(scheduleApply);
      pageObserver.observe(document.documentElement, { childList: true, subtree: true, attributes: true, attributeFilter: ["data-theme", "class"] });
    }

    window[VISUAL_MARKER] = { cleanup: cleanupVisuals };
    if (document.body) mount(); else document.addEventListener("DOMContentLoaded", mount, { once: true });
    return cleanupVisuals;
  }

  visualCleanup = startVisualRuntime();

  console.log("[opencode-zh-theme] Theme injected: ${theme.name} (${theme.id})");
})();`
}

/**
 * Build a theme injection script from a theme file path.
 */
export function buildThemeScriptFromFile(themePath: string): string {
  const raw = readFileSync(themePath, "utf-8")
  const theme: DesktopTheme = prepareThemeAssets(JSON.parse(raw), path.dirname(path.resolve(themePath)))
  if (!theme.name || !theme.id || !theme.light || !theme.dark) {
    throw new Error("Invalid theme file: missing required fields (name, id, light, dark)")
  }
  return buildThemeInjectionScript(theme)
}

/**
 * Build a theme injection script from a DesktopTheme object directly.
 */
export function buildThemeScriptFromObject(theme: DesktopTheme): string {
  return buildThemeInjectionScript(theme)
}

/** Build a one-shot cleanup script for the currently injected theme. */
export function buildThemeCleanupScript(): string {
  return `(function () {
  var theme = window[${JSON.stringify(INJECTION_MARKER)}];
  if (theme && typeof theme.cleanup === "function") theme.cleanup();
  var visuals = window[${JSON.stringify(VISUAL_MARKER)}];
  if (visuals && typeof visuals.cleanup === "function") visuals.cleanup();
  ["opencode-zh-theme", "opencode-zh-visuals", "opencode-zh-background", "opencode-zh-glass", "opencode-zh-atmosphere"].forEach(function (id) {
    var node = document.getElementById(id);
    if (node && node.parentNode) node.parentNode.removeChild(node);
  });
  document.documentElement.removeAttribute("data-opencode-zh-page");
  document.documentElement.style.removeProperty("background-color");
  if (document.body) document.body.style.removeProperty("background-color");
  return true;
})()`
}

/**
 * Generate a quick CSS-only override (no mode switching) for a single mode.
 * Useful for one-shot injection without persistent mode detection.
 */
export function buildSingleModeCss(theme: DesktopTheme, mode: ThemeMode): string {
  const overrides = theme[mode].overrides ?? {}
  return buildCssBlock(overrides, theme[mode].v2Overrides ?? {})
}
