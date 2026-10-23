import { describe, expect, test } from "bun:test"
import { Schema } from "effect"
import { createPasses, type EscapeOptions, escapeInput, escapeShell, type ShellCall, splitCommands } from "../../src/sandbox/escape.ts"

describe("passes", () => {
  test("a granted command runs unconfined once, as written", () => {
    const passes = createPasses()
    const command = passes.grant("echo a\necho b")
    expect(command).toMatch(/^# opencode-guard unsandboxed [0-9a-f-]{36}\necho a\necho b$/)
    expect(passes.take(command)).toBe("echo a\necho b")
    expect(passes.take(command)).toBeUndefined()
  })

  test("a command without a granted token stays sandboxed", () => {
    const passes = createPasses()
    const command = passes.grant("ls")
    expect(passes.take("ls")).toBeUndefined()
    expect(passes.take("# opencode-guard unsandboxed 00000000-0000-0000-0000-000000000000\nls")).toBeUndefined()
    expect(passes.take(command)).toBe("ls")
    expect(passes.take(command)).toBeUndefined()
  })

  test("a pass granted before the plugin reloads is good once after it", async () => {
    // A query makes Bun run the module again, as a reload does.
    const reloaded: typeof import("../../src/sandbox/escape.ts") = await import(`../../src/sandbox/escape.ts?reload=${Date.now()}`)
    const command = createPasses().grant("ls")
    expect(reloaded.createPasses().take(command)).toBe("ls")
    expect(createPasses().take(command)).toBeUndefined()
  })

  test("a command a later hook of the same call rewrote below the line runs as rewritten", () => {
    const passes = createPasses()
    const command = passes.grant('cd a && ls -l "b c"')
    expect(passes.take(command.replace("&& ls", "&& rtk ls"))).toBe('cd a && rtk ls -l "b c"')
  })
})

describe("escapeShell", () => {
  function setup(authorize: EscapeOptions["authorize"] = async () => {}) {
    const passes = createPasses()
    const asked: unknown[][] = []
    const options: EscapeOptions = {
      passes,
      authorize: async (...args) => {
        asked.push(args)
        return authorize(...args)
      },
    }
    return { passes, asked, escape: (input: ShellCall) => escapeShell(input, options) }
  }

  test("without `unsandboxed: true` drops the two fields and asks nothing", async () => {
    const h = setup()
    expect(await h.escape({ command: "ls", timeout: 5 })).toEqual({ command: "ls", timeout: 5 })
    expect(await h.escape({ command: "ls", unsandboxed: "yes", explanation: "e" })).toEqual({ command: "ls" })
    expect(h.asked).toEqual([])
  })

  test("asks with the command, its directory and the explanation, then gives the command a pass, the other fields as they were", async () => {
    const h = setup()
    const escaped = await h.escape({ command: "npm run dev", workdir: "web", background: true, unsandboxed: true, explanation: " Serve it. " })
    expect(h.asked).toEqual([["npm run dev", "web", "Serve it."]])
    expect(escaped).toMatchObject({ workdir: "web", background: true })
    expect(Object.keys(escaped)).toEqual(["command", "workdir", "background"])
    expect(h.passes.take(escaped.command as string)).toBe("npm run dev")
    const bare = await h.escape({ command: "ls", unsandboxed: true, explanation: "e" })
    expect(h.asked.at(-1)).toEqual(["ls", undefined, "e"])
    expect(Object.keys(bare)).toEqual(["command"])
  })

  test("without a command or an explanation the user is not asked and the agent is told why", async () => {
    const h = setup()
    await expect(h.escape({ command: " ", unsandboxed: true, explanation: "e" })).rejects.toThrow("No command to run.")
    for (const explanation of [undefined, "", "  "]) {
      await expect(h.escape({ command: "true", unsandboxed: true, explanation })).rejects.toThrow(
        "Explain what the command is for, why it has to run outside the sandbox, and what it changes there; the user decides from that.",
      )
    }
    expect(h.asked).toEqual([])
  })

  test("a denial goes back to the agent as its message; the user declining without a word, as OpenCode's error itself", async () => {
    const denied = setup(async () => {
      throw Object.assign(new Error("Denied by a rule"), { _tag: "Tool.Error" })
    })
    await expect(denied.escape({ command: "touch x", unsandboxed: true, explanation: "e" })).rejects.toThrow("Denied by a rule")
    const cause = new Error("declined")
    const declined = setup(async () => {
      throw cause
    })
    await expect(declined.escape({ command: "true", unsandboxed: true, explanation: "e" })).rejects.toBe(cause)
  })
})

describe("escapeInput", () => {
  test("adds the two fields to an Effect struct as optional, described; anything else stays as it is", () => {
    const input = escapeInput(Schema.Struct({ command: Schema.String, workdir: Schema.optional(Schema.String), background: Schema.optional(Schema.Boolean) })) as Schema.Struct<Schema.Struct.Fields> & Schema.Codec<unknown>
    expect(Schema.decodeUnknownSync(input)({ command: "ls" })).toEqual({ command: "ls" })
    expect(() => Schema.decodeUnknownSync(input)({ command: "ls", unsandboxed: "yes" })).toThrow()
    const schema = JSON.stringify(Schema.toJsonSchemaDocument(input))
    expect(schema).toContain("Every command runs in a sandbox")
    expect(schema).toContain("Required with `unsandboxed`")
    expect(escapeInput({ type: "object" })).toBeUndefined()
    expect(escapeInput(Schema.Struct({ command: Schema.String }))).toBeUndefined()
  })
})


describe("splitCommands", () => {
  const split = (command: string, channel = "latest") => splitCommands(command, { shell: "/bin/zsh", cwd: process.cwd(), channel })

  test("gives OpenCode's own parts: each command, with its redirections and here-document body", async () => {
    expect(await split("a || b; c | d\ne")).toEqual(["a", "b", "c", "d", "e"])
    expect(await split(`echo "a && b" 'c; d'`)).toEqual([`echo "a && b" 'c; d'`])
    expect(await split("cat > f <<'EOF'\nit's here\nEOF\necho done")).toEqual(["cat > f <<'EOF'\nit's here\nEOF", "echo done"])
    expect(await split("echo $(ls | wc -l)")).toEqual(["echo $(ls | wc -l)", "ls", "wc -l"])
  })

  test("leaves out `cd`, as OpenCode does", async () => {
    expect(await split("cd repo && git push origin main")).toEqual(["git push origin main"])
  })

  test("parses as OpenCode's channel would: tree-sitter for a release, the portable scanner for a local build", async () => {
    expect(await split("if [ x ]; then rm -rf y; fi")).toEqual(["rm -rf y"])
    expect(await split("if [ x ]; then rm -rf y; fi", "local")).toEqual(["[ x ]", "rm -rf y"])
  })

  test("a command OpenCode finds no part in, or cannot parse, is the one part: leaving the sandbox always asks", async () => {
    expect(await split("cd x")).toEqual(["cd x"])
    expect(await split("export A=1")).toEqual(["export A=1"])
    expect(await split(" ; ")).toEqual([";"])
    expect(await split("echo 'unterminated", "local")).toEqual(["echo 'unterminated"])
  })
})
