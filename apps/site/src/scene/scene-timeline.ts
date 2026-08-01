import type { SceneFormationIndex } from './scene-formations';

export interface SceneAnchor {
  readonly documentY: number;
  readonly id: string;
  readonly stage: SceneFormationIndex;
}

export interface SceneTimelineState {
  readonly activeStage: SceneFormationIndex;
  readonly bloom: number;
  readonly fromStage: SceneFormationIndex;
  readonly morph: number;
  readonly toStage: SceneFormationIndex;
}

export interface SceneTimelineFrame {
  readonly activeAnchorId: string | null;
  readonly scene: SceneTimelineState;
}

export const SCENE_CHANGE_EVENT = 'brainstrike:site-scene-change';

const TRANSITION_START = 0.18;
const TRANSITION_END = 0.78;

function clamp01(value: number): number {
  return Math.min(1, Math.max(0, value));
}

export function smoothstep(value: number): number {
  const clamped = clamp01(value);
  return clamped * clamped * (3 - 2 * clamped);
}

export function settleSceneTimeline(state: SceneTimelineState): SceneTimelineState {
  return {
    activeStage: state.activeStage,
    bloom: 0,
    fromStage: state.activeStage,
    morph: 0,
    toStage: state.activeStage,
  };
}

function settledState(stage: SceneFormationIndex): SceneTimelineState {
  return {
    activeStage: stage,
    bloom: 0,
    fromStage: stage,
    morph: 0,
    toStage: stage,
  };
}

function settledFrame(anchor: SceneAnchor): SceneTimelineFrame {
  return { activeAnchorId: anchor.id, scene: settledState(anchor.stage) };
}

export function computeSceneFrame(
  anchors: readonly SceneAnchor[],
  scrollY: number,
  viewportHeight: number,
  readingLineRatio = 0.52
): SceneTimelineFrame {
  if (anchors.length === 0) {
    return { activeAnchorId: null, scene: settledState(0) };
  }

  const first = anchors[0];
  const last = anchors.at(-1);
  if (!(first && last)) {
    return { activeAnchorId: null, scene: settledState(0) };
  }

  const readingY = scrollY + viewportHeight * readingLineRatio;
  if (readingY <= first.documentY) {
    return settledFrame(first);
  }
  if (readingY >= last.documentY) {
    return settledFrame(last);
  }

  for (let index = 0; index < anchors.length - 1; index += 1) {
    const from = anchors[index];
    const to = anchors[index + 1];
    if (!(from && to) || readingY > to.documentY) {
      continue;
    }

    const distance = to.documentY - from.documentY;
    if (distance <= 0) {
      throw new Error('Scene anchors must be strictly ordered by document position.');
    }

    const segmentProgress = clamp01((readingY - from.documentY) / distance);
    if (segmentProgress <= TRANSITION_START) {
      return settledFrame(from);
    }
    if (segmentProgress >= TRANSITION_END) {
      return settledFrame(to);
    }

    const transitionProgress =
      (segmentProgress - TRANSITION_START) / (TRANSITION_END - TRANSITION_START);
    const morph = smoothstep(transitionProgress);
    return {
      activeAnchorId: morph < 0.5 ? from.id : to.id,
      scene: {
        activeStage: morph < 0.5 ? from.stage : to.stage,
        bloom: Math.sin(morph * Math.PI),
        fromStage: from.stage,
        morph,
        toStage: to.stage,
      },
    };
  }

  return settledFrame(last);
}

export function computeSceneTimeline(
  anchors: readonly SceneAnchor[],
  scrollY: number,
  viewportHeight: number,
  readingLineRatio = 0.52
): SceneTimelineState {
  return computeSceneFrame(anchors, scrollY, viewportHeight, readingLineRatio).scene;
}

export function normalizeSceneAnchors(anchors: readonly SceneAnchor[]): readonly SceneAnchor[] {
  const ordered = anchors.toSorted((left, right) => left.documentY - right.documentY);
  for (let index = 1; index < ordered.length; index += 1) {
    if (ordered[index]?.documentY === ordered[index - 1]?.documentY) {
      throw new Error('Scene anchors cannot share the same document position.');
    }
  }
  return ordered;
}
