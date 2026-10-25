import { strictWireSchema } from '@brainstrike/assistant-contract/schema-boundary';
import { Schema } from 'effect';
import { UTILITY_PORT_EVENT } from '../lent-utility';

/**
 * ADR-0030 decision 1 over the platform connection: the host asks Main to fork an index utility,
 * Main transfers the utility's channel end to the host on the platform port itself (a frame that
 * is not JSON-RPC), and reports the utility's spawn, errors and joined exit.
 */
const UtilityId = Schema.String.check(Schema.isMinCodePoints(1));
export const PLATFORM_UTILITY_FORK = 'platform/utility/fork';
export const PlatformUtilityForkSchema = Schema.Struct({
  env: Schema.Record(Schema.String, Schema.String),
  kind: Schema.Literals(['indexer', 'index-query', 'index-coverage']),
  utilityId: UtilityId,
});
export const PLATFORM_UTILITY_KILL = 'platform/utility/kill';
export const PLATFORM_UTILITY_SPAWNED = 'platform/utility/spawned';
export const PLATFORM_UTILITY_ERRORED = 'platform/utility/errored';
export const PLATFORM_UTILITY_EXITED = 'platform/utility/exited';
export const PlatformUtilitySchema = Schema.Struct({ utilityId: UtilityId });
export const PlatformUtilitySpawnedSchema = Schema.Struct({
  pid: Schema.NullOr(Schema.Int),
  utilityId: UtilityId,
});
export const PlatformUtilityErroredSchema = Schema.Struct({
  location: Schema.String,
  report: Schema.String,
  type: Schema.String,
  utilityId: UtilityId,
});
export const PlatformUtilityExitedSchema = Schema.Struct({
  code: Schema.Int,
  utilityId: UtilityId,
});
/** The frame that carries a utility's channel end to the host. */
export const UtilityPortFrameSchema = strictWireSchema(
  Schema.Struct({ event: Schema.Literal(UTILITY_PORT_EVENT), utilityId: UtilityId })
);
