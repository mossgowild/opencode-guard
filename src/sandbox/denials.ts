import { type ChildProcess, spawn } from "node:child_process"

/**
 * What Seatbelt denied each sandboxed command, read from the system log.
 *
 * sandbox-runtime tags every sandboxed command so its denials can be told
 * apart: the kernel logs each denial as two lines, the denial and then
 * `CMD64_<base64 of the command's id>_END_<session>_SBX`. The library has a
 * monitor of its own, but it reads only the first denial of each chunk `log
 * stream` writes; on a busy machine several arrive together, and the
 * `sysctl-read` every shell is denied at start pushes out the one that
 * matters. This reads every line.
 */
export interface Denials {
  /** Starts keeping the denials logged under `commandId`. */
  watch(commandId: string): void
  /** The denials logged under `commandId` so far, as `touch(2) deny(1) file-write-create /x`. */
  seen(commandId: string): readonly string[]
  /** Stops keeping them. */
  release(commandId: string): void
}

/** Every line of `log stream`'s output, the last partial one kept for the next chunk. */
export function lineReader(onLine: (line: string) => void) {
  let rest = ""
  return (chunk: string) => {
    const lines = (rest + chunk).split("\n")
    rest = lines.pop() ?? ""
    for (const line of lines) onLine(line)
  }
}

/** Denials from log lines, each paired with the tag line after it, kept for watched ids. */
export function denialStore(): Denials & { line(line: string): void } {
  const kept = new Map<string, string[]>()
  let denial: string | undefined
  return {
    watch: (commandId) => void kept.set(commandId, kept.get(commandId) ?? []),
    seen: (commandId) => kept.get(commandId) ?? [],
    release: (commandId) => void kept.delete(commandId),
    line(line) {
      const found = /Sandbox:\s+(.*\bdeny\(\d+\).*)$/.exec(line)
      if (found) {
        denial = found[1]
        return
      }
      const tag = /^CMD64_(.+?)_END/.exec(line)
      if (!tag || denial === undefined) return
      const commandId = Buffer.from(tag[1]!, "base64").toString("utf8")
      kept.get(commandId)?.push(denial)
      denial = undefined
    },
  }
}

const SHARED = Symbol.for("opencode-guard.denials")
const PREDICATE = `'eventMessage CONTAINS "CMD64_" AND eventMessage ENDSWITH "_SBX"'`

/**
 * The process's one reader, shared across reloads of the plugin. It starts
 * when first asked for, ahead of the first command, does not keep the process
 * alive, and on a platform without `log stream` simply sees nothing.
 */
export function systemDenials(): Denials {
  const shared = globalThis as { [SHARED]?: Denials }
  if (shared[SHARED]) return shared[SHARED]
  const store = denialStore()
  let child: ChildProcess | undefined
  const start = () => {
    if (child || process.platform !== "darwin") return
    // `log stream` outlives a process killed outright, so a shell waits on
    // this process's end of a pipe and stops it when the pipe closes.
    child = spawn("/bin/sh", ["-c", `log stream --style compact --predicate ${PREDICATE} & read _; kill $!`], {
      stdio: ["pipe", "pipe", "ignore"],
    })
    child.stdout?.setEncoding("utf8").on("data", lineReader(store.line))
    child.on("error", () => {})
    child.on("exit", () => {
      child = undefined
    })
    child.unref()
    for (const stream of [child.stdin, child.stdout]) (stream as { unref?: () => void } | null)?.unref?.()
  }
  start()
  shared[SHARED] = {
    watch(commandId) {
      start()
      store.watch(commandId)
    },
    seen: store.seen,
    release: store.release,
  }
  return shared[SHARED]
}
