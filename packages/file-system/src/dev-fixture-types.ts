export interface FixtureTree {
  [name: string]: string | FixtureTree | null;
}

export interface FixtureDefinition {
  name: string;
  /**
   * Optional DURABLE rootId. When set, loadInlineFixture stamps THIS id every
   * time the fixture loads — including across separate adapter instances (a
   * cold page reload constructs a fresh adapter, wiping the per-session name
   * map). File selections persist keyed by rootId (`folderStates[rootId]`), so
   * a per-boot `crypto.randomUUID()` orphans them on every reload; a fixed id
   * keeps ONE identity so the reload reconciles and selections survive. Must be
   * a stable value generated ONCE (a hardcoded crypto.randomUUID), never
   * derived from `name` — see the RootId contract in
   * `packages/types/src/file-system.ts`. Must be a well-formed UUID and unique
   * per fixture: it is validated at load and rejected if malformed, and a
   * duplicate across active roots is rejected (the reducer's identity is
   * rootId-only, so a shared id merges two roots). Omit for throwaway/ad-hoc
   * fixtures (multi-root harness roots, unit-test fixtures) that are never
   * persisted.
   */
  rootId?: string;
  tree: FixtureTree;
}

export interface FixtureLoadOptions {
  directoryReadDelayMs?: number;
}
