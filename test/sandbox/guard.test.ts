import { describe, expect, test } from "bun:test"
import { mkdirSync, readFileSync, statSync } from "node:fs"
import { join } from "node:path"
import type { SandboxRuntimeConfig } from "@anthropic-ai/sandbox-runtime"
import { createPasses } from "../../src/sandbox/escape.ts"
import { type GuardOptions, refuseCommand, sandboxShell, shellQuote, WRAPPER } from "../../src/sandbox/guard.ts"
import { tempDir } from "../tmp.ts"

const config = (allowWrite: string[]) =>
  ({ network: { allowedDomains: [], deniedDomains: [] }, filesystem: { allowRead: [], denyRead: [], allowWrite, denyWrite: [] } }) as SandboxRuntimeConfig
const broken = () => {
  throw new Error("bad config")
}

function setup() {
  const base = tempDir("base")
  const workspace = join(base, "ws")
  const cache = join(base, "cache")
  mkdirSync(workspace)
  mkdirSync(cache)
  const passes = createPasses()
  const options: GuardOptions = {
    passes,
    sandbox: () => config([cache, workspace]),
    wrap: async (command, shell) => `wrapped(${shell}: ${command})`,
  }
  const event = (command: string) => ({ command, cwd: workspace, shell: "/bin/zsh", env: {} as Record<string, string | undefined> })
  return { base, workspace, cache, passes, options, event }
}

describe("sandboxShell", () => {
  test("swaps the shell for the wrapper and passes the wrapped command in the environment, telling the id its denials go under", async () => {
    const { options, event } = setup()
    const shell = event("echo hi")
    const ids: string[][] = []
    const given: string[] = []
    await sandboxShell(shell, { ...options, wrap: async (command, sh, _config, commandId) => (given.push(commandId), `wrapped(${sh}: ${command})`), wrapped: (command, commandId) => ids.push([command, commandId]) })
    expect(ids).toEqual([["echo hi", given[0]!]])
    expect(shell.command).toBe("echo hi")
    expect(shell.shell).toBe(WRAPPER)
    expect(shell.env.OPENCODE_GUARD_COMMAND).toBe("wrapped(/bin/zsh: echo hi)")
  })

  test("runs a command the user allowed as written, with the user's shell, once", async () => {
    const { options, passes, event } = setup()
    const command = passes.grant("ps -ax")
    const allowed = event(command)
    await sandboxShell(allowed, options)
    expect(allowed).toEqual(event("ps -ax"))
    const again = event(command)
    await sandboxShell(again, options)
    expect(again.shell).toBe(WRAPPER)
    expect(again.env.OPENCODE_GUARD_COMMAND).toBe(`wrapped(/bin/zsh: ${command})`)
  })

  test("refuses the command when the sandbox cannot be configured or wrapped", async () => {
    const { options, event } = setup()
    for (const failing of [{ ...options, sandbox: broken }, { ...options, wrap: async () => broken() }]) {
      const shell = event("echo hi")
      await sandboxShell(shell, failing)
      expect(shell.shell).toBe("/bin/zsh")
      expect(shell.env.OPENCODE_GUARD_COMMAND).toBeUndefined()
      expect(shell.command).toContain("could not sandbox the command, so it was not run (bad config)")
      expect(shell.command).toContain("exit 126")
    }
  })
})

describe("wrap", () => {
  test("quotes single quotes for the shell", () => {
    expect(shellQuote("it's")).toBe(`'it'\\''s'`)
  })

  test("the wrapper is an executable script shipped with the plugin", () => {
    expect(statSync(WRAPPER).mode & 0o777).toBe(0o755)
    expect(readFileSync(WRAPPER, "utf8")).toContain('exec /bin/sh -c "$wrapped"')
  })

  test("wrapper runs the wrapped command, not its arguments, and hides it from the command", async () => {
    const wrapper = WRAPPER
    const proc = Bun.spawn([wrapper, "-c", "echo original"], {
      env: { OPENCODE_GUARD_COMMAND: 'echo "wrapped:${OPENCODE_GUARD_COMMAND:-unset}"' },
      stdout: "pipe",
    })
    expect(await proc.exited).toBe(0)
    expect(await new Response(proc.stdout).text()).toBe("wrapped:unset\n")
  })

  test("wrapper refuses to run without a wrapped command", async () => {
    const wrapper = WRAPPER
    const proc = Bun.spawn([wrapper, "-c", "echo should-not-run"], { env: {}, stdout: "pipe", stderr: "pipe" })
    expect(await proc.exited).toBe(126)
    expect(await new Response(proc.stdout).text()).toBe("")
  })

  test("refusal exits non-zero with a message", async () => {
    const proc = Bun.spawn(["/bin/sh", "-c", refuseCommand("no sandbox")], { stderr: "pipe" })
    expect(await proc.exited).toBe(126)
    expect(await new Response(proc.stderr).text()).toBe("opencode-guard: no sandbox\n")
  })
})
