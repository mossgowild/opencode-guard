import { randomUUID } from "node:crypto"

// In the fields' own descriptions: OpenCode sets the shell tool's description anew for each request.
const UNSANDBOXED = [
  "Every command runs in a sandbox: it can write only the workspace (this session's directory) and the directories the user's sandbox settings allow; reads and network access follow those settings too.",
  "Set this to true to run the command outside the sandbox, only after a command just failed because the sandbox blocked it and it really has to run unconfined.",
  "Signs that the sandbox blocked it: a `<sandbox_violations>` block after the output, which lists what was denied; `Operation not permitted` on a file or network operation; a setuid program such as `ps` refusing to run; a connection the settings block. Commands also fail for reasons that have nothing to do with the sandbox (missing files, wrong arguments, network trouble); those are not a reason to leave it.",
  "When the sandbox caused the failure, run the command again with this set, rather than asking in prose first or working around the sandbox: the call itself asks the user before it runs.",
  "A block on a credential, a file or a host the task does not involve is the sandbox doing its job: tell the user instead of retrying.",
].join(" ")

const EXPLANATION =
  "Required with `unsandboxed`, and shown to the user above the command: write it so the user can decide from it alone. One or two plain sentences in the user's language, not a list or labeled fields, that cover all three: what the command is for; why it has to run outside the sandbox; and what it changes or reaches there (the files and directories it writes or deletes, the hosts it connects to, the processes or services it starts or stops), or, when it changes nothing, that it is read-only."

type Field = { annotate(annotations: { description: string }): Field }
type Struct = { fields?: Record<string, Field>; mapFields?: (map: (fields: Record<string, Field>) => Record<string, Field>) => unknown }

/**
 * OpenCode's shell input with `unsandboxed` and `explanation` added, so the
 * agent sees them; undefined when the input is not the Effect struct this
 * expects. Each new field is an existing one described anew, so it comes from
 * the same Effect as OpenCode's own.
 */
export function escapeInput(input: unknown): unknown {
  const struct = input as Struct | undefined
  const { background, workdir } = struct?.fields ?? {}
  if (typeof struct?.mapFields !== "function" || typeof background?.annotate !== "function" || typeof workdir?.annotate !== "function") return undefined
  return struct.mapFields((fields) => ({
    ...fields,
    unsandboxed: background.annotate({ description: UNSANDBOXED }),
    explanation: workdir.annotate({ description: EXPLANATION }),
  }))
}

const MARK = "# opencode-guard unsandboxed "
const TOKENS = Symbol.for("opencode-guard.passes")

/**
 * Commands the user allowed outside the sandbox. OpenCode's shell hook sees only
 * the command, not the call it came from, so each allowed command carries a
 * one-time random token on a comment line of its own. The token alone is the
 * pass: it is good once and only that call's input ever carries it, while hooks
 * that come later in the same call may rewrite the command below the line (RTK
 * turns `ls` into `rtk ls`). A hook that misses the line leaves a comment in a
 * command that runs sandboxed. The tokens are the process's, not this
 * instance's: OpenCode reloads the plugin while calls are in flight, and a pass
 * the old instance granted is taken by the new one's shell hook.
 */
export function createPasses() {
  const shared = globalThis as { [TOKENS]?: Set<string> }
  const tokens = (shared[TOKENS] ??= new Set<string>())
  return {
    /** The command to give the shell, allowed to run unconfined once. */
    grant(command: string): string {
      const token = randomUUID()
      tokens.add(token)
      return `${MARK}${token}\n${command}`
    },
    /** The command below the line, when the line carries an unused pass; the pass is used up. */
    take(command: string): string | undefined {
      const end = command.indexOf("\n")
      if (!command.startsWith(MARK) || end === -1) return
      return tokens.delete(command.slice(MARK.length, end)) ? command.slice(end + 1) : undefined
    },
  }
}

export type Passes = ReturnType<typeof createPasses>

/** A shell call's input as the agent sent it. */
export interface ShellCall {
  readonly command?: unknown
  readonly workdir?: unknown
  readonly unsandboxed?: unknown
  readonly explanation?: unknown
  readonly [key: string]: unknown
}

export interface EscapeOptions {
  readonly passes: Passes
  /**
   * OpenCode's permission check for this call, which the user's rules make a prompt. Resolves when
   * allowed; a denial rejects with a `Tool.Error` whose message goes back to the agent; the user
   * declining the prompt rejects with anything else.
   */
  readonly authorize: (command: string, workdir: string | undefined, explanation: string) => Promise<void>
}

/** True for the error a denied permission check rejects with: its message is for the agent. */
function isToolError(error: unknown): error is Error {
  return typeof error === "object" && error !== null && (error as { _tag?: unknown })._tag === "Tool.Error"
}

/**
 * The shell call's input for OpenCode's shell tool, which knows neither field:
 * without `unsandboxed: true` the two fields go and the command runs sandboxed;
 * with it, once the user allows it, the command carries a pass out of the
 * sandbox. Throws, and nothing runs, when the call cannot be asked about, is
 * denied or is declined: the message goes back to the agent, except that a
 * prompt declined without a word throws OpenCode's own error, which ends the
 * agent's step.
 */
export async function escapeShell(input: ShellCall, options: EscapeOptions): Promise<Record<string, unknown>> {
  const { unsandboxed, explanation, ...rest } = input
  if (unsandboxed !== true) return rest
  const command = typeof rest.command === "string" ? rest.command : ""
  const workdir = typeof rest.workdir === "string" ? rest.workdir : undefined
  const said = typeof explanation === "string" ? explanation.trim() : ""
  if (!command.trim()) throw new Error("No command to run.")
  if (!said) throw new Error("Explain what the command is for, why it has to run outside the sandbox, and what it changes there; the user decides from that.")
  try {
    await options.authorize(command, workdir, said)
  } catch (error) {
    // A denial, or the user declining with a word, goes back to the agent. Declined
    // without one, OpenCode's own error goes on as it is: it ends the agent's step.
    if (isToolError(error)) throw new Error(error.message)
    throw error
  }
  return { ...rest, command: options.passes.grant(command) }
}

/** How OpenCode picks its shell parser: the portable scanner for local and dev builds, tree-sitter otherwise. */
export interface SplitOptions {
  /** The shell the command is for: PowerShell parses as PowerShell, any other shell as bash. */
  readonly shell: string
  /** The directory the command runs in; OpenCode resolves the directories `cd` names from it. */
  readonly cwd: string
  /** OpenCode's channel, from the plugin context: `local` and `dev` builds use the portable scanner. */
  readonly channel: string
}

/**
 * A command's parts, as OpenCode's shell tool lists them before it asks: its
 * own parser, `ShellParse.scan` from `@opencode/core`, pinned to OpenCode's
 * version. Each command in the syntax tree is a part, with its redirections
 * and here-document body; `cd` and the like are not, and a command
 * substitution's command is one of its own. Where OpenCode would find no part
 * (only `cd` or `export`) or fail to parse, it would not ask, but leaving the
 * sandbox always asks: the whole command is the one part.
 */
export async function splitCommands(command: string, options: SplitOptions): Promise<string[]> {
  // Loaded on first use: it brings much of OpenCode's core with it (about 60 MB).
  const [{ ShellParse }, { Effect }] = await Promise.all([import("@opencode/core/shell/parse"), import("effect")])
  const portable = options.channel === "local" || options.channel === "dev"
  const parsed = await Effect.runPromise(ShellParse.scan(command, options.shell, options.cwd, { portable })).catch(() => undefined)
  const parts = parsed?.commands.map((part) => part.resource) ?? []
  return parts.length > 0 ? parts : [command.trim()]
}
