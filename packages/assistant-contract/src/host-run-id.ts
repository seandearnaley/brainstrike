/**
 * The durable host run id (docs/agents/assistant-persistence.md, "runId
 * provenance"): `run-` followed by a UUIDv4, minted once per run by
 * `createThreadRunId` in `@brainstrike/app-shell`.
 *
 * `HostRunId` is branded so that the brand records where the id came from.
 * The thread-run repository's `createThreadRun` accepts only a `HostRunId`, and
 * the one sanctioned way to make one is the `as HostRunId` assertion inside
 * `createThreadRunId`. `scripts/assistant-run-id-producer-guard.mjs` rejects
 * that assertion, or a `HostRunId` type argument, in any other production
 * module, so a second minter cannot create a thread run unseen.
 *
 * The brand is type-only (docs/agents/effect-boundary.md § "Schema at
 * boundaries"). The minter runs in the renderer, and a runtime Schema check of
 * a `crypto.randomUUID()` result would add Schema to the renderer bundle for a
 * value that cannot be malformed. Ids read back from storage stay `string`.
 */
import type { Brand } from 'effect';

export type HostRunId = string & Brand.Brand<'HostRunId'>;
