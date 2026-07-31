import { describe, expect, it } from 'vitest';
import { computeSceneCamera } from './scene-camera';
import type { SceneTimelineState } from './scene-timeline';

const states: readonly SceneTimelineState[] = [
  { activeStage: 0, bloom: 0, fromStage: 0, morph: 0, toStage: 0 },
  { activeStage: 1, bloom: 1, fromStage: 0, morph: 0.5, toStage: 1 },
  { activeStage: 3, bloom: 0.8, fromStage: 2, morph: 0.7, toStage: 3 },
  { activeStage: 7, bloom: 0, fromStage: 7, morph: 0, toStage: 7 },
];

describe('computeSceneCamera', () => {
  it('keeps the camera plate fixed while formations change', () => {
    const cameras = states.map(computeSceneCamera);

    expect(new Set(cameras.map((camera) => camera.yaw)).size).toBe(1);
    expect(new Set(cameras.map((camera) => camera.pitch)).size).toBe(1);
    expect(new Set(cameras.map((camera) => camera.depth)).size).toBe(1);
    expect(new Set(cameras.map((camera) => camera.offsetX)).size).toBe(1);
  });

  it('uses a centered, closer camera so formations fill more of the fixed frame', () => {
    expect(computeSceneCamera(states[0]!)).toEqual({
      depth: -1.35,
      offsetX: 0,
      pitch: -0.08,
      yaw: -0.06,
    });
  });
});
