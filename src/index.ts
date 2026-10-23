import { Plugin } from "@opencode/plugin"
import { setupAutoReview } from "./autoreview/index.ts"
import { readConfigFile } from "./config.ts"
import { setupSandbox } from "./sandbox/index.ts"

/**
 * Two modules that know nothing of each other, each with its own section of
 * the plugin's config. The sandbox runs shell commands confined and asks
 * before one leaves it (src/sandbox). Auto review takes over every request that
 * would prompt, its own included: a model reviews it, and what the model does
 * not let through the user answers on a prompt without "always allow"
 * (src/autoreview). Here they are wired together: the sandbox's hooks first, so
 * its request carries the agent's explanation by the time auto review sees it,
 * and the reviewer kept away from what the sandbox keeps unreadable.
 */
export default Plugin.define({
  id: "opencode-guard",
  async setup(ctx) {
    // Only the session's own directory: the project directory is the enclosing
    // git root, which can be far wider (a home directory kept in git).
    const workspace = ctx.location.directory
    const sandbox = await setupSandbox(ctx, { workspace, section: () => readConfigFile().sandbox })
    await setupAutoReview(ctx, { workspace, section: () => readConfigFile().autoReview, unreadable: sandbox.unreadable })
  },
})
