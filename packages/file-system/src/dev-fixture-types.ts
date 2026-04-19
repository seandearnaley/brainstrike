export interface FixtureTree {
  [name: string]: string | FixtureTree | null;
}

export interface FixtureDefinition {
  name: string;
  tree: FixtureTree;
}

export interface FixtureLoadOptions {
  directoryReadDelayMs?: number;
}
