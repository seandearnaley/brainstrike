# ADR-0025: Agent browsing connects only through an address-checking egress proxy

- **Status:** Accepted (Sean delegated the call, 2026-10-18: "whatever you recommend")
- **Date:** 2026-10-18
- **Ticket:** BST-1238; design comment on the ticket
- **Related:** BST-1175 and BST-1178 (dev-server preview and per-origin grants)

## Context

`browser_navigate` and the page-read tools need no approval. Before this
decision, agent navigation checked only the initial URL's literal host
(`refuseExtractUrl`, written for an off-device fetch). Local Chromium then
resolved DNS and followed server redirects, client navigations and popups
itself, so a public page could land the agent on loopback, the LAN or a cloud
metadata service and read it back to the model.

Electron 44's `webRequest` reports a server address only for redirects and has
no DNS hook, so it cannot refuse a connection by where it goes. A hostname
check before a load loses to DNS rebinding, and approving a public URL says
nothing about where it redirects.

## Decision

1. **Agent tabs are their own tabs, on their own partition.** A tab's owner is
   `user` or `agent`. The agent opens and drives only `agent` tabs, on the
   in-memory `browser-pane-agent` partition; it never navigates a tab the user
   opened. A popup keeps its opener's owner. User tabs stay on
   `persist:browser-pane`, unproxied.
2. **The agent partition's only route out is the egress proxy.** It runs in a
   utility process and listens on loopback with a per-launch Basic credential,
   which Main answers through `app` `login` for that address only. The
   partition's `setProxy` uses `proxyBypassRules: '<-loopback>'`, removing
   Chromium's implicit direct route to localhost and link-local (proven
   necessary: without it a redirect reached loopback directly). Agent tabs
   confine WebRTC to proxied UDP.
3. **The proxy decides by resolved address, at connection time.** For each
   `CONNECT` and absolute-form request it resolves once, refuses if any answer
   is special-use (`node:net` `BlockList`, IANA special-purpose ranges, IPv6
   outside global unicast, and IPv4 carried in IPv6), then dials the checked
   address, never the hostname. One deadline covers resolution and every
   connect attempt.
4. **Refusals are visible and typed.** A refused navigation fails as
   `blocked_destination` and names the host and address class; the agent never
   reads a blank page in its place.
5. **Reset clears the agent partition** with the app and pane sessions.

## Consequences

- The agent cannot reach loopback, including dev servers, until BST-1175 and
  BST-1178 add an explicit, user-granted per-origin exemption. That grant
  belongs in the proxy's policy, not in a bypass rule.
- Agent browsing has no cookies or logins from the user's tabs, and none
  survive a relaunch.
- The boundary belongs to the tab, not to who drives it: a URL the user types
  into an agent tab also goes through the proxy. The user's own tabs never do.
- The read tools still read the active tab, whoever owns it. An agent tab's
  content was admitted by the proxy; a user tab's content was navigated by the
  user.
- Evidence: `apps/desktop/src/__tests__/main/agent-browsing-egress.integration.test.ts`
  runs Main's pane host, routing and agent tools in real Chromium against
  server redirects, client redirects, popups and direct loopback loads.
