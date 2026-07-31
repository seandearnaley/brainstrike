import type { SceneTimelineState } from './scene-timeline';

export interface SceneCamera {
  readonly depth: number;
  readonly offsetX: number;
  readonly pitch: number;
  readonly yaw: number;
}

const FIXED_SCENE_CAMERA: SceneCamera = {
  depth: -1.35,
  offsetX: 0,
  pitch: -0.08,
  yaw: -0.06,
};

export function computeSceneCamera(_scene: SceneTimelineState): SceneCamera {
  return FIXED_SCENE_CAMERA;
}
