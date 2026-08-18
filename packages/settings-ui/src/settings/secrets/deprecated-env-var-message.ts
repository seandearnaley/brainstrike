/**
 * The ONE sentence that tells a user a retired environment name is being
 * ignored (BST-1361, shared in BST-1363).
 *
 * Both surfaces that report this fact — the Credential Inventory row and the
 * Environment section — call this function. They previously derived their own
 * wording AND their own rename target, which is how the row could advise
 * renaming to the vendor name while the Environment section advised the
 * `BRAINSTRIKE_*` override, on screen at the same time. One string, one
 * source: the caller supplies `replacement` from the shared
 * `DeprecatedEnvVarReport`, never from its own registry lookup.
 */
export interface DeprecatedEnvVarMessageOptions {
  readonly envVar: string;
  /**
   * The canonical name to rename to, from `DeprecatedEnvVarReport.replacement`
   * (the vendor-standard name). Omitted only when no report covers this name —
   * the sentence then states the fact without inventing a target.
   */
  readonly replacement?: string | undefined;
  /** Adds file provenance: the name is spelled in a loaded `.env` file. */
  readonly spelledInEnvFile?: boolean | undefined;
}

export function deprecatedEnvVarMessage({
  envVar,
  replacement,
  spelledInEnvFile = false,
}: DeprecatedEnvVarMessageOptions): string {
  const rename = replacement ? ` — rename it to ${replacement}` : '';
  const provenance = spelledInEnvFile ? ' Your environment file still spells it.' : '';
  return `${envVar} is set but no longer read${rename}.${provenance}`;
}
