import { randomBytes } from "node:crypto"
import { fileURLToPath } from "node:url"
import type { SandboxRuntimeConfig } from "@anthropic-ai/sandbox-runtime"
import type { Passes } from "./escape.ts"

/**
 * The shell OpenCode spawns instead of the real one: a script shipped with the
 * plugin, so the plugin writes no file. OpenCode always runs `[shell, "-c",
 * command]`, and the command it was given is what its permission check, the
 * background task's title and the agent's notice show; so the command stays as
 * written and the per-command wrapping travels in the environment.
 */
export const WRAPPER = fileURLToPath(new URL("../../bin/sandboxed-shell", import.meta.url))

export function shellQuote(value: string): string {
  return `'${value.replaceAll("'", `'\\''`)}'`
}

/** Replaces a command that must not run unconfined. */
export function refuseCommand(reason: string): string {
  return `printf '%s\\n' ${shellQuote(`opencode-guard: ${reason}`)} >&2; exit 126`
}

export interface ShellEvent {
  command: string
  shell: string
  env: Record<string, string | undefined>
}

export interface GuardOptions {
  /** Commands the user allowed outside the sandbox. */
  readonly passes: Pick<Passes, "take">
  /** The session's sandbox config; throws when it cannot be built, so callers fail closed. */
  readonly sandbox: () => SandboxRuntimeConfig
  readonly wrap: (command: string, shell: string, config: SandboxRuntimeConfig, commandId: string) => Promise<string>
  /** Told the id each sandboxed command's denials are recorded under. */
  readonly wrapped?: (command: string, commandId: string) => void
}

/**
 * Swaps the shell for the sandbox wrapper rather than rewriting the command, so
 * session history keeps the command as written. Any failure refuses the command.
 * A command the user allowed outside the sandbox runs as allowed, unwrapped.
 */
export async function sandboxShell(event: ShellEvent, options: GuardOptions): Promise<void> {
  const allowed = options.passes.take(event.command)
  if (allowed !== undefined) {
    event.command = allowed
    return
  }
  try {
    const commandId = randomBytes(16).toString("base64url")
    event.env.OPENCODE_GUARD_COMMAND = await options.wrap(event.command, event.shell, options.sandbox(), commandId)
    event.shell = WRAPPER
    options.wrapped?.(event.command, commandId)
  } catch (error) {
    delete event.env.OPENCODE_GUARD_COMMAND
    event.command = refuseCommand(`could not sandbox the command, so it was not run (${(error as Error).message})`)
  }
}
