import { Plugin } from "@opencode/plugin/tui"
import { For } from "solid-js"

/** The left edge OpenCode's own question cards draw: one heavy bar, nothing else. */
const EDGE = { topLeft: "", bottomLeft: "", vertical: "┃", topRight: "", bottomRight: "", horizontal: " ", bottomT: "", topT: "", cross: "", leftT: "", rightT: "" }

/**
 * The terminal's half of the sandbox module. OpenCode's terminal prompt for a
 * shell request shows the call's command and never the request's message, so
 * the agent's explanation for leaving the sandbox would not reach the user.
 * This draws it right above the prompt, in the prompt's own colors and edge,
 * so it reads as the prompt's first line; it goes when the request is answered.
 * OpenChamber shows the message itself.
 */
export default Plugin.define({
  id: "opencode-guard.tui",
  setup(context) {
    const theme = context.theme
    /** The explanations of the sandbox module's own requests waiting in a session. */
    const explanations = (sessionID: string) =>
      (context.data.session.permission.list(sessionID) ?? []).flatMap((request) => {
        const input = request.metadata?.input as { unsandboxed?: unknown } | undefined
        return request.action === "shell" && input?.unsandboxed === true && request.message ? [request.message] : []
      })
    context.ui.slot({
      append: "session.composer.top",
      render: ({ sessionID }) => (
        <For each={explanations(sessionID)}>
          {(explanation) => (
            <box
              backgroundColor={theme.background.raised.base}
              border={["left"]}
              borderColor={theme.background.action.primary.focused}
              customBorderChars={EDGE}
              paddingLeft={2}
              paddingRight={3}
              paddingTop={1}
              flexDirection="row"
              gap={1}
            >
              <text fg={theme.text.feedback.warning.base} flexShrink={0}>
                ⚠
              </text>
              <text fg={theme.text.base}>{explanation}</text>
            </box>
          )}
        </For>
      ),
    })
  },
})
