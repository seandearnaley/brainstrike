import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import type { SceneTimelineState } from './scene-timeline';
import { WebGPUCanvas } from './webgpu-canvas';

describe('WebGPUCanvas status surface', () => {
  it('exposes initialization before the GPU transaction completes', () => {
    const markup = renderToStaticMarkup(
      createElement(WebGPUCanvas, {
        getSceneState: (): SceneTimelineState => ({
          activeStage: 0,
          bloom: 0,
          fromStage: 0,
          morph: 0,
          toStage: 0,
        }),
      })
    );

    expect(markup).toContain('data-webgpu-status="initializing"');
    expect(markup).not.toContain('VISUAL ENGINE / OFFLINE');
  });
});
