import { homedir } from "node:os"
import { dirname, join, resolve } from "node:path"

/**
 * Paths inside a workspace that stay read-only: whoever writes them changes
 * what runs next (git hooks and config, a project plugin that could replace
 * this sandbox, project permission rules, Claude's configuration).
 * sandbox-runtime protects git hooks and config only under the process's own
 * directory, not under each session's.
 */
export function protectedPaths(workspace: string): string[] {
  return [
    join(workspace, ".git", "hooks"),
    join(workspace, ".git", "config"),
    join(workspace, ".opencode"),
    join(workspace, "opencode.json"),
    join(workspace, "opencode.jsonc"),
    ...claudeProtectedPaths(workspace),
  ]
}

/*
 * What Claude Code's own sandbox keeps read-only or unreadable on top of the
 * sandbox settings (as of Claude Code 2.1.292), so a command here cannot do
 * what the same command there cannot: Claude's configuration in the session's
 * directory and every directory above it up to home, Claude's state under
 * ~/.claude, and the credentials it keeps there.
 */
const CLAUDE_CONFIG = [
  ".claude/skills", ".claude/hooks", ".claude/commands", ".claude/agents", ".claude/workflows", ".claude/routines", ".claude/output-styles",
  ".claude/settings.json", ".claude/settings.local.json", ".claude/launch.json", ".claude/scheduled_tasks.json", ".claude/loop.md", ".mcp.json",
]
const CLAUDE_STATE = [
  "shell-snapshots", "session-env", "plugins", "rules", "projects", "backups", "local", "jobs", "daemon", "state", "cowork_plugins",
  "CLAUDE.md", "daemon.json", "policy-limits.json", "seed-admin", "bridge-spawn",
]
const CLAUDE_SECRETS = ["seed-admin", "bridge-spawn", "ide"]

function claudeProtectedPaths(workspace: string): string[] {
  const home = homedir()
  const levels: string[] = []
  for (let dir = resolve(workspace); ; dir = dirname(dir)) {
    levels.push(dir)
    if (dir === home || dirname(dir) === dir) break
  }
  return [...levels.flatMap((dir) => CLAUDE_CONFIG.map((path) => join(dir, path))), ...CLAUDE_STATE.map((path) => join(home, ".claude", path))]
}

/** Paths Claude Code's sandbox does not let commands read. */
export function claudeUnreadable(): string[] {
  return CLAUDE_SECRETS.map((path) => join(homedir(), ".claude", path))
}
