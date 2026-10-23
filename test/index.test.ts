import { afterEach, beforeEach, describe, expect, spyOn, test } from "bun:test"
import * as i18n from "../src/autoreview/i18n.ts"
import * as config from "../src/config.ts"
import plugin from "../src/index.ts"
import { harness } from "./harness.ts"

const AUTO = { enabled: true, model: "p/m", policy: ["Allow read-only actions."] }

let autoReview: unknown
const restore: { mockRestore: () => void }[] = []
beforeEach(() => {
  autoReview = AUTO
  restore.push(
    spyOn(config, "readConfigFile").mockImplementation(() => ({ sandbox: {}, ...(autoReview !== undefined && { autoReview }) })),
    spyOn(i18n, "detectLanguage").mockImplementation(() => "en"),
  )
})
afterEach(() => {
  for (const spy of restore.splice(0)) spy.mockRestore()
})

describe("the two modules wired together", () => {
  test("the sandbox's hooks come first", async () => {
    const h = harness()
    await plugin.setup(h.ctx as never)
    expect(h.hooks).toEqual(["shell.create.before", "permission.evaluate", "tool.execute.before", "tool.execute.after", "permission.evaluate", "tool.execute.after"])
  })

  test("a command auto review lets out of the sandbox runs unconfined, saying so; the reviewer sees the call asking for it", async () => {
    const h = harness({ reply: async () => "<block>no</block>" })
    await plugin.setup(h.ctx as never)
    expect((await h.shell("echo hi")).content).toBe("Auto-approved\nhi")
    expect(h.prompts).toEqual([])
    expect(h.reviews).toHaveLength(1)
    expect(h.reviews[0]!.prompt).toContain(`{"user":"yes, go ahead"}\n{"shell":{"command":"echo hi","unsandboxed":true}}\n\n# Looking at files`)
    expect(h.reviews[0]!.prompt).not.toContain("Say hi; read-only.")
  })

  test("a sandboxed command goes ahead unreviewed even where the session's rules ask for every shell command", async () => {
    const h = harness({ shellEffect: "ask" })
    await plugin.setup(h.ctx as never)
    expect((await h.shell("echo hi", "e", { unsandboxed: false })).content).toBe("(sandboxed)")
    expect(h.reviews).toEqual([])
    expect(h.prompts).toEqual([])
    // Let out of the sandbox, it was reviewed once, for leaving; the shell's own check does not ask again.
    const out = harness({ shellEffect: "ask", reply: async () => "<block>no</block>" })
    await plugin.setup(out.ctx as never)
    expect((await out.shell("echo hi")).content).toBe("Auto-approved\nhi")
    expect(out.reviews).toHaveLength(1)
    expect(out.prompts).toEqual([])
  })

  test("one it does not, the user answers on one prompt: the agent's explanation, the reason, no \"always allow\"", async () => {
    const h = harness({ reply: async () => "<block>yes</block><reason>writes the desktop</reason>" })
    await plugin.setup(h.ctx as never)
    expect((await h.shell("echo hi")).content).toBe("hi")
    expect(h.prompts).toHaveLength(1)
    expect(h.prompts[0]).toMatchObject({ request: { action: "shell", resources: ["echo hi"] }, message: "Say hi; read-only.\n⚠ Auto review: writes the desktop", alwaysAllow: false })
    expect(h.ran).toEqual(["echo hi"])
  })

  test("the user declining it leaves the command unrun: without a word, with OpenCode's own error; with one, saying it", async () => {
    for (const [answer, said] of [
      ["reject", { _tag: "Permission.DeclinedError" }],
      [{ feedback: "Not here." }, { message: "Not here." }],
    ] as const) {
      const h = harness({ reply: async () => "<block>yes</block>", answer })
      await plugin.setup(h.ctx as never)
      await expect(h.shell("echo hi")).rejects.toMatchObject(said)
      expect(h.ran).toEqual([])
    }
  })

  test("the reviewer reads nothing the sandbox keeps unreadable", async () => {
    const replies = ['<read path="~/.claude/ide/x"/>', "<block>no</block>"]
    const h = harness({ reply: async () => replies.shift()! })
    await plugin.setup(h.ctx as never)
    await h.shell("echo hi")
    expect(h.reviews[1]!.prompt).toContain('<result read="~/.claude/ide/x">\nNot read: this path is kept unreadable.\n</result>')
  })
})
