import { appendFileSync, mkdirSync } from "node:fs"
import { homedir } from "node:os"
import { dirname, join } from "node:path"

/**
 * The review log: one JSON line per review, so which model reaches a verdict,
 * how fast, and why it reached none can be read afterwards. Kept in the
 * plugin's own state directory, not OpenCode's. It holds the commands and
 * paths reviewed, which can carry passwords typed into a command; never the
 * prompt.
 */

/** Read on every write, so tests and users can move it with XDG_STATE_HOME. */
export function reviewLogPath(env: Record<string, string | undefined> = process.env): string {
  return join(env.XDG_STATE_HOME || join(homedir(), ".local", "state"), "opencode-guard", "reviews.jsonl")
}

/** Appends the entry; a log that cannot be written never stops a review. */
export function logReview(entry: Record<string, unknown>, path = reviewLogPath()): void {
  try {
    mkdirSync(dirname(path), { recursive: true })
    appendFileSync(path, `${JSON.stringify(entry)}\n`)
  } catch {}
}
