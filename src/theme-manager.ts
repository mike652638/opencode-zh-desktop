import { existsSync, mkdirSync, readdirSync, readFileSync, unlinkSync, writeFileSync } from "node:fs"
import os from "node:os"
import path from "node:path"

export type ThemeMode = "light" | "dark"

export interface VisualThemeConfig {
  backgroundImage?: string
  backgroundPosition?: string
  backgroundSize?: "cover" | "contain" | "auto"
  backgroundOpacity?: number
  overlayColor?: string
  glassOpacity?: number
  glassBlur?: number
  glassSaturation?: number
  atmosphere?: boolean
  atmosphereOpacity?: number
  animation?: boolean
}

export interface PageVisualConfig extends VisualThemeConfig {
  enabled?: boolean
}

export interface ThemeVariant {
  palette?: Record<string, string>
  seeds?: Record<string, string>
  overrides?: Record<string, string>
  v2Overrides?: Record<string, string>
  visuals?: VisualThemeConfig
}

export interface DesktopTheme {
  name: string
  id: string
  light: ThemeVariant
  dark: ThemeVariant
  pages?: Partial<Record<"home" | "session" | "settings" | "project" | "unknown", PageVisualConfig>>
}

export interface ContrastResult {
  mode: ThemeMode
  foreground: string
  background: string
  ratio: number
  aaNormal: boolean
  aaLarge: boolean
  aaaNormal: boolean
  aaaLarge: boolean
}

export interface ThemeDirectory {
  path: string
  kind: "user" | "project" | "legacy"
  exists: boolean
  themeFiles: string[]
}

const PRESETS: DesktopTheme[] = [
  {
    name: "海风蓝",
    id: "sea-breeze",
    light: {
      overrides: {
        "text-base": "#18324b", "text-strong": "#0e1d2e", "text-muted": "#4a6a82", "text-faint": "#7a9ab2",
        "background-base": "#f4f8fb", "background-weak": "#e8eef3", "background-strong": "#dce5ed", "background-stronger": "#cfd9e3",
        "surface-base": "#ffffff", "border-base": "#c8d8e5", "border-muted": "#dde6ee",
        "accent-base": "#1976d2",
      },
    },
    dark: {
      overrides: {
        "text-base": "#d7e8f5", "text-strong": "#eaf3fa", "text-muted": "#8aacc5", "text-faint": "#4a6a82",
        "background-base": "#0e1a24", "background-weak": "#12202e", "background-strong": "#1a2e3e", "background-stronger": "#213848",
        "surface-base": "#162735", "border-base": "#29465b", "border-muted": "#1e3545",
        "accent-base": "#55a9e8",
      },
    },
  },
  {
    name: "森林绿",
    id: "forest-green",
    light: {
      overrides: {
        "text-base": "#1d3528", "text-strong": "#0f2218", "text-muted": "#4d7a5a", "text-faint": "#7da888",
        "background-base": "#f3f8f2", "background-weak": "#e5ede4", "background-strong": "#d5e2d3", "background-stronger": "#c5d6c3",
        "surface-base": "#ffffff", "border-base": "#c5d8c4", "border-muted": "#dae8d9",
        "accent-base": "#3b7d4b",
      },
    },
    dark: {
      overrides: {
        "text-base": "#d9edda", "text-strong": "#eaf6eb", "text-muted": "#8cc49a", "text-faint": "#4d7a5a",
        "background-base": "#122018", "background-weak": "#182a20", "background-strong": "#223a2a", "background-stronger": "#2c4a34",
        "surface-base": "#1b3022", "border-base": "#345a3b", "border-muted": "#274530",
        "accent-base": "#77c47e",
      },
    },
  },
  {
    name: "夜行紫",
    id: "night-violet",
    light: {
      overrides: {
        "text-base": "#30213d", "text-strong": "#1e1228", "text-muted": "#6a5080", "text-faint": "#9a80b0",
        "background-base": "#faf7fc", "background-weak": "#f0eaf5", "background-strong": "#e5dced", "background-stronger": "#dad0e4",
        "surface-base": "#ffffff", "border-base": "#decfe7", "border-muted": "#ece2f1",
        "accent-base": "#8b5fbf",
      },
    },
    dark: {
      overrides: {
        "text-base": "#eee2f5", "text-strong": "#f5eff9", "text-muted": "#b89ecc", "text-faint": "#6a5080",
        "background-base": "#1c1424", "background-weak": "#241a2e", "background-strong": "#302440", "background-stronger": "#3c2e50",
        "surface-base": "#291d33", "border-base": "#4a3459", "border-muted": "#3a2848",
        "accent-base": "#c38de5",
      },
    },
  },
]

export function createThemeJson(input: Partial<DesktopTheme> & Pick<DesktopTheme, "name" | "id">): DesktopTheme {
  return {
    name: input.name,
    id: input.id,
    light: input.light ?? { overrides: {} },
    dark: input.dark ?? { overrides: {} },
  }
}

export function validateTheme(value: unknown): DesktopTheme {
  if (!value || typeof value !== "object") throw new Error("主题必须是 JSON 对象")
  const theme = value as Partial<DesktopTheme>
  if (typeof theme.name !== "string" || !theme.name.trim()) throw new Error("主题缺少 name")
  if (typeof theme.id !== "string" || !/^[a-z0-9][a-z0-9-]*$/.test(theme.id)) throw new Error("主题 id 只能包含小写字母、数字和连字符")
  for (const mode of ["light", "dark"] as const) {
    if (!theme[mode] || typeof theme[mode] !== "object") throw new Error(`主题缺少 ${mode} 配色`)
  }
  return {
    ...createThemeJson({ name: theme.name, id: theme.id, light: theme.light, dark: theme.dark }),
    pages: theme.pages,
  }
}

export function serializeTheme(theme: DesktopTheme): string {
  return JSON.stringify(validateTheme(theme), null, 2) + "\n"
}

export function getPresetThemes(): DesktopTheme[] {
  return PRESETS.map((theme) => structuredClone(theme))
}

export function loadTheme(filePath: string): DesktopTheme {
  return validateTheme(JSON.parse(readFileSync(filePath, "utf8")))
}

export function saveTheme(filePath: string, theme: DesktopTheme): void {
  mkdirSync(path.dirname(filePath), { recursive: true })
  writeFileSync(filePath, serializeTheme(theme), "utf8")
}

export function detectThemeDirectories(projectPath = process.cwd()): ThemeDirectory[] {
  const home = os.homedir()
  const config = process.env.XDG_CONFIG_HOME || path.join(home, ".config")
  const candidates = [
    { path: path.join(config, "opencode", "desktop-themes"), kind: "user" as const },
    { path: path.join(config, "opencode", "themes"), kind: "legacy" as const },
    { path: path.join(projectPath, ".opencode", "themes"), kind: "project" as const },
  ]
  return candidates.map(({ path: directory, kind }) => ({
    path: directory,
    kind,
    exists: existsSync(directory),
    themeFiles: existsSync(directory)
      ? readdirSync(directory).filter((file) => file.toLowerCase().endsWith(".json"))
      : [],
  }))
}

export function restoreDefaultTheme(projectPath = process.cwd()): string[] {
  const restored: string[] = []
  for (const directory of detectThemeDirectories(projectPath)) {
    if (!directory.exists) continue
    for (const file of directory.themeFiles) {
      if (file !== "theme.json") continue
      const target = path.join(directory.path, file)
      const backup = `${target}.disabled`
      writeFileSync(backup, readFileSync(target))
      // Remove only the file managed by this tool; unrelated user themes remain untouched.
      unlinkSync(target)
      restored.push(backup)
    }
  }
  return restored
}

export function updateThemeColor(theme: DesktopTheme, mode: ThemeMode, token: string, color: string): DesktopTheme {
  if (!/^#(?:[\da-f]{3}|[\da-f]{6}|[\da-f]{8})$/i.test(color)) throw new Error("颜色必须是 #rgb、#rrggbb 或 #rrggbbaa")
  const variant = theme[mode]
  return {
    ...theme,
    [mode]: { ...variant, overrides: { ...(variant.overrides ?? {}), [token.replace(/^--/, "")]: color } },
  }
}

function parseHex(color: string): [number, number, number] | null {
  const value = color.trim().replace(/^#/, "")
  if (![3, 6].includes(value.length) || !/^[\da-f]+$/i.test(value)) return null
  const hex = value.length === 3 ? value.split("").map((part) => part + part).join("") : value
  return [0, 2, 4].map((index) => Number.parseInt(hex.slice(index, index + 2), 16) / 255) as [number, number, number]
}

function luminance(color: string): number | null {
  const rgb = parseHex(color)
  if (!rgb) return null
  const linear = rgb.map((channel) => channel <= 0.03928 ? channel / 12.92 : ((channel + 0.055) / 1.055) ** 2.4)
  return 0.2126 * linear[0] + 0.7152 * linear[1] + 0.0722 * linear[2]
}

export function contrastRatio(foreground: string, background: string): number | null {
  const foregroundLuminance = luminance(foreground)
  const backgroundLuminance = luminance(background)
  if (foregroundLuminance === null || backgroundLuminance === null) return null
  const lighter = Math.max(foregroundLuminance, backgroundLuminance)
  const darker = Math.min(foregroundLuminance, backgroundLuminance)
  return Number(((lighter + 0.05) / (darker + 0.05)).toFixed(2))
}

export function checkContrast(theme: DesktopTheme): ContrastResult[] {
  return (["light", "dark"] as const).map((mode) => {
    const overrides = theme[mode].overrides ?? {}
    const foreground = overrides["text-base"] ?? "#000000"
    const background = overrides["background-base"] ?? "#ffffff"
    const ratio = contrastRatio(foreground, background) ?? 0
    return { mode, foreground, background, ratio, aaNormal: ratio >= 4.5, aaLarge: ratio >= 3, aaaNormal: ratio >= 7, aaaLarge: ratio >= 4.5 }
  })
}
