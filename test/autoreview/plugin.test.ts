import { afterEach, beforeEach, describe, expect, spyOn, test } from "bun:test"
import { mkdirSync, readFileSync, writeFileSync } from "node:fs"
import { join } from "node:path"
import { setupAutoReview, withFirstLine } from "../../src/autoreview/index.ts"
import * as i18n from "../../src/autoreview/i18n.ts"
import { reviewLogPath } from "../../src/autoreview/log.ts"
import * as review from "../../src/autoreview/review.ts"
import { type Evaluation, harness, type Request } from "../harness.ts"

const SECTION = { enabled: true, model: "p/m", policy: ["Allow read-only actions."] }

let language: i18n.Language = "en"
const restore: { mockRestore: () => void }[] = []
beforeEach(() => {
  language = "en"
  restore.push(spyOn(i18n, "detectLanguage").mockImplementation(() => language))
})
afterEach(() => {
  for (const spy of restore.splice(0)) spy.mockRestore()
})

/** The auto review module alone. */
async function setup(options: Parameters<typeof harness>[0] & { section?: () => unknown; unreadable?: () => readonly string[] } = {}) {
  const h = harness(options)
  await setupAutoReview(h.ctx as never, { workspace: h.workspace, section: options.section ?? (() => SECTION), ...(options.unreadable && { unreadable: options.unreadable }) })
  return h
}

/** A request OpenCode raised for a call, with the agent's explanation already on it. */
const edit = (id = "c1"): Request => ({
  sessionID: "s",
  agent: "build",
  action: "edit",
  resources: ["/Users/x/Desktop/a"],
  save: ["*"],
  metadata: { files: [{ file: "/Users/x/Desktop/a", patch: "+a" }] },
  source: { type: "tool", messageID: "m", id },
})

describe("auto review module", () => {
  test("hooks the permission check and the end of a call, nothing else", async () => {
    const h = await setup()
    expect(h.hooks).toEqual(["permission.evaluate", "tool.execute.after"])
  })

  test("leaves requests the rules allow or deny alone, unreviewed", async () => {
    const h = await setup()
    for (const effect of ["allow", "deny"]) {
      const event: Evaluation = { ...edit(), effect }
      await h.run("permission.evaluate", event)
      expect(event).toEqual({ ...edit(), effect })
    }
    expect(h.reviews).toEqual([])
  })

  test("lets through what the review allows, and says so above the call's output", async () => {
    const h = await setup({ reply: async () => "<block>no</block>" })
    await h.request(edit())
    expect(h.prompts).toEqual([])
    expect(h.decided).toEqual([{ request: edit(), effect: "allow" }])
    const after = { tool: "edit", id: "c1", status: "completed", result: { content: "Edited." } }
    await h.run("tool.execute.after", after)
    expect(after.result.content).toBe("Auto-approved\nEdited.")
    const again = { tool: "edit", id: "c1", status: "completed", result: { content: "Edited." } }
    await h.run("tool.execute.after", again)
    expect(again.result.content).toBe("Edited.")
  })

  test("asks the model with the user's rules, AGENTS.md and the transcript, the call's own input as the action when the request carries it", async () => {
    const h = await setup({ reply: async () => "<block>no</block>" })
    writeFileSync(join(h.workspace, "AGENTS.md"), "Commit when asked.")
    await h.request({ sessionID: "s", action: "github_create_issue", resources: ["*"], save: ["*"], metadata: { input: { title: "t" } } })
    const [review] = h.reviews
    expect(review!.model).toEqual({ providerID: "p", id: "m" })
    expect(review!.prompt).toContain(`<file path="${h.workspace}/AGENTS.md">\nCommit when asked.\n</file>`)
    expect(review!.prompt).toContain("# The user's rules\nAllow read-only actions.")
    expect(review!.prompt).toContain('{"user":"yes, go ahead"}\n{"github_create_issue":{"title":"t"}}\n\n# Looking at files')
  })

  test("asks the model's variant when the section sets one", async () => {
    const h = await setup({ reply: async () => "<block>no</block>", section: () => ({ ...SECTION, variant: "high" }) })
    await h.request(edit())
    expect(h.reviews[0]!.model).toEqual({ providerID: "p", id: "m", variant: "high" })
  })

  test("what the review does not let through, the user answers on a prompt of its own, without \"always allow\"", async () => {
    const h = await setup({ reply: async () => "<block>yes</block><reason>writes the desktop</reason>" })
    const original = { ...edit(), effect: "ask", message: "From the agent." }
    await h.run("permission.evaluate", original)
    expect(original.effect).toBe("allow")
    expect(h.prompts).toHaveLength(1)
    const [prompt] = h.prompts
    expect(prompt!.alwaysAllow).toBe(false)
    expect(prompt!.message).toBe("From the agent.\n⚠ Auto review: writes the desktop")
    const { save: _, ...rest } = edit()
    expect(prompt!.request).toEqual({ ...rest, metadata: { ...rest.metadata, "opencode-guard.stand-in": expect.any(String) } })
    // Its own prompt is not reviewed again.
    expect(h.reviews).toHaveLength(1)
  })

  test("the user declining its prompt with a word denies the request, and what they said goes back to the agent", async () => {
    const h = await setup({ answer: { feedback: "Not there." } })
    await expect(h.request(edit())).rejects.toThrow("Not there.")
    expect(h.decided.at(-1)).toMatchObject({ effect: "deny", message: "Not there." })
  })

  test("declining it without a word fails the request with OpenCode's own error, which ends the agent's step", async () => {
    const h = await setup({ answer: "reject" })
    await expect(h.request(edit())).rejects.toMatchObject({ _tag: "Permission.DeclinedError" })
    expect(h.prompts).toHaveLength(1)
  })

  test("asks on its own prompt when the model contradicts itself, answers something else, keeps looking or fails, and says which", async () => {
    for (const [reply, line] of [
      [async () => "<block>no</block> on second thought <block>yes</block>", "did not clearly allow it, and gave no reason"],
      [async () => "no", "its answer could not be read"],
      [async () => '<read path="a"/>', "still looking at files after 3 rounds"],
      [
        async () => {
          throw new Error("model down")
        },
        "the call failed (model down)",
      ],
    ] as const) {
      const h = await setup({ reply })
      await h.run("permission.evaluate", { ...edit(), effect: "ask", message: "From the agent." })
      expect(h.prompts).toHaveLength(1)
      expect(h.prompts[0]!.alwaysAllow).toBe(false)
      expect(h.prompts[0]!.message).toBe(`From the agent.\n⚠ Auto review: ${line}`)
    }
  })

  test("says so when the review reaches no verdict in time", async () => {
    restore.push(spyOn(review, "withTimeout").mockImplementation(async () => undefined))
    const h = await setup()
    await h.request(edit())
    expect(h.prompts[0]!.message).toBe("⚠ Auto review: no verdict within 60 seconds")
  })

  test("logs every review: what it reviewed, with which model, how long it took and how it ended", async () => {
    const replies = ['<list path="."/>', "<block>yes</block><reason>writes the desktop</reason>"]
    const h = await setup({ reply: async () => replies.shift()!, section: () => ({ ...SECTION, variant: "high" }) })
    await h.request(edit())
    const h2 = await setup({ reply: async () => "<block>no</block>" })
    await h2.request(edit("c2"))
    const lines = readFileSync(reviewLogPath(), "utf8").trim().split("\n").map((line) => JSON.parse(line))
    expect(lines.slice(-2)).toEqual([
      {
        time: expect.any(String),
        sessionID: "s",
        action: "edit",
        resources: "/Users/x/Desktop/a",
        model: "p/m",
        variant: "high",
        ms: expect.any(Number),
        rounds: 2,
        outcome: "block",
        reason: "writes the desktop",
        answer: "<block>yes</block><reason>writes the desktop</reason>",
      },
      { time: expect.any(String), sessionID: "s", action: "edit", resources: "/Users/x/Desktop/a", model: "p/m", ms: expect.any(Number), rounds: 1, outcome: "allow", answer: "<block>no</block>" },
    ])
  })

  test("with auto review off, leaves the request to OpenCode's own prompt", async () => {
    for (const section of [() => undefined, () => ({ ...SECTION, enabled: false })]) {
      const h = await setup({ section })
      await h.request(edit())
      expect(h.reviews).toEqual([])
      expect(h.prompts).toEqual([{ request: edit(), alwaysAllow: true }])
    }
  })

  test("with auto review on but unusable, asks on its own prompt without a review", async () => {
    for (const section of [() => ({ enabled: true, model: "bad" }), () => {
      throw new Error("no config")
    }]) {
      const h = await setup({ section })
      await h.request(edit())
      expect(h.reviews).toEqual([])
      expect(h.prompts.map((prompt) => prompt.alwaysAllow)).toEqual([false])
    }
  })

  test("reads the files the model asks for, but nothing kept unreadable", async () => {
    const replies = ['<read path="tool.sh"/>\n<read path="secret/key"/>', "<block>no</block>"]
    let unreadable = ""
    const h = await setup({ reply: async () => replies.shift()!, unreadable: () => [unreadable] })
    unreadable = join(h.workspace, "secret")
    writeFileSync(join(h.workspace, "tool.sh"), "echo hi\n")
    mkdirSync(join(h.workspace, "secret"))
    writeFileSync(join(h.workspace, "secret", "key"), "k")
    await h.request(edit())
    expect(h.reviews[1]!.prompt).toContain('<result read="tool.sh">\n1: echo hi\n2: \n</result>')
    expect(h.reviews[1]!.prompt).toContain('<result read="secret/key">\nNot read: this path is kept unreadable.\n</result>')
  })

  test("says it in the environment's language", async () => {
    language = "zh"
    const h = await setup({ reply: async () => "<block>yes</block><reason>写桌面</reason>" })
    await h.request(edit())
    expect(h.prompts[0]!.message).toBe("⚠ 自动审查：写桌面")
  })
})

describe("withFirstLine", () => {
  test("puts the line above the output, as text or as the first part", () => {
    expect(withFirstLine("Auto-approved", "out")).toBe("Auto-approved\nout")
    expect(withFirstLine("Auto-approved", [{ type: "text", text: "out" }])).toEqual([
      { type: "text", text: "Auto-approved" },
      { type: "text", text: "out" },
    ])
    expect(withFirstLine("Auto-approved", undefined)).toBe("Auto-approved")
  })
})
