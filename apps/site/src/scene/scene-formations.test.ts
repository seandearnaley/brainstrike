import { describe, expect, it } from 'vitest';
import {
  parseSceneFormationIndex,
  SCENE_FORMATION_GPU_INDEX,
  SCENE_FORMATIONS,
  type SceneFormationId,
  sceneFormationIndex,
} from './scene-formations';

describe('scene formation contract', () => {
  it('keeps named formations in their stable narrative order', () => {
    expect(SCENE_FORMATIONS).toEqual([
      'signal',
      'ingest',
      'context',
      'route',
      'trace',
      'memory',
      'matrix',
      'resolve',
    ]);
  });

  it('maps every named formation exhaustively to the existing GPU ABI', () => {
    expect(SCENE_FORMATION_GPU_INDEX).toEqual({
      context: 2,
      ingest: 1,
      matrix: 6,
      memory: 5,
      resolve: 7,
      route: 3,
      signal: 0,
      trace: 4,
    });
    expect(Object.keys(SCENE_FORMATION_GPU_INDEX).sort()).toEqual([...SCENE_FORMATIONS].sort());
  });

  it('resolves every named formation through the checked mapping', () => {
    for (const [expectedIndex, formation] of SCENE_FORMATIONS.entries()) {
      expect(sceneFormationIndex(formation)).toBe(expectedIndex);
    }
  });

  it('rejects unknown named and serialized formation values', () => {
    expect(() => sceneFormationIndex('unknown' as SceneFormationId)).toThrow(
      'Unknown scene formation'
    );
    expect(() => parseSceneFormationIndex(undefined)).toThrow('requires a GPU index');
    expect(() => parseSceneFormationIndex('')).toThrow('Unsupported scene formation GPU index');
    expect(() => parseSceneFormationIndex('8')).toThrow('Unsupported scene formation GPU index');
    expect(() => parseSceneFormationIndex('1.5')).toThrow('Unsupported scene formation GPU index');
    expect(() => parseSceneFormationIndex(' 1')).toThrow('Unsupported scene formation GPU index');
  });
});
