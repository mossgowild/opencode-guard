import { closeSync, openSync, readdirSync, readSync, realpathSync, statSync } from "node:fs"
import { homedir } from "node:os"
import { isAbsolute, join, resolve, sep } from "node:path"

/**
 * The reviewer's look at local files before it decides: it cannot call tools
 * (one `generate.text` call carries no tools), so it asks in plain text, one
 * line per lookup, and the plugin reads for it. Only reading files and listing
 * directories, never a path kept unreadable: what is read goes to the review
 * model's provider.
 */

export type Lookup = { readonly kind: "read"; readonly path: string; readonly offset?: number; readonly limit?: number } | { readonly kind: "list"; readonly path: string }

/** The lookups an answer asks for, in order: `<read path="…" offset="…" limit="…"/>` and `<list path="…"/>`. */
export function parseLookups(text: string): Lookup[] {
  const lookups: Lookup[] = []
  const attributes = (text: string): Record<string, string> => Object.fromEntries([...text.matchAll(/(\w+)\s*=\s*"([^"]*)"/g)].map((attr) => [attr[1]!.toLowerCase(), attr[2]!]))
  // A model that has seen a round of results may ask in their shape instead:
  // an empty `<result read="PATH"/>` or `<result list="PATH"/>` is a request
  // too, as nothing came back in it.
  const requests: { kind: string; attrs: Record<string, string>; at: number }[] = [
    ...[...text.matchAll(/<(read|list)\b([^>]*?)\/?>/gi)].map((match) => ({ kind: match[1]!, attrs: attributes(match[2]!), at: match.index })),
    ...[...text.matchAll(/<result\b([^>]*?)(?:\/>|>\s*<\/result>)/gi)].flatMap((match) => {
      const attrs = attributes(match[1]!)
      const kind = attrs.read !== undefined ? "read" : attrs.list !== undefined ? "list" : undefined
      return kind ? [{ kind, attrs: { ...attrs, path: attrs[kind]! }, at: match.index }] : []
    }),
  ].sort((a, b) => a.at - b.at)
  for (const { kind, attrs } of requests) {
    const path = attrs.path?.trim()
    if (!path) continue
    if (kind.toLowerCase() === "list") {
      lookups.push({ kind: "list", path })
      continue
    }
    const number = (value: string | undefined) => (value !== undefined && /^\d+$/.test(value.trim()) ? Number(value) : undefined)
    const offset = number(attrs.offset)
    const limit = number(attrs.limit)
    lookups.push({ kind: "read", path, ...(offset !== undefined && { offset }), ...(limit !== undefined && { limit }) })
  }
  return lookups
}

export interface LookOptions {
  /** Where relative paths start: the session's directory. */
  readonly cwd: string
  readonly home?: string
  /** Paths kept unreadable, written as sandbox settings write them (`~`, globs). */
  readonly denyRead: readonly string[]
}

const READ_BYTES = 256 * 1024
/** Lines a read gives without a limit. */
export const READ_LINES = 400
const LIST_ENTRIES = 200

const expand = (path: string, options: LookOptions) => {
  const home = options.home ?? homedir()
  const full = path === "~" ? home : path.startsWith("~/") ? join(home, path.slice(2)) : path
  return isAbsolute(full) ? resolve(full) : resolve(options.cwd, full)
}

/** The path with every link on it resolved, as far as it exists; undefined when nothing of it does. */
function real(path: string): string | undefined {
  try {
    return realpathSync(path)
  } catch {
    return undefined
  }
}

/**
 * A deny glob as sandbox-runtime reads it (its globToRegex): `**\/` is any
 * number of directories, none included, `**` anything, `*` and `?` stop at
 * `/`; a match covers everything beneath it.
 */
function denyGlob(pattern: string): RegExp {
  const source = pattern
    .replace(/[.^$+{}()|\\]/g, "\\$&")
    .replace(/\*\*\//g, "\0GS\0")
    .replace(/\*\*/g, "\0G\0")
    .replace(/\*/g, "[^/]*")
    .replace(/\?/g, "[^/]")
    .replaceAll("\0GS\0", "(.*/)?")
    .replaceAll("\0G\0", ".*")
  return new RegExp(`^${source}(/.*)?$`)
}

/** True when `path` is kept unreadable: under a denied path, or matching a denied glob. */
function denied(path: string, options: LookOptions): boolean {
  return options.denyRead.some((entry) => {
    const target = expand(entry, options)
    if (/[*?[\]]/.test(target)) return denyGlob(target).test(path)
    const resolved = real(target) ?? target
    return path === resolved || path.startsWith(resolved.endsWith(sep) ? resolved : resolved + sep)
  })
}

/** What a lookup finds, as text for the reviewer; a reason instead when it cannot be done. */
export function look(lookup: Lookup, options: LookOptions): string {
  // Denied as written and as resolved, before saying whether it is there.
  const full = expand(lookup.path, options)
  const path = real(full)
  if (denied(full, options) || (path !== undefined && denied(path, options))) return "Not read: this path is kept unreadable."
  if (path === undefined) return "Not found."
  let stat
  try {
    stat = statSync(path)
  } catch {
    return "Not found."
  }
  if (lookup.kind === "list") {
    if (!stat.isDirectory()) return "Not a directory."
    const entries = readdirSync(path, { withFileTypes: true })
      .map((entry) => (entry.isDirectory() ? `${entry.name}/` : entry.name))
      .sort()
    const shown = entries.slice(0, LIST_ENTRIES)
    return [...shown, ...(entries.length > shown.length ? [`… ${entries.length - shown.length} more`] : [])].join("\n") || "(empty)"
  }
  if (stat.isDirectory()) return "A directory: list it instead."
  const buffer = Buffer.alloc(Math.min(stat.size, READ_BYTES))
  const fd = openSync(path, "r")
  try {
    readSync(fd, buffer, 0, buffer.length, 0)
  } finally {
    closeSync(fd)
  }
  if (buffer.subarray(0, 8192).includes(0)) return "Not read: a binary file."
  const lines = buffer.toString().split("\n")
  if (stat.size > READ_BYTES) lines.pop()
  const first = Math.max(1, lookup.offset ?? 1)
  const shown = lines.slice(first - 1, first - 1 + (lookup.limit ?? READ_LINES))
  const rest = lines.length - (first - 1 + shown.length)
  return [...shown.map((line, i) => `${first + i}: ${line}`), ...(rest > 0 || stat.size > READ_BYTES ? ["… more below; read again with a later offset"] : [])].join("\n")
}
