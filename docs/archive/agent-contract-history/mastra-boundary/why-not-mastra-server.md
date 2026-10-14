# Why Mastra Server was not adopted — evidence

Supports `docs/agents/mastra-boundary.md` § "Why not Mastra Server". Read this
before proposing a Mastra server adapter. Measurements below are against core
1.51; the conclusion was re-verified at 1.59 (see `upgrade-1-59.md`) and the
installed pin is 1.64.0.


The historical framing — "adopting Mastra means adopting a generated Hono app" —
is **false at 1.51**. `@mastra/core` ships no HTTP server: its compiled output
contains no `http.createServer`, no `Bun.serve`, and no HTTP `.listen(` (the only
`.listen()` calls are an LSP connection, a voice provider, and an opt-in
Unix-domain-socket pubsub subpath). `Config.server` is inert configuration until a
separate adapter package calls `mastra.setMastraServer(...)`.

Precisely, on the dependency question — the loose phrasing "hono and express are
not dependencies" is wrong in both directions and was corrected in review:

- `hono@4.12.27` **is** in the lockfile, but only via `@vercel/hono` and
  `@hono/node-server` (Vercel CLI tooling). Nothing links it to Mastra.
- `express@5.2.1` **is** resolved inside `@mastra/core`'s peer suffix, via
  `@a2a-js/sdk@0.3.14` — a real dependency of core — where express is an
  **optional** peer (`peerDependenciesMeta.express.optional: true`).

Neither fact weakens R1: an optional peer that core never starts is not an HTTP
surface. But the ruling rests on "core ships no server", not on "express is
absent from the tree", and the guard tests assert the former.

So there was never a cost to *not* adopting it, and adoption today would add a
package while moving ownership of auth, CORS, secrets, and the desktop loopback
lifecycle for no capability Brainstrike lacks. Rejected on cost, not on risk.

**Do not relitigate** without a named capability that requires an adapter.

