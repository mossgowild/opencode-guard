import { describe, expect, test } from "bun:test"
import { blocked, withViolations } from "../../src/sandbox/violations.ts"

describe("blocked", () => {
  test("keeps the denials that change what a command does, once each; drops system queries", () => {
    expect(
      blocked([
        "sh(1) deny(1) sysctl-read kern.iossupportversion",
        "touch(2) deny(1) file-write-create /Users/x/a",
        "curl(3) deny(1) system-info vfs.disk-space",
        "curl(3) deny(1) network-outbound 1.2.3.4:443",
        "touch(2) deny(1) file-write-create /Users/x/a",
        "not a denial",
      ]),
    ).toEqual(["touch(2) deny(1) file-write-create /Users/x/a", "curl(3) deny(1) network-outbound 1.2.3.4:443"])
  })
})

describe("withViolations", () => {
  test("puts the denials and the hint after the output, as text or as a last part", () => {
    const text = withViolations(["d"], "out") as string
    expect(text.startsWith("out\n\n<sandbox_violations>\nd\n</sandbox_violations>\nThe sandbox blocked what is listed above.")).toBe(true)
    expect(withViolations(["d"], [{ type: "text", text: "out" }])).toEqual([{ type: "text", text: "out" }, { type: "text", text: text.slice("out\n\n".length) }])
    expect(withViolations(["d"], undefined)).toBe(text.slice("out\n\n".length))
  })
})
