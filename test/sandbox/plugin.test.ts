import { describe, expect, test } from "bun:test"
import { Schema } from "effect"
import { setupSandbox } from "../../src/sandbox/index.ts"
import { harness } from "../harness.ts"

/** The sandbox module alone, its section empty: Claude's defaults and the session's directory. */
async function setup(options: Parameters<typeof harness>[0] & { denied?: (commandId: string) => readonly string[]; section?: () => unknown } = {}) {
  const h = harness(options)
  const { denied = () => [], section = () => ({}) } = options
  const denials = { watch: () => {}, seen: denied, release: () => {} }
  const sandbox = await setupSandbox(h.ctx as never, { workspace: h.workspace, section, denials })
  return { ...h, sandbox }
}

describe("sandbox module", () => {
  test("sandboxes the shell and hooks the permission check and shell calls, nothing else", async () => {
    const h = await setup()
    expect(h.hooks).toEqual(["shell.create.before", "permission.evaluate", "tool.execute.before", "tool.execute.after"])
  })

  test("adds `unsandboxed` and `explanation` to the shell tool's input, once, and leaves its description alone", async () => {
    const h = await setup()
    await setupSandbox(h.ctx as never, { workspace: h.workspace, section: () => ({}) })
    const input = h.shellInfo.input as Schema.Struct<Schema.Struct.Fields> & Schema.Codec<unknown>
    expect(Object.keys(input.fields)).toEqual(["command", "workdir", "background", "unsandboxed", "explanation"])
    expect(Schema.decodeUnknownSync(input)({ command: "ps", unsandboxed: true, explanation: "e" })).toEqual({ command: "ps", unsandboxed: true, explanation: "e" })
    expect(h.shellInfo.description).toBe("Run a command.")
  })

  test("an unsandboxed call always asks, as OpenCode's shell does, its explanation above the command, then runs unconfined as written, without the two fields", async () => {
    // Even where the rules would allow a shell command.
    const h = await setup({ effect: () => "allow" })
    const result = await h.shell("echo hi && echo there")
    expect(h.prompts).toEqual([
      {
        request: {
          sessionID: "s",
          agent: "build",
          action: "shell",
          resources: ["echo hi", "echo there"],
          metadata: { input: { command: "echo hi && echo there", unsandboxed: true } },
          source: { type: "tool", messageID: "m", id: "c1" },
        },
        message: "Say hi; read-only.",
        alwaysAllow: false,
      },
    ])
    expect(h.received[0]).toEqual({ command: expect.stringMatching(/^# opencode-guard unsandboxed .+\necho hi && echo there$/) })
    expect(result.content).toBe("hi\nthere")
    expect(h.ran).toEqual(["echo hi && echo there"])
    // The shell's own check for the same call is OpenCode's to decide.
    expect(h.decided.at(-1)).toMatchObject({ request: { action: "shell", save: ["*"] }, effect: "allow" })
    expect(h.decided.at(-1)).not.toHaveProperty("message")
  })

  test("a call without `unsandboxed: true` asks nothing and runs sandboxed, without the two fields", async () => {
    const h = await setup()
    expect((await h.shell("echo hi", "e", { unsandboxed: false, timeout: 5 })).content).toBe("(sandboxed)")
    expect(h.received[0]).toEqual({ command: "echo hi", timeout: 5 })
    expect(h.prompts).toEqual([])
  })

  test("the shell's own check goes ahead where the rules would ask, unless autoAllowBashIfSandboxed is false; a rule denying it still denies", async () => {
    const h = await setup({ shellEffect: "ask" })
    expect((await h.shell("echo hi", "e", { unsandboxed: false })).content).toBe("(sandboxed)")
    expect(h.prompts).toEqual([])
    expect(h.decided.at(-1)).toMatchObject({ request: { action: "shell" }, effect: "allow" })

    const off = await setup({ shellEffect: "ask", section: () => ({ autoAllowBashIfSandboxed: false }) })
    await off.shell("echo hi", "e", { unsandboxed: false })
    expect(off.prompts).toEqual([{ request: expect.objectContaining({ action: "shell", resources: ["echo hi"] }), alwaysAllow: true }])

    const denied = await setup({ shellEffect: "deny" })
    await expect(denied.shell("echo hi", "e", { unsandboxed: false })).rejects.toThrow("Denied by a rule.")
  })

  test("a command let out of the sandbox is asked once, for leaving; the shell's own check does not ask again", async () => {
    const h = await setup({ shellEffect: "ask" })
    expect((await h.shell("echo hi")).content).toBe("hi")
    expect(h.prompts).toHaveLength(1)
    expect(h.prompts[0]!.request.metadata).toEqual({ input: { command: "echo hi", unsandboxed: true } })
  })

  test("a rule denying the command still denies it", async () => {
    const h = await setup({ effect: () => "deny" })
    await expect(h.shell("echo hi")).rejects.toThrow("Denied by a rule.")
    expect(h.prompts).toEqual([])
    expect(h.ran).toEqual([])
  })

  test("without an explanation the user is not asked and nothing runs; the agent is told why", async () => {
    const h = await setup()
    await expect(h.shell("ls", "  ")).rejects.toThrow("Explain what the command is for")
    expect(h.prompts).toEqual([])
    expect(h.ran).toEqual([])
  })

  test("a declined call does not run: declined without a word, OpenCode's error ends the step; with a word, it goes back to the agent", async () => {
    for (const [answer, said] of [
      ["reject", { _tag: "Permission.DeclinedError" }],
      [{ feedback: "Not here." }, { message: "Not here." }],
    ] as const) {
      const h = await setup({ answer })
      await expect(h.shell("echo hi")).rejects.toMatchObject(said)
      expect(h.received).toEqual([])
      expect(h.ran).toEqual([])
    }
  })

  test("after a sandboxed command, puts what the sandbox blocked and how to leave it after the output, its own command's only", async () => {
    const asked: string[] = []
    const h = await setup({
      denied: (commandId) => {
        asked.push(commandId)
        return ["sh(1) deny(1) sysctl-read kern.iossupportversion", "touch(2) deny(1) file-write-create /Users/x/a"]
      },
    })
    const result = await h.shell("touch /Users/x/a", "e", { unsandboxed: false })
    expect(result.content).toBe(
      "(sandboxed)\n\n<sandbox_violations>\ntouch(2) deny(1) file-write-create /Users/x/a\n</sandbox_violations>\nThe sandbox blocked what is listed above. If that is why the command failed and it has to run outside the sandbox, run it again with `unsandboxed: true` and an explanation; the user is asked first. If what was blocked has nothing to do with the task, tell the user instead of retrying.",
    )
    expect(asked).toHaveLength(1)
  })

  test("a command refused something waits a little for denials logged after it ended; another failed one does not", async () => {
    let calls = 0
    const h = await setup({ denied: () => (++calls < 3 ? [] : ["touch(2) deny(1) file-write-create /Users/x/a"]) })
    const event = { tool: "shell", id: "c9", input: { command: "touch /Users/x/a" }, status: "completed", result: { content: "touch: /Users/x/a: Operation not permitted", metadata: { exit: 1 } } }
    await h.run("shell.create.before", { command: "touch /Users/x/a", cwd: undefined, shell: "/bin/sh", env: {} })
    await h.run("tool.execute.after", event)
    expect(calls).toBe(3)
    expect(event.result.content).toContain("<sandbox_violations>\ntouch(2) deny(1) file-write-create /Users/x/a")
    calls = 0
    const other = { tool: "shell", id: "c10", input: { command: "grep x y" }, status: "completed", result: { content: "", metadata: { exit: 1 } } }
    await h.run("shell.create.before", { command: "grep x y", cwd: undefined, shell: "/bin/sh", env: {} })
    await h.run("tool.execute.after", other)
    expect(calls).toBe(1)
    expect(other.result.content).toBe("")
  })

  test("leaves the output alone when the sandbox blocked nothing that matters, or the command ran unconfined", async () => {
    const h = await setup({ denied: () => ["sh(1) deny(1) sysctl-read kern.iossupportversion", "curl(1) deny(1) system-info vfs.disk-space"] })
    expect((await h.shell("echo hi", "e", { unsandboxed: false })).content).toBe("(sandboxed)")
    expect((await h.shell("echo hi")).content).toBe("hi")
  })

  test("tells which paths it keeps unreadable", async () => {
    const h = await setup()
    expect(h.sandbox.unreadable()).toContain(`${process.env.HOME}/.claude/ide`)
  })
})
