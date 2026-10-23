/** "provider/model", where the model ID may itself contain slashes, and the model's variant when one is set. */
export interface ModelRef {
  readonly providerID: string
  readonly id: string
  readonly variant?: string
}

/** The autoReview section: the model that reviews a request before it prompts, and the user's rules it reviews under. */
export interface AutoReviewConfig {
  readonly model: ModelRef
  /** The user's rules, its lines joined. */
  readonly policy: string
}

/** The section as read from the config file, or undefined when it is off; throws when it is on but unusable, so callers ask as before. */
export function loadAutoReview(autoReview: unknown): AutoReviewConfig | undefined {
  if (autoReview === undefined) return undefined
  if (typeof autoReview !== "object" || autoReview === null || Array.isArray(autoReview)) throw new Error("autoReview must be an object")
  const { enabled, model, variant, policy } = autoReview as Record<string, unknown>
  if (enabled !== true) return undefined
  if (typeof model !== "string" || !/^[^/]+\/.+/.test(model)) throw new Error('autoReview.model must look like "provider/model"')
  if (variant !== undefined && (typeof variant !== "string" || variant === "")) throw new Error("autoReview.variant must be a variant name")
  if (!Array.isArray(policy) || policy.length === 0 || !policy.every((line) => typeof line === "string")) throw new Error("autoReview.policy must be a list of lines")
  const slash = model.indexOf("/")
  return {
    model: { providerID: model.slice(0, slash), id: model.slice(slash + 1), ...(variant !== undefined && { variant }) },
    policy: policy.join("\n"),
  }
}
