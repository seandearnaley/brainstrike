export interface FixtureTree {
  [name: string]: string | FixtureTree;
}

export interface FixtureDefinition {
  name: string;
  tree: FixtureTree;
}
