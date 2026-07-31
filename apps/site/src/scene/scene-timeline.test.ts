import { describe, expect, it } from 'vitest';
import {
  computeSceneTimeline,
  normalizeSceneAnchors,
  type SceneAnchor,
  smoothstep,
} from './scene-timeline';

const anchors: readonly SceneAnchor[] = [
  { documentY: 500, id: 'signal', stage: 0 },
  { documentY: 1500, id: 'context', stage: 1 },
  { documentY: 2500, id: 'routes', stage: 2 },
];

describe('computeSceneTimeline', () => {
  it('holds a formation before and after the bounded transition window', () => {
    expect(computeSceneTimeline(anchors, 0, 1000)).toMatchObject({
      fromStage: 0,
      morph: 0,
      toStage: 0,
    });
    expect(computeSceneTimeline(anchors, 980, 1000)).toMatchObject({
      fromStage: 1,
      morph: 0,
      toStage: 1,
    });
  });

  it('morphs deterministically between adjacent formations and blooms at midpoint', () => {
    const first = computeSceneTimeline(anchors, 460, 1000);
    const second = computeSceneTimeline(anchors, 460, 1000);
    expect(first).toEqual(second);
    expect(first.fromStage).toBe(0);
    expect(first.toStage).toBe(1);
    expect(first.morph).toBeCloseTo(0.5, 6);
    expect(first.bloom).toBeCloseTo(1, 6);
  });

  it('lands the final formation after the last measured anchor', () => {
    expect(computeSceneTimeline(anchors, 2400, 1000)).toEqual({
      activeStage: 2,
      bloom: 0,
      fromStage: 2,
      morph: 0,
      toStage: 2,
    });
  });

  it('returns the initial formation when no anchors exist', () => {
    expect(computeSceneTimeline([], 100, 900).activeStage).toBe(0);
  });
});

describe('scene timeline utilities', () => {
  it('uses a monotonic easing curve with stable endpoints', () => {
    expect(smoothstep(-1)).toBe(0);
    expect(smoothstep(0.5)).toBe(0.5);
    expect(smoothstep(2)).toBe(1);
  });

  it('orders anchors and rejects ambiguous positions', () => {
    expect(normalizeSceneAnchors([anchors[2]!, anchors[0]!, anchors[1]!])).toEqual(anchors);
    expect(() =>
      normalizeSceneAnchors([
        anchors[0]!,
        { documentY: anchors[0]!.documentY, id: 'duplicate', stage: 7 },
      ])
    ).toThrow('cannot share');
  });
});
