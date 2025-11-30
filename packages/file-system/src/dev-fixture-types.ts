export type FixtureTree = {
  [name: string]: string | FixtureTree;
};

export type FixtureDefinition = {
  name: string;
  tree: FixtureTree;
};
