export const SCENE_FORMATIONS = [
  'signal',
  'ingest',
  'context',
  'route',
  'trace',
  'memory',
  'matrix',
  'resolve',
] as const;

export type SceneFormationId = (typeof SCENE_FORMATIONS)[number];

export const SCENE_FORMATION_GPU_INDEX = {
  context: 2,
  ingest: 1,
  matrix: 6,
  memory: 5,
  resolve: 7,
  route: 3,
  signal: 0,
  trace: 4,
} as const satisfies Readonly<Record<SceneFormationId, number>>;

export type SceneFormationIndex =
  (typeof SCENE_FORMATION_GPU_INDEX)[keyof typeof SCENE_FORMATION_GPU_INDEX];

const GPU_INDICES = new Set<number>(Object.values(SCENE_FORMATION_GPU_INDEX));

function isSceneFormationIndex(value: unknown): value is SceneFormationIndex {
  return typeof value === 'number' && Number.isInteger(value) && GPU_INDICES.has(value);
}

export function sceneFormationIndex(formation: SceneFormationId): SceneFormationIndex {
  const index: unknown = SCENE_FORMATION_GPU_INDEX[formation];
  if (!isSceneFormationIndex(index)) {
    throw new Error(`Unknown scene formation "${String(formation)}".`);
  }
  return index;
}

export function parseSceneFormationIndex(rawIndex: string | undefined): SceneFormationIndex {
  if (rawIndex === undefined) {
    throw new Error('Every scene anchor requires a GPU index.');
  }
  const index = Number(rawIndex);
  if (rawIndex !== String(index) || !isSceneFormationIndex(index)) {
    throw new Error(`Unsupported scene formation GPU index "${rawIndex}".`);
  }
  return index;
}
