import { afterAll } from "bun:test"
import { mkdtempSync, realpathSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"

const made: string[] = []
// Preloaded (bunfig.toml), so this runs once after every test file.
afterAll(() => {
  for (const dir of made.splice(0)) rmSync(dir, { recursive: true, force: true })
})

/** A fresh, resolved temp directory, removed when the test run exits. */
export function tempDir(prefix: string): string {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), `guard-${prefix}-`)))
  made.push(dir)
  return dir
}

// The review log goes here, not into the user's own.
process.env.XDG_STATE_HOME = tempDir("state")
