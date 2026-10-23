import { readFileSync } from "node:fs"
import { homedir } from "node:os"
import { join } from "node:path"

/**
 * The plugin's settings, next to OpenCode's own: one section for each module,
 * `sandbox` and `autoReview`. It is outside every writable root, so sandboxed
 * commands cannot change them.
 */
export const CONFIG_PATH = join(homedir(), ".config", "opencode", "opencode-guard.json")

/** The whole file; throws when it is missing or not an object, so callers fail closed. */
export function readConfigFile(path = CONFIG_PATH): Record<string, unknown> {
  const raw: unknown = JSON.parse(readFileSync(path, "utf8"))
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) throw new Error(`${path}: expected an object`)
  return raw as Record<string, unknown>
}
