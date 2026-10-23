import { describe, expect, test } from "bun:test"
import { denialStore, lineReader } from "../../src/sandbox/denials.ts"

const tag = (id: string) => `CMD64_${Buffer.from(id).toString("base64")}_END__abc123_SBX`
const denial = (what: string) => `2026-10-23 02:45:38.105 E  kernel[0:7eaa6a8] (Sandbox) Sandbox: ${what}`

describe("denialStore", () => {
  test("keeps every denial of a watched command, however the log's chunks fall, and nothing of others", () => {
    const store = denialStore()
    store.watch("a")
    const read = lineReader(store.line)
    // Several denials in one chunk, one split across two: what the library's monitor loses.
    const log = [denial("sh(1) deny(1) sysctl-read kern.iossupportversion"), tag("a"), denial("touch(1) deny(1) file-write-create /Users/x/a"), tag("a"), denial("ls(2) deny(1) file-read-data /x"), tag("b"), ""].join("\n")
    const cut = log.indexOf("file-write-create") + 5
    read(log.slice(0, cut))
    read(log.slice(cut))
    expect(store.seen("a")).toEqual(["sh(1) deny(1) sysctl-read kern.iossupportversion", "touch(1) deny(1) file-write-create /Users/x/a"])
    expect(store.seen("b")).toEqual([])
    store.release("a")
    expect(store.seen("a")).toEqual([])
  })

  test("ignores a tag with no denial before it", () => {
    const store = denialStore()
    store.watch("a")
    store.line(tag("a"))
    store.line("Filtering the log data using ...")
    expect(store.seen("a")).toEqual([])
  })
})
