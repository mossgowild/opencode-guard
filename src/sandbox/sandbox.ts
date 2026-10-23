import { SandboxManager, SandboxRuntimeConfigSchema, type SandboxRuntimeConfig } from "@anthropic-ai/sandbox-runtime"
import { claudeUnreadable, protectedPaths } from "./paths.ts"

/**
 * The sandbox is Claude Code's own (sandbox-runtime), configured by the
 * `sandbox` section of the plugin's config file, written like the `sandbox`
 * section of Claude Code's settings, so one section works in both.
 */
type SandboxSection = Record<string, unknown> & {
  readonly network?: Record<string, unknown>
  readonly filesystem?: { readonly allowRead?: string[]; readonly denyRead?: string[]; readonly allowWrite?: string[]; readonly denyWrite?: string[] }
}

/** The section as read from the config file; throws when there is none, so commands are refused. */
export function sandboxSection(sandbox: unknown): SandboxSection {
  if (typeof sandbox !== "object" || sandbox === null || Array.isArray(sandbox)) throw new Error("the plugin's config has no sandbox section")
  return sandbox as SandboxSection
}

/** Whether a command that runs sandboxed goes ahead without asking; on unless the section turns it off, as in Claude Code. */
export function autoAllowsSandboxed(sandbox: SandboxSection): boolean {
  return sandbox.autoAllowBashIfSandboxed !== false
}

/** Top-level keys sandbox-runtime understands; Claude-only ones (enabled, autoAllowBashIfSandboxed…) are ignored. */
function runtimeKeys(): Set<string> {
  let schema: any = SandboxRuntimeConfigSchema
  while (schema._def?.schema) schema = schema._def.schema
  return new Set(Object.keys(schema.shape))
}

/**
 * The sandbox section, plus what belongs to this OpenCode session: its
 * directory is writable and OpenCode's project config in it is not (a project
 * plugin there would run in later sessions and could replace the sandbox).
 */
export function sandboxConfig(sandbox: SandboxSection, workspace: string): SandboxRuntimeConfig {
  const keys = runtimeKeys()
  const shared = Object.fromEntries(Object.entries(sandbox).filter(([key]) => keys.has(key) && key !== "network" && key !== "filesystem"))
  const fs = sandbox.filesystem ?? {}
  const network = sandbox.network ?? {}
  const config = SandboxRuntimeConfigSchema.parse({
    ...shared,
    network: { allowedDomains: [], deniedDomains: [], ...network },
    filesystem: {
      allowRead: fs.allowRead ?? [],
      denyRead: [...(fs.denyRead ?? []), ...claudeUnreadable()],
      allowWrite: [...(fs.allowWrite ?? []), workspace],
      denyWrite: [...(fs.denyWrite ?? []), ...protectedPaths(workspace)],
    },
  })
  // Without allowedDomains sandbox-runtime leaves the network unrestricted, with
  // no proxy; its schema still asks for the key, so it goes after parsing.
  if (!("allowedDomains" in network)) delete (config.network as Partial<typeof config.network>).allowedDomains
  return config
}

let ready: Promise<void> | undefined
const processWide = (config: SandboxRuntimeConfig) => JSON.stringify({ ...config, filesystem: undefined })
let applied = ""

/**
 * One sandbox-runtime per process, shared by every session in it: the network
 * part (its proxy, when allowedDomains restricts the network) is process-wide,
 * the filesystem part goes with each command. Through the proxy, destinations
 * neither list decides are allowed, and deniedDomains still applies. The
 * command's denials are logged under `commandId` (see denials.ts).
 */
export async function wrapCommand(command: string, shell: string, config: SandboxRuntimeConfig, commandId: string): Promise<string> {
  if (!SandboxManager.isSupportedPlatform()) throw new Error("sandbox-runtime does not support this platform")
  if (!ready) {
    // initialize() ignores its config when sandbox-runtime is already set up,
    // as after OpenCode reloads this plugin, so the config is applied below.
    ready = SandboxManager.initialize(config, async () => true).catch((error) => {
      ready = undefined
      throw error
    })
  }
  await ready
  const key = processWide(config)
  if (key !== applied) {
    SandboxManager.updateConfig(config)
    applied = key
  }
  return SandboxManager.wrapWithSandbox(command, shell, { filesystem: config.filesystem }, undefined, { commandId, commandText: command })
}
