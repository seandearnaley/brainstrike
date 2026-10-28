import { isAbsolute } from 'node:path';
import { Schema } from 'effect';

const CredentialFilePath = Schema.String.check(
  Schema.makeFilter((value) =>
    isAbsolute(value)
      ? undefined
      : { issue: 'An explicit absolute credential file is required', path: [] }
  )
);

/** Trusted launch selection only; values and credentials stay in the adapter. */
export const HostPlatformLaunchOptionsSchema = Schema.Struct({
  appPaths: Schema.optional(
    Schema.Struct({
      isPackaged: Schema.Boolean,
      resourcesPath: Schema.String.check(
        Schema.makeFilter((value) =>
          isAbsolute(value)
            ? undefined
            : { issue: 'The app resources path must be absolute', path: [] }
        )
      ),
      userDataPath: Schema.String.check(
        Schema.makeFilter((value) =>
          isAbsolute(value)
            ? undefined
            : { issue: 'The app user-data path must be absolute', path: [] }
        )
      ),
    })
  ),
  credentialStore: Schema.optional(
    Schema.Union(
      [
        Schema.Struct({
          kind: Schema.Literal('keyring'),
          service: Schema.String.check(Schema.isMinCodePoints(1)),
        }),
        Schema.Struct({ kind: Schema.Literal('file'), path: CredentialFilePath }),
        // Values sealed by the cipher the launching platform lends (desktop: safeStorage).
        Schema.Struct({ kind: Schema.Literal('sealed-file'), path: CredentialFilePath }),
      ],
      { mode: 'oneOf' }
    )
  ),
  envFileFailures: Schema.optional(
    Schema.mutable(
      Schema.Array(
        Schema.Struct({
          code: Schema.Literals(['env_file_invalid', 'env_file_unreadable']),
          file: Schema.Literals(['dev', 'dev-local', 'user-data']),
          message: Schema.String.check(Schema.isMinCodePoints(1)),
        })
      )
    )
  ),
  mcpConfig: Schema.optional(
    Schema.Struct({
      path: Schema.String.check(
        Schema.makeFilter((value) =>
          isAbsolute(value)
            ? undefined
            : { issue: 'An explicit absolute MCP config file is required', path: [] }
        )
      ),
    })
  ),
  workspaceRoots: Schema.optional(
    Schema.mutable(
      Schema.Array(
        Schema.String.check(
          Schema.makeFilter((value) =>
            isAbsolute(value)
              ? undefined
              : { issue: 'Workspace roots must be absolute paths', path: [] }
          )
        )
      )
    ).check(Schema.isMinLength(1))
  ),
});
export type HostPlatformLaunchOptions = (typeof HostPlatformLaunchOptionsSchema)['Type'];
export type HostEnvFileFailure = NonNullable<HostPlatformLaunchOptions['envFileFailures']>[number];
