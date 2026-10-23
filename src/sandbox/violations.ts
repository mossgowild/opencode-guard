/**
 * What the sandbox blocked while a command ran, put after its output as
 * Claude Code puts it, so the agent sees why it failed and how to leave the
 * sandbox. The lines are Seatbelt's own denials, not a guess from the output.
 */

/**
 * Denials worth telling the agent about. Seatbelt also denies system
 * queries (`sysctl-read kern.iossupportversion` from every shell, `system-info`
 * from curl) that change nothing a command does; those would mark every command.
 */
export function blocked(lines: readonly string[]): string[] {
  const kept = lines.filter((line) => {
    const operation = /\bdeny\(\d+\)\s+(\S+)/.exec(line)?.[1]
    return operation !== undefined && !operation.startsWith("sysctl-") && operation !== "system-info"
  })
  return [...new Set(kept)]
}

const HINT =
  "The sandbox blocked what is listed above. If that is why the command failed and it has to run outside the sandbox, run it again with `unsandboxed: true` and an explanation; the user is asked first. If what was blocked has nothing to do with the task, tell the user instead of retrying."

/** The tool's output with the denials and the hint after it, as text or as a last part. */
export function withViolations<Part>(lines: readonly string[], content: string | readonly Part[] | undefined): string | (Part | { type: "text"; text: string })[] {
  const block = `<sandbox_violations>\n${lines.join("\n")}\n</sandbox_violations>\n${HINT}`
  if (content === undefined) return block
  return typeof content === "string" ? `${content}\n\n${block}` : [...content, { type: "text", text: block }]
}
