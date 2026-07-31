import { useCallback, useEffect, useRef, useState } from 'react';
import {
  computeSceneTimeline,
  normalizeSceneAnchors,
  SCENE_CHANGE_EVENT,
  type SceneAnchor,
  type SceneTimelineState,
} from './scene-timeline';

const INITIAL_STATE: SceneTimelineState = {
  activeStage: 0,
  bloom: 0,
  fromStage: 0,
  morph: 0,
  toStage: 0,
};

interface SceneTimelineController {
  readonly activeStage: number;
  readonly getSceneState: () => SceneTimelineState;
}

function measureAnchors(): readonly SceneAnchor[] {
  const elements = document.querySelectorAll<HTMLElement>('[data-scene-anchor]');
  const anchors = [...elements].map((element): SceneAnchor => {
    const rawStage = element.dataset['sceneStage'];
    const stage = rawStage === undefined ? Number.NaN : Number.parseInt(rawStage, 10);
    if (!Number.isInteger(stage)) {
      throw new Error('Every scene anchor requires an integer data-scene-stage.');
    }
    return {
      documentY: element.getBoundingClientRect().top + window.scrollY,
      id: element.id,
      stage,
    };
  });
  return normalizeSceneAnchors(anchors);
}

export function useSceneTimeline(): SceneTimelineController {
  const stateRef = useRef<SceneTimelineState>(INITIAL_STATE);
  const anchorsRef = useRef<readonly SceneAnchor[]>([]);
  const updateFrameRef = useRef<number | null>(null);
  const [activeStage, setActiveStage] = useState(0);

  const update = useCallback((): void => {
    updateFrameRef.current = null;
    const next = computeSceneTimeline(anchorsRef.current, window.scrollY, window.innerHeight);
    stateRef.current = next;
    window.dispatchEvent(new Event(SCENE_CHANGE_EVENT));
    setActiveStage((current) => (current === next.activeStage ? current : next.activeStage));
  }, []);

  const scheduleUpdate = useCallback((): void => {
    if (updateFrameRef.current !== null) {
      return;
    }
    updateFrameRef.current = requestAnimationFrame(update);
  }, [update]);

  const measure = useCallback((): void => {
    anchorsRef.current = measureAnchors();
    scheduleUpdate();
  }, [scheduleUpdate]);

  useEffect(() => {
    measure();
    window.addEventListener('scroll', scheduleUpdate, { passive: true });
    window.addEventListener('resize', measure);
    const observer = new ResizeObserver(measure);
    const main = document.querySelector('main');
    if (main) {
      observer.observe(main);
    }
    void document.fonts.ready.then(measure);

    return () => {
      window.removeEventListener('scroll', scheduleUpdate);
      window.removeEventListener('resize', measure);
      observer.disconnect();
      if (updateFrameRef.current !== null) {
        cancelAnimationFrame(updateFrameRef.current);
        updateFrameRef.current = null;
      }
    };
  }, [measure, scheduleUpdate]);

  const getSceneState = useCallback(() => stateRef.current, []);
  return { activeStage, getSceneState };
}
