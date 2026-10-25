import { HostPlatformLaunchOptionsSchema } from '@brainstrike/agent-host/platform-launch-options';
import { makeThrowingDecoder } from '@brainstrike/effect-kit';
import { Schema } from 'effect';

/** What the host child reports to Main in its `host/message` notifications. */
const ChildMessageSchema = Schema.Union([
  Schema.Struct({ event: Schema.Literal('ready') }),
  Schema.Struct({
    event: Schema.Literal('failed'),
    kind: Schema.Literals(['root-locked', 'foreign-lock', 'error']),
    message: Schema.String,
  }),
  Schema.Struct({
    deletedChunks: Schema.NullOr(Schema.Int.check(Schema.isGreaterThanOrEqualTo(0))),
    deletedFiles: Schema.Int.check(Schema.isGreaterThanOrEqualTo(0)),
    event: Schema.Literal('content-cleared'),
  }),
]);
export type HostChildMessage = typeof ChildMessageSchema.Type;
export const decodeHostChildMessage = makeThrowingDecoder(ChildMessageSchema, {
  onExcessProperty: 'error',
});

/**
 * Main's controls, as an LSP client's `shutdown`: the host closes while its stdio is still
 * open, because its close still answers to Main (its MCP join, the git index refresh,
 * its diagnostics). Its stdin's end is the client gone.
 */
const ControlSchema = Schema.Struct({ method: Schema.Literals(['close', 'clear-content']) });
export type HostChildControl = typeof ControlSchema.Type;
export const decodeHostChildControl = makeThrowingDecoder(ControlSchema, {
  onExcessProperty: 'error',
});
const ArgsSchema = Schema.Struct({
  modulePath: Schema.String.check(Schema.isMinLength(1)),
  platformOptions: Schema.optional(HostPlatformLaunchOptionsSchema),
  root: Schema.String.check(Schema.isPattern(/^[^\r\n\0]{1,4096}$/)),
});
export type HostChildArgs = typeof ArgsSchema.Type;
const decodeArgs = makeThrowingDecoder(ArgsSchema, { onExcessProperty: 'error' });
/** The child's one argument: its root, platform module and launch options, as JSON. */
export function encodeHostChildArgs(args: HostChildArgs): string[] {
  return [JSON.stringify(args)];
}
export function decodeHostChildArgs(argv: readonly string[]): HostChildArgs {
  if (argv.length !== 1) {
    throw new Error('The host child takes exactly one argument');
  }
  return decodeArgs(JSON.parse(argv[0] ?? 'null'));
}
