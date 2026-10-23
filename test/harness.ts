import { resolve } from "node:path"
import { Schema } from "effect"
import { tempDir } from "./tmp.ts"

/**
 * A stand-in for OpenCode, enough to run a module's real setup: hooks run in
 * the order they were registered, as OpenCode runs them; a permission request
 * gets an effect (by default "ask"), goes through every evaluate hook, then
 * prompts unless it ended allowed or denied; a prompt is answered with
 * `answer`. Shell calls run as OpenCode runs them: the hooks before, the
 * shell's hook, its own permission check (allowed), the command, the hooks
 * after.
 */

export type Request = {
  sessionID: string
  agent?: string
  action: string
  resources: string[]
  save?: string[]
  metadata?: Record<string, unknown>
  source?: { type?: string; messageID?: string; id: string }
}
export type Evaluation = Request & { effect: string; message?: string }
type Hook = (event: any) => Promise<void> | void
export type Answer = "once" | "reject" | { readonly feedback: string }

/** OpenCode's shell input, as an Effect struct. */
export const SHELL_INPUT = Schema.Struct({
  command: Schema.String,
  workdir: Schema.optional(Schema.String).annotate({ description: "Working directory." }),
  background: Schema.optional(Schema.Boolean).annotate({ description: "Run in the background." }),
})

export const toolError = (message: string) => Object.assign(new Error(message), { _tag: "Tool.Error" })
/** What OpenCode's permission check rejects with when the user declines without a word: it ends the agent's step. */
export const declined = () => Object.assign(new Error(""), { _tag: "Permission.DeclinedError" })

export function harness(options: { reply?: () => Promise<string>; answer?: Answer; effect?: (request: Request) => string; shellEffect?: string } = {}) {
  const workspace = tempDir("plugin")
  const handlers: Record<string, Hook[]> = {}
  const hooks: string[] = []
  /** Prompts shown, with the message on them and whether they offer "always allow". */
  const prompts: { request: Request; message?: string; alwaysAllow: boolean }[] = []
  /** Every request's final effect, in order. */
  const decided: { request: Request; effect: string; message?: string }[] = []
  const reviews: { prompt: string; model: unknown }[] = []
  const received: unknown[] = []
  const ran: string[] = []
  let call: { id: string; input: Record<string, unknown> } | undefined
  let calls = 0
  const shellInfo: { input: unknown; description: string } = { input: SHELL_INPUT, description: "Run a command." }

  const run = async (name: string, event: unknown) => {
    for (const handler of handlers[name] ?? []) await handler(event)
  }
  /** A permission request as OpenCode handles it; resolves allowed, rejects as OpenCode's assert does. */
  async function request(input: Request, effect = options.effect?.(input) ?? "ask"): Promise<void> {
    const event: Evaluation = { ...input, effect }
    await run("permission.evaluate", event)
    decided.push({ request: input, effect: event.effect, ...(event.message !== undefined && { message: event.message }) })
    if (event.effect === "deny") throw toolError(event.message ?? "Denied by a rule.")
    if (event.effect === "allow") return
    prompts.push({ request: input, ...(event.message !== undefined && { message: event.message }), alwaysAllow: (input.save ?? []).length > 0 })
    const answer = options.answer ?? "once"
    if (answer === "once") return
    throw answer === "reject" ? declined() : toolError(answer.feedback)
  }
  const hook = (domain: string) => async (name: string, handler: Hook) => {
    hooks.push(`${domain}.${name}`)
    ;(handlers[`${domain}.${name}`] ??= []).push(handler)
  }
  const ctx = {
    location: { directory: workspace, project: { directory: workspace } },
    app: { name: "opencode", version: "2.1.2", channel: "latest" },
    shell: { hook: hook("shell") },
    permission: { hook: hook("permission"), assert: (input: Request) => request(input) },
    session: {
      context: async () => [
        { type: "assistant", id: "m1", content: [{ type: "text", text: "Shall I check the PID?" }] },
        { type: "user", id: "m2", text: "yes, go ahead" },
        { type: "assistant", id: "m3", content: [{ type: "tool", id: call?.id, name: "shell", state: { status: "running", input: call?.input } }] },
      ],
    },
    generate: {
      text: async ({ prompt, model }: { prompt: string; model: unknown }) => {
        reviews.push({ prompt, model })
        return { text: await (options.reply ?? (async () => "<block>yes</block>"))() }
      },
    },
    tool: {
      hook: hook("tool"),
      transform: async (fn: (editor: unknown) => void) => fn({ update: (id: string, change: (tool: unknown) => void) => id === "shell" && change(shellInfo) }),
    },
  }

  /** OpenCode's shell tool for one call: the shell hook, its own permission check, the command. */
  async function shellTool(input: { command: string; workdir?: string }, id: string) {
    const event = { command: input.command, cwd: input.workdir, shell: "/bin/sh", env: {} as Record<string, string> }
    await run("shell.create.before", event)
    // OpenCode's own check for the same call, which the user's rules allow unless `shellEffect` says otherwise.
    await request({ sessionID: "s", agent: "build", action: "shell", resources: [event.command], save: ["*"], source: { type: "tool", messageID: "m", id } }, options.shellEffect ?? "allow")
    if (event.shell !== "/bin/sh") return { content: "(sandboxed)" }
    ran.push(event.command)
    const out = Bun.spawnSync(["/bin/sh", "-c", event.command], { cwd: resolve(workspace, event.cwd ?? ".") })
    return { content: out.stdout.toString().trim(), metadata: { status: "completed" } }
  }
  /** A shell call as the agent makes it; unsandboxed unless `extra` says otherwise. */
  async function shell(command: string, explanation = "Say hi; read-only.", extra: Record<string, unknown> = {}) {
    call = { id: `c${++calls}`, input: { command, unsandboxed: true, explanation, ...extra } }
    const before = { tool: "shell", sessionID: "s", agent: "build", messageID: "m", id: call.id, input: { ...call.input } }
    await run("tool.execute.before", before)
    received.push(before.input)
    const after = { tool: "shell", id: call.id, input: before.input, status: "completed", result: await shellTool(before.input as { command: string }, call.id) }
    await run("tool.execute.after", after)
    return after.result
  }
  return { ctx, workspace, hooks, handlers, prompts, decided, reviews, received, ran, shellInfo, request, shell, shellTool, run }
}
