import { Schema, SchemaGetter } from 'effect';

/**
 * Host -> client: a UI action only the connected desktop client performs. The
 * one external opener for every host feature (OAuth sign-in, MCP authorization).
 */
export const CLIENT_OPEN_EXTERNAL = 'client/open-external';
export const ClientOpenExternalParamsSchema = Schema.Struct({
  url: Schema.Trim.pipe(
    Schema.decode({
      decode: SchemaGetter.transform((value) => value.replaceAll(/[\t\n\r]/gu, '')),
      encode: SchemaGetter.passthrough(),
    })
  ).check(Schema.makeFilter((value) => (URL.canParse(value) ? undefined : 'Invalid URL'))),
});
export const ClientOpenExternalResultSchema = Schema.Struct({ opened: Schema.Literal(true) });
