/**
 * Builds the injection script by reading the plain JS template file
 * (src/injection/script.js) at runtime and embedding the translation map.
 *
 * NOT using template literals for the script body — avoids all escape-sequence
 * issues with regex and string literals inside the injected code.
 */

import { readFileSync } from "node:fs"
import { fileURLToPath } from "node:url"
import { dirname, resolve } from "node:path"
import { translationMap } from "./translations/translations.js"

const __filename = fileURLToPath(import.meta.url)
const __dirname = dirname(__filename)

/** Build the injection script string from the standalone JS template + embedded translation map. */
export function buildInjectionScript(): string {
  const scriptPath = resolve(__dirname, "injection", "script.js")
  const template = readFileSync(scriptPath, "utf-8")
  const mapStr = JSON.stringify(translationMap)
  return template.replaceAll("__TRANSLATIONS__", mapStr)
}
