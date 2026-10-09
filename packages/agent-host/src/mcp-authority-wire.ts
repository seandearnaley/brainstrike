/**
 * An MCP tool's server authority on the host protocol: what a configured
 * server's tools may run under. protocol.ts re-exports every name here.
 */
import { z } from 'zod';

const Id = z.string().min(1);
const McpAuthorityBase = {
  extensions: z.strictObject({ apps: z.boolean(), tasks: z.boolean() }),
  protocol: z.enum(['legacy', 'auto', '2026-07-28']),
  version: z.literal(1),
};
/** Supplied by the configured-server owner; private values have no durable surrogate. */
export const McpToolAuthoritySchema = z.discriminatedUnion('kind', [
  z.strictObject({
    ...McpAuthorityBase,
    auth: z.discriminatedUnion('type', [
      z.strictObject({ type: z.literal('none') }),
      z.strictObject({
        credential: z.strictObject({ id: z.uuid(), store: z.literal('mcp-credentials') }),
        principalComparison: z.literal('unavailable'),
        type: z.literal('bearer'),
      }),
    ]),
    destination: z.url(),
    kind: z.literal('http'),
    transport: z.enum(['streamable-http', 'sse']),
  }),
  z.strictObject({
    ...McpAuthorityBase,
    args: z.tuple([]),
    command: Id,
    cwd: Id,
    kind: z.literal('stdio'),
  }),
  z.strictObject({
    kind: z.literal('unavailable'),
    reason: z.enum([
      'private-stdio-arguments',
      'private-stdio-environment',
      'unresolved-stdio-command',
      'private-http-headers',
      'private-http-destination',
      'oauth-principal-not-comparable',
    ]),
    version: z.literal(1),
  }),
]);
export type McpToolAuthority = z.infer<typeof McpToolAuthoritySchema>;
