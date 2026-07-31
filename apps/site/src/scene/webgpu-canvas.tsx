import { useEffect, useRef } from 'react';
import type { SceneTimelineState } from './scene-timeline';
import { WebGPUScene } from './webgpu-scene';

interface WebGPUCanvasProps {
  readonly getSceneState: () => SceneTimelineState;
}

export function WebGPUCanvas({ getSceneState }: WebGPUCanvasProps) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const failureRef = useRef<HTMLDivElement>(null);
  const failureMessageRef = useRef<HTMLParagraphElement>(null);

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
      if (failureMessageRef.current) {
        failureMessageRef.current.textContent = error.message;
      }
      if (failureRef.current) {
        failureRef.current.hidden = false;
      }
    };
    const scene = new WebGPUScene({
      canvas,
      getSceneState,
      onError: surfaceFailure,
    });
    void scene.initialize().catch((error: unknown) => {
      surfaceFailure(error instanceof Error ? error : new Error(String(error)));
    });
    return () => {
      cancelled = true;
      scene.stop();
    };
  }, [getSceneState]);

  return (
    <div className="visual-system" data-testid="visual-system">
      <canvas
        aria-label="A live spatial visualization of the Brainstrike processing system"
        className="signal-canvas"
        ref={canvasRef}
        role="img"
      />
      <div className="gpu-failure" hidden ref={failureRef} role="alert">
        <span className="eyebrow">VISUAL ENGINE / OFFLINE</span>
        <strong>WebGPU could not initialize.</strong>
        <p ref={failureMessageRef}>The visual engine stopped before reporting an error.</p>
        <a href="https://webgpu.org/" rel="noreferrer" target="_blank">
          Check browser support <span aria-hidden="true">↗</span>
        </a>
      </div>
    </div>
  );
}
