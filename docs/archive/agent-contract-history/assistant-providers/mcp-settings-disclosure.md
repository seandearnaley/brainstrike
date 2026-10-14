# MCP Settings progressive disclosure — evidence

Supports `docs/agents/assistant-providers.md` § "MCP Settings progressive disclosure". What stays visible on the server row and what moves inside the disclosure.

The contract holds the rules; this file is the record behind them. Extracted
verbatim from the pre-distillation contract (lines 5075-5092); append rather than
rewrite.

---

The server row keeps lifecycle state, available controls, tool-availability
failures, catalog content, server/control errors, and malformed or unreadable
credential notices visible. Stdio/client diagnostics stay visible for error and
authentication-required states; healthy-server logs are inside the disclosure.
Protocol policy/generation, OAuth facts, and effective extension advertisements
live inside a native `details` disclosure labeled "Connection details". Failure
diagnostics do not force it open or override the user's DOM-resident open state.
Credential faults use the shared state labels and a persistent polite status region.
The credential status region remains mounted while its content changes, so
later credential faults update an existing live region. Initial faults remain
visibly rendered; automatic initial screen-reader announcement is not promised.
`mcp-connection-details.test.tsx` pins node identity and both fault wordings.
These facts remain available without an additional host call or persistent UI
store. Expanding details never initiates authorization or a lifecycle control.
The disclosure resets on a new server generation; current snapshot facts remain
the sole authority. `mcp-connection-details.test.tsx` covers visibility, recovery
controls, and local expansion. The dated BST-1630 audit records real Electron
keyboard/focus and layout measurements for the production component.
