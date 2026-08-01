import { useEffect, useRef, useState } from 'react';
import type { SceneTimelineState } from './scene-timeline';
import { WebGPUScene } from './webgpu-scene';

interface WebGPUCanvasProps {
  readonly getSceneState: () => SceneTimelineState;
}

type WebGPUCanvasState =
  | { readonly status: 'initializing' }
  | { readonly status: 'ready' }
  | { readonly error: string; readonly status: 'failed' };

export function WebGPUCanvas({ getSceneState }: WebGPUCanvasProps) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const [state, setState] = useState<WebGPUCanvasState>({ status: 'initializing' });

  // biome-ignore lint/plugin: The external WebGPU lifecycle reports its asynchronous ready and failure states to React.
  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) {
      return;
    }
    let cancelled = false;
    const surfaceFailure = (error: Error): void => {
      if (cancelled) {
        return;
      }
      setState({ error: error.message, status: 'failed' });
    };
    const scene = new WebGPUScene({
      canvas,
      getSceneState,
      onError: surfaceFailure,
    });
    void scene.initialize().then(
      () => {
        if (!cancelled) {
          setState({ status: 'ready' });
        }
      },
      (error: unknown) => {
        surfaceFailure(error instanceof Error ? error : new Error(String(error)));
      }
    );
    return () => {
      cancelled = true;
      scene.stop();
    };
  }, [getSceneState]);

  return (
    <>
      <div className="visual-system" data-testid="visual-system" data-webgpu-status={state.status}>
        <canvas
          aria-hidden={state.status === 'failed' ? true : undefined}
          aria-label="A live spatial visualization of the Brainstrike processing system"
          className="signal-canvas"
          ref={canvasRef}
          role="img"
        />
      </div>
      {state.status === 'failed' ? (
        <div className="gpu-failure" role="alert">
          <span className="eyebrow">VISUAL ENGINE / OFFLINE</span>
          <strong>WebGPU could not initialize.</strong>
          <p>{state.error}</p>
          <a href="https://webgpu.org/" rel="noreferrer" target="_blank">
            Check browser support <span aria-hidden="true">↗</span>
          </a>
        </div>
      ) : null}
    </>
  );
}
