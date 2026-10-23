import { randomUUID } from "node:crypto"
import type { Plugin } from "@opencode/plugin"
import { type AutoReviewConfig, loadAutoReview } from "./config.ts"
import { detectLanguage, words } from "./i18n.ts"
import { logReview } from "./log.ts"
import { look } from "./look.ts"
import {
  actionLine,
  instructions,
  LOOK_ROUNDS,
  type Outcome,
  REVIEW_TIMEOUT_MS,
  type Review,
  renderTranscript,
  reviewPrompt,
  runReview,
  transcriptEntries,
  truncate,
  withTimeout,
} from "./review.ts"

/**
 * The auto review module: with auto review on, takes over every permission request
 * that would prompt, whoever raised it. A model reviews it first under the
 * user's rules (see review.ts) and may let it through; anything else the user
 * answers on a prompt this module raises in its place: the same action,
 * resources and details, without `save`, so no prompt offers "always allow"
 * and nothing the user allows once widens to a saved rule. With auto review off
 * the module leaves every request to OpenCode.
 */

export interface AutoReviewOptions {
  /** The session's own directory: the reviewer's working directory. */
  readonly workspace: string
  /** The `autoReview` section of the plugin's config, read on every request so edits apply at once. */
  readonly section: () => unknown
  /** Paths the reviewer must not read, since what it reads goes to its model's provider; throws when unknown. */
  readonly unreadable?: () => readonly string[]
}

/** The key in the details of the prompt this module raises, which marks it as its own. */
const STAND_IN = "opencode-guard.stand-in"
/** True for the error a denied permission check rejects with: its message is for the agent. */
function isToolError(error: unknown): error is Error {
  return typeof error === "object" && error !== null && (error as { _tag?: unknown })._tag === "Tool.Error"
}

/** The tool's output with `line` above it, as text or as the first part. */
export function withFirstLine<Part>(line: string, content: string | readonly Part[] | undefined): string | (Part | { type: "text"; text: string })[] {
  if (content === undefined) return line
  return typeof content === "string" ? `${line}\n${content}` : [{ type: "text", text: line }, ...content]
}

export async function setupAutoReview(ctx: Plugin.Context, options: AutoReviewOptions) {
  const { workspace } = options
  const say = words(detectLanguage())
  /** The messages of this module's own prompts, by the token in their details. */
  const standIns = new Map<string, string>()
  /** Calls whose request the review let through, so their output says so. */
  const approved = new Set<string>()

  /** The `autoReview` section: undefined when auto review is off, null when it is on but cannot be used. */
  function autoReview(): AutoReviewConfig | null | undefined {
    try {
      return loadAutoReview(options.section())
    } catch {
      return null
    }
  }

  /** How the review ended; a failure or a timeout is an outcome too, never an error. */
  async function review(
    event: { readonly sessionID: string; readonly action: string; readonly resources: readonly string[]; readonly metadata?: Record<string, unknown>; readonly source?: { readonly id: string } },
    config: AutoReviewConfig,
  ): Promise<Review> {
    try {
      // The call is already in the session's messages; it goes last, as the action.
      const messages = (await ctx.session.context({ sessionID: event.sessionID })) as readonly unknown[]
      const prompt = reviewPrompt({
        policy: config.policy,
        cwd: workspace,
        instructions: instructions(workspace),
        transcript: renderTranscript(transcriptEntries(messages, event.source?.id)),
        action: actionLine({ action: event.action, resources: event.resources, ...(event.metadata && { metadata: event.metadata }) }),
      })
      // The reviewer reads nothing when the unreadable paths are unknown.
      const lookAt = (lookup: Parameters<typeof look>[0]) => {
        try {
          return look(lookup, { cwd: workspace, denyRead: options.unreadable?.() ?? [] })
        } catch {
          return "Not read: which paths are kept unreadable is unknown."
        }
      }
      const ask = async (text: string) => (await ctx.generate.text({ prompt: text, model: config.model })).text
      return (await withTimeout(runReview(prompt, ask, lookAt), REVIEW_TIMEOUT_MS)) ?? { outcome: { kind: "timeout" }, rounds: 0 }
    } catch (error) {
      return { outcome: { kind: "error", error: truncate(error instanceof Error ? error.message : String(error), 50) }, rounds: 0 }
    }
  }

  /** The line on the prompt saying why the review left the request to the user. */
  function why(outcome: Outcome): string {
    switch (outcome.kind) {
      case "verdict":
        return outcome.verdict.reason || say.noReason
      case "unreadable":
        return say.unreadable
      case "kept-looking":
        return say.keptLooking(LOOK_ROUNDS)
      case "timeout":
        return say.timeout(REVIEW_TIMEOUT_MS / 1000)
      case "error":
        return say.failed(outcome.error)
    }
  }

  await ctx.permission.hook("evaluate", async (event) => {
    const token = event.metadata?.[STAND_IN]
    if (typeof token === "string") {
      // This module's own prompt: it shows what the original would have, and the review's reason.
      const message = standIns.get(token)
      if (message !== undefined) event.message = message
      return
    }
    if (event.effect !== "ask") return
    // Off, OpenCode asks as it would; on but unusable, the user answers on this module's prompt unreviewed.
    const config = autoReview()
    if (config === undefined) return
    let outcome: Outcome | undefined
    if (config) {
      const started = Date.now()
      const done = await review(event, config)
      outcome = done.outcome
      logReview({
        time: new Date(started).toISOString(),
        sessionID: event.sessionID,
        action: event.action,
        resources: truncate(event.resources.join("\n"), 500),
        model: `${config.model.providerID}/${config.model.id}`,
        ...(config.model.variant && { variant: config.model.variant }),
        ms: Date.now() - started,
        rounds: done.rounds,
        outcome: outcome.kind === "verdict" ? (outcome.verdict.allow ? "allow" : "block") : outcome.kind,
        ...(outcome.kind === "verdict" && outcome.verdict.reason && { reason: outcome.verdict.reason }),
        ...(outcome.kind === "error" && { error: outcome.error }),
        ...(done.answer !== undefined && { answer: truncate(done.answer, 500) }),
      })
      if (outcome.kind === "verdict" && outcome.verdict.allow) {
        event.effect = "allow"
        if (event.source) approved.add(event.source.id)
        return
      }
    }
    // The prompt shows why the review left it to the user, on a line of its own
    // with a marked label: the message is plain text.
    const stand = randomUUID()
    standIns.set(stand, [event.message, outcome && `${say.review}${why(outcome)}`].filter(Boolean).join("\n"))
    try {
      await ctx.permission.assert({
        sessionID: event.sessionID,
        ...(event.agent && { agent: event.agent }),
        action: event.action,
        resources: [...event.resources],
        // No `save`: without it the prompt offers no "always allow".
        metadata: { ...event.metadata, [STAND_IN]: stand },
        ...(event.source && { source: event.source }),
      })
      event.effect = "allow"
    } catch (error) {
      // Declined without a word, the request fails as OpenCode's own prompt
      // would: with OpenCode's error, which ends the agent's step. With a word,
      // the request is denied and what the user said goes back to the agent.
      if (!isToolError(error)) throw error
      event.effect = "deny"
      event.message = error.message
    } finally {
      standIns.delete(stand)
    }
  })
  // An auto-approved call says so above its output.
  await ctx.tool.hook("execute.after", (event) => {
    if (!approved.delete(event.id)) return
    if (event.status === "completed") event.result = { ...event.result, content: withFirstLine(say.autoApproved, event.result.content) }
  })
}
