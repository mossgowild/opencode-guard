import { resolve } from "node:path"
import type { Plugin } from "@opencode/plugin"
import { createPasses, escapeInput, escapeShell, type ShellCall, splitCommands } from "./escape.ts"
import { type GuardOptions, sandboxShell } from "./guard.ts"
import { type Denials, systemDenials } from "./denials.ts"
import { autoAllowsSandboxed, sandboxConfig, sandboxSection, wrapCommand } from "./sandbox.ts"
import { blocked, withViolations } from "./violations.ts"

/**
 * The sandbox module: runs OpenCode's shell commands in Claude Code's sandbox,
 * and adds two fields to the shell tool for a command the sandbox blocks. With
 * `unsandboxed: true` and an `explanation` the call always asks, as OpenCode's
 * shell asks, then the shell tool runs the command with a pass out of the
 * sandbox. Whatever answers that request (the user, or another module's hook)
 * is not this module's concern.
 */

export interface SandboxOptions {
  /** The session's own directory, the only writable workspace. */
  readonly workspace: string
  /** The `sandbox` section of the plugin's config, read on every use so edits apply without a reload. */
  readonly section: () => unknown
  /** What Seatbelt denied each sandboxed command; read from the system log by default. */
  readonly denials?: Denials
}

/**
 * The agent's explanation for each call asking to leave the sandbox, kept only
 * while this module's own request is out: the shell's own permission check,
 * later in the same call, carries the same call but is not this request.
 */
const explanations = new Map<string, string>()

/**
 * How long the end of a command that failed for lack of permission waits for
 * Seatbelt's log of what it denied: the log usually comes within 25 ms of the
 * exit, later on a busy machine.
 */
const LOG_WAIT_MS = 2_000
/** Output of a command refused something, which may be the sandbox. */
const REFUSED = /operation not permitted|permission denied/i

export async function setupSandbox(ctx: Plugin.Context, options: SandboxOptions) {
  const passes = createPasses()
  const config = () => sandboxConfig(sandboxSection(options.section()), options.workspace)
  /** False when the section cannot be read: such a command is refused anyway. */
  const autoAllow = () => {
    try {
      return autoAllowsSandboxed(sandboxSection(options.section()))
    } catch {
      return false
    }
  }
  const denials = options.denials ?? systemDenials()
  /**
   * The ids sandboxed commands were wrapped under, by command, oldest first.
   * The shell hook does not know the call; the call's end gets the same command
   * the shell hook did (after every `execute.before` hook), so it finds it here.
   */
  const ids = new Map<string, string[]>()
  const guard: GuardOptions = {
    passes,
    sandbox: config,
    wrap: wrapCommand,
    wrapped: (command, commandId) => {
      denials.watch(commandId)
      ids.set(command, [...(ids.get(command) ?? []), commandId])
    },
  }

  await ctx.shell.hook("create.before", (event) => sandboxShell(event, guard))
  // This module's own request always asks, whatever the rules say for `shell`,
  // and shows the agent's explanation above the command. OpenCode's own check
  // of a shell call goes ahead unless a rule denies it: the command runs
  // sandboxed, or carries a pass this module's request already granted. So
  // rules a client writes on the session (`*: ask`) cannot make every command
  // ask; only `autoAllowBashIfSandboxed: false` leaves it to the rules.
  await ctx.permission.hook("evaluate", (event) => {
    if (event.effect === "deny") return
    const explanation = event.source && explanations.get(event.source.id)
    if (explanation !== undefined) {
      event.message = explanation
      event.effect = "ask"
    } else if (event.action === "shell" && event.effect === "ask" && autoAllow()) {
      event.effect = "allow"
    }
  })
  // A shell call asking to leave the sandbox asks here, before OpenCode decodes
  // the input: the shell tool knows neither field.
  await ctx.tool.hook("execute.before", async (event) => {
    if (event.tool !== "shell" || typeof event.input !== "object" || event.input === null) return
    event.input = await escapeShell(event.input as ShellCall, {
      passes,
      // Asked as OpenCode's shell asks, with its own parts, so the prompt is
      // the one any command gets. The call's input goes in `metadata.input`,
      // as an MCP call's does, for whatever reviews the request.
      authorize: async (command, workdir, explanation) => {
        explanations.set(event.id, explanation)
        try {
          await ctx.permission.assert({
            sessionID: event.sessionID,
            agent: event.agent,
            action: "shell",
            resources: await splitCommands(command, {
              // The shell tool's own pick is not known before the call decodes; the user's shell stands in.
              shell: process.env.SHELL ?? "/bin/sh",
              cwd: resolve(options.workspace, workdir ?? "."),
              channel: ctx.app.channel,
            }),
            metadata: { input: { command, ...(workdir !== undefined && { workdir }), unsandboxed: true } },
            // No `save`: without it the prompt offers no "always allow", so every command asks.
            source: { type: "tool", messageID: event.messageID, id: event.id },
          })
        } finally {
          explanations.delete(event.id)
        }
      },
    })
  })
  // The call's end: what the sandbox blocked goes after the output, with how to
  // leave it. A command moved to the background has not ended; it is left out.
  // Seatbelt's log can trail the command's exit, so a command whose output
  // says it was refused something waits a little for it; others do not wait.
  // What goes after the output is only ever what the log recorded.
  await ctx.tool.hook("execute.after", async (event) => {
    const command = (event.input as { command?: unknown } | undefined)?.command
    if (event.tool !== "shell" || typeof command !== "string") return
    const queue = ids.get(command)
    const commandId = queue?.shift()
    if (queue?.length === 0) ids.delete(command)
    if (commandId === undefined) return
    try {
      if (event.status !== "completed") return
      const metadata = event.result.metadata as { status?: unknown; exit?: unknown } | undefined
      if (metadata?.status === "running") return
      let lines = blocked(denials.seen(commandId))
      const content = event.result.content
      const output = typeof content === "string" ? content : (content ?? []).map((part) => ("text" in part ? part.text : "")).join("\n")
      const refused = metadata?.exit !== 0 && REFUSED.test(output)
      for (let waited = 0; lines.length === 0 && refused && waited < LOG_WAIT_MS; waited += 50) {
        await new Promise((resolve) => setTimeout(resolve, 50))
        lines = blocked(denials.seen(commandId))
      }
      if (lines.length > 0) event.result = { ...event.result, content: withViolations(lines, event.result.content) }
    } finally {
      denials.release(commandId)
    }
  })
  await ctx.tool.transform((editor) => {
    editor.update("shell", (tool) => {
      const input = escapeInput(tool.input)
      if (input !== undefined) tool.input = input as typeof tool.input
    })
  })
  return {
    /** The paths the sandbox keeps unreadable; throws when its settings cannot be read. */
    unreadable: (): readonly string[] => config().filesystem.denyRead,
  }
}
