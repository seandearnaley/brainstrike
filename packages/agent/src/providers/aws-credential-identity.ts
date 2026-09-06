/**
 * The AWS credential-identity SHAPE (BST-1353), declared here with ZERO
 * imports so the browser-reachable auth seam (`provider-auth-input.ts`) can
 * type its `credentialProvider` without any edge — not even a type-only one —
 * to the Node-only `@aws-sdk/credential-providers` package.
 *
 * FIDELITY IS COMPILE-CHECKED, not asserted by comment: `createAwsCredentialChain`
 * (aws-credential-chain.ts) declares this type as its RETURN type while
 * returning the SDK's own `fromNodeProviderChain(...)` result, so a drift
 * between this declaration and the real `AwsCredentialIdentityProvider` from
 * `@smithy/types` is a red build at that return statement. That indirection
 * exists because `@smithy/types` is a transitive package: it is not resolvable
 * from `packages/agent`, so `import type` from it would not compile.
 *
 * Fields mirror `@smithy/types`' `AwsCredentialIdentity`. The optional members
 * are declared because the SDK POPULATES them; nothing here reads them.
 */

export interface AwsCredentialIdentity {
  readonly accessKeyId: string;
  readonly accountId?: string;
  readonly credentialScope?: string;
  readonly expiration?: Date;
  readonly secretAccessKey: string;
  readonly sessionToken?: string;
}

/**
 * A per-request credential resolver. Invoked LAZILY by
 * `@ai-sdk/amazon-bedrock` when it signs a request, which is why chain
 * failures surface at request time rather than at model construction — see
 * the failure-mapping block in aws-credential-chain.ts.
 */
export type AwsCredentialIdentityProvider = () => Promise<AwsCredentialIdentity>;
