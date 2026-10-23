import { describe, expect, test } from "bun:test"
import { homedir } from "node:os"
import { join } from "node:path"
import { systemDenials } from "../../src/sandbox/denials.ts"
import { sandboxConfig, sandboxSection, wrapCommand } from "../../src/sandbox/sandbox.ts"
import { tempDir } from "../tmp.ts"

const claude = {
  enabled: true,
  autoAllowBashIfSandboxed: true,
  enableWeakerNetworkIsolation: true,
  network: { allowAllUnixSockets: true, allowLocalBinding: true, allowMachLookup: ["*"], allowedDomains: ["100.64.0.1"] },
  filesystem: { allowWrite: ["~/.cache", "/tmp"], denyWrite: ["~/.cache/secret"] },
}

describe("sandboxConfig", () => {
  test("takes Claude's sandbox settings and drops Claude-only keys", () => {
    const config = sandboxConfig(claude, "/ws")
    expect(config.network.allowedDomains).toEqual(["100.64.0.1"])
    expect(config.network.allowMachLookup).toEqual(["*"])
    expect(config.network.allowAllUnixSockets).toBe(true)
    expect(config.enableWeakerNetworkIsolation).toBe(true)
    expect(config).not.toHaveProperty("enabled")
    expect(config).not.toHaveProperty("autoAllowBashIfSandboxed")
  })

  test("adds the session directory as writable and its OpenCode config as read-only", () => {
    const { filesystem } = sandboxConfig(claude, "/ws")
    expect(filesystem.allowWrite).toEqual(["~/.cache", "/tmp", "/ws"])
    expect(filesystem.denyWrite).toEqual(expect.arrayContaining(["~/.cache/secret", "/ws/.opencode", "/ws/opencode.json", "/ws/opencode.jsonc", "/ws/.git/hooks", "/ws/.git/config"]))
  })

  test("keeps what Claude Code's own sandbox keeps: its config here and above, its state and secrets", () => {
    const ws = join(homedir(), "code", "proj")
    const { filesystem } = sandboxConfig(claude, ws)
    expect(filesystem.denyWrite).toEqual(
      expect.arrayContaining([
        join(ws, ".claude", "settings.json"),
        join(ws, ".claude", "skills"),
        join(ws, ".mcp.json"),
        join(homedir(), "code", ".claude", "hooks"),
        join(homedir(), ".claude", "settings.json"),
        join(homedir(), ".claude", "plugins"),
      ]),
    )
    expect(filesystem.denyWrite).not.toContain("/.claude/settings.json")
    expect(filesystem.denyRead).toEqual(expect.arrayContaining([join(homedir(), ".claude", "seed-admin"), join(homedir(), ".claude", "ide")]))
  })

  test("leaves the network unrestricted without allowedDomains, keeping the rest of the network section", () => {
    const { network } = sandboxConfig({ network: { allowMachLookup: ["*"] } }, "/ws")
    expect(network).not.toHaveProperty("allowedDomains")
    expect(network.allowMachLookup).toEqual(["*"])
  })

  test("works with an empty sandbox section and rejects invalid settings", () => {
    expect(sandboxConfig({}, "/ws").network).not.toHaveProperty("allowedDomains")
    expect(() => sandboxConfig({ network: { allowedDomains: ["*"] } }, "/ws")).toThrow()
  })
})

describe("sandboxSection", () => {
  test("takes the section as read from the config file, and throws without one", () => {
    expect(sandboxSection(claude)).toEqual(claude)
    for (const missing of [undefined, null, [], "x"]) expect(() => sandboxSection(missing)).toThrow("no sandbox section")
  })
})

// Seatbelt cannot nest: inside another agent's sandbox these runs are skipped.
const nested = Bun.spawnSync(["/usr/bin/sandbox-exec", "-p", "(version 1)(allow default)", "/usr/bin/true"]).exitCode !== 0

describe.skipIf(nested)("wrapCommand (real sandbox)", () => {
  test("writes only where the config allows, and the system log has what it denied under the command's id", async () => {
    const denials = systemDenials()
    const id = `probe-${process.pid}`
    denials.watch(id)
    await Bun.sleep(1_000) // `log stream` starting
    const workspace = tempDir("real")
    const outside = join(homedir(), `.guard-probe-${process.pid}`)
    const config = sandboxConfig({ filesystem: { allowWrite: [] } }, workspace)
    const command = `touch ${workspace}/ok && echo inside-ok; touch ${workspace}/.opencode-x; mkdir -p ${workspace}/.opencode 2>&1 | tail -1; touch ${outside} 2>&1 | tail -1`
    const wrapped = await wrapCommand(command, "/bin/zsh", config, id)
    const proc = Bun.spawn(["/bin/sh", "-c", wrapped], { stdout: "pipe", stderr: "pipe" })
    const out = (await new Response(proc.stdout).text()) + (await new Response(proc.stderr).text())
    await proc.exited
    expect(out).toContain("inside-ok")
    expect(out).toContain(`${outside}: Operation not permitted`)
    expect(out).toContain(`${workspace}/.opencode: Operation not permitted`)
    for (let i = 0; i < 20 && !denials.seen(id).some((line) => line.includes(outside)); i++) await Bun.sleep(100)
    expect(denials.seen(id)).toContainEqual(expect.stringContaining(`file-write-create ${outside}`))
    denials.release(id)
  })
})
