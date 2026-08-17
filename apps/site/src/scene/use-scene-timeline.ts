import { useCallback, useEffect, useRef, useState } from 'react';
import { stageIdFromSceneAnchor } from '../content/product-story';
import { parseSceneFormationIndex } from './scene-formations';
import {
  computeSceneFrame,
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
  readonly activeStageId: string | null;
  readonly getSceneState: () => SceneTimelineState;
}

function measureAnchors(): readonly SceneAnchor[] {
  const elements = document.querySelectorAll<HTMLElement>('[data-scene-anchor]');
  const anchors = [...elements].map(
    (element): SceneAnchor => ({
      documentY: element.getBoundingClientRect().top + window.scrollY,
      id: element.id,
      stage: parseSceneFormationIndex(element.dataset['sceneStage']),
    })
  );
  return normalizeSceneAnchors(anchors);
}

export function useSceneTimeline(): SceneTimelineController {
  const stateRef = useRef<SceneTimelineState>(INITIAL_STATE);
  const anchorsRef = useRef<readonly SceneAnchor[]>([]);
  const updateFrameRef = useRef<number | null>(null);
  const [activeStageId, setActiveStageId] = useState<string | null>(null);

  const update = useCallback((): void => {
    updateFrameRef.current = null;
    const next = computeSceneFrame(anchorsRef.current, window.scrollY, window.innerHeight);
    stateRef.current = next.scene;
    window.dispatchEvent(new Event(SCENE_CHANGE_EVENT));
    // Scene anchors carry `${stageId}-scene` DOM ids; the rail keys on plain
    // stage ids, so translate before publishing (BST product-site review).
    const nextStageId =
      next.activeAnchorId === null ? null : stageIdFromSceneAnchor(next.activeAnchorId);
    setActiveStageId((current) => (current === nextStageId ? current : nextStageId));
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
    let active = true;
    measure();
    window.addEventListener('scroll', scheduleUpdate, { passive: true });
    window.addEventListener('resize', measure);
    const observer = new ResizeObserver(measure);
    const main = document.querySelector('main');
    if (main) {
      observer.observe(main);
    }
    void document.fonts.ready.then(() => {
      if (active) {
        measure();
      }
    });

    return () => {
      active = false;
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
  return { activeStageId, getSceneState };
}
