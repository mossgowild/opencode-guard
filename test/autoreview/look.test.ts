import { describe, expect, test } from "bun:test"
import { mkdirSync, symlinkSync, writeFileSync } from "node:fs"
import { join } from "node:path"
import { look, parseLookups, READ_LINES } from "../../src/autoreview/look.ts"
import { tempDir } from "../tmp.ts"

describe("parseLookups", () => {
  test("reads the read and list lines, with numbers only where they are numbers", () => {
    expect(parseLookups('<read path="a.sh"/>\n<list path="~/x" />\n<READ path="b" offset="10" limit="x">\n<read/>\nnoise')).toEqual([
      { kind: "read", path: "a.sh" },
      { kind: "list", path: "~/x" },
      { kind: "read", path: "b", offset: 10 },
    ])
    expect(parseLookups("<block>no</block>")).toEqual([])
  })
})

describe("look", () => {
  function setup() {
    const home = tempDir("look-home")
    const cwd = join(home, "ws")
    mkdirSync(join(cwd, "sub"), { recursive: true })
    mkdirSync(join(home, ".secret"), { recursive: true })
    writeFileSync(join(cwd, "tool.sh"), "a\nb\nc\n")
    writeFileSync(join(home, ".secret", "key"), "k")
    writeFileSync(join(cwd, "token.pem"), "p")
    writeFileSync(join(cwd, "bin"), Buffer.from([1, 0, 2]))
    symlinkSync(join(home, ".secret", "key"), join(cwd, "link"))
    return { home, cwd, options: { cwd, home, denyRead: ["~/.secret", "**/*.pem"] } }
  }

  test("reads a text file from the session's directory, numbered, in part when asked", () => {
    const { options } = setup()
    expect(look({ kind: "read", path: "tool.sh" }, options)).toBe("1: a\n2: b\n3: c\n4: ")
    expect(look({ kind: "read", path: "tool.sh", offset: 2, limit: 1 }, options)).toBe("2: b\n… more below; read again with a later offset")
  })

  test("lists a directory, its folders marked", () => {
    const { options } = setup()
    expect(look({ kind: "list", path: "." }, options)).toBe("bin\nlink\nsub/\ntoken.pem\ntool.sh")
    expect(look({ kind: "list", path: "tool.sh" }, options)).toBe("Not a directory.")
    expect(look({ kind: "read", path: "sub" }, options)).toBe("A directory: list it instead.")
  })

  test("keeps away from what the sandbox keeps unreadable, through links and globs too", () => {
    const { options } = setup()
    const no = "Not read: this path is kept unreadable."
    expect(look({ kind: "read", path: "~/.secret/key" }, options)).toBe(no)
    expect(look({ kind: "list", path: "~/.secret" }, options)).toBe(no)
    expect(look({ kind: "read", path: "link" }, options)).toBe(no)
    expect(look({ kind: "read", path: "token.pem" }, options)).toBe(no)
  })

  test("does not read binary files or what is not there, and stops a long file at its line budget", () => {
    const { cwd, options } = setup()
    expect(look({ kind: "read", path: "bin" }, options)).toBe("Not read: a binary file.")
    expect(look({ kind: "read", path: "nope" }, options)).toBe("Not found.")
    writeFileSync(join(cwd, "long"), Array.from({ length: READ_LINES + 5 }, (_, i) => `l${i}`).join("\n"))
    const lines = look({ kind: "read", path: "long" }, options).split("\n")
    expect(lines).toHaveLength(READ_LINES + 1)
    expect(lines.at(-1)).toBe("… more below; read again with a later offset")
  })
})
