import { describe, expect, it } from 'vitest';
import {
  PRODUCT_HEADER_NAV,
  PRODUCT_STAGE_RAIL,
  PRODUCT_STORY,
  STORY_CHAPTERS,
  sceneAnchorId,
} from './product-story';

describe('product story registry', () => {
  it('owns the complete ordered narrative in one registry', () => {
    expect(PRODUCT_STORY.map((stage) => stage.id)).toEqual([
      'signal',
      'context',
      'coordinates',
      'agents',
      'execution',
      'memory',
      'models',
      'download',
    ]);
    expect(STORY_CHAPTERS).toHaveLength(6);
  });

  it('keeps section IDs and generated scene anchors unique', () => {
    const sectionIds = PRODUCT_STORY.map((stage) => stage.id);
    const anchorIds = PRODUCT_STORY.map(sceneAnchorId);

    expect(new Set(sectionIds).size).toBe(PRODUCT_STORY.length);
    expect(new Set(anchorIds).size).toBe(PRODUCT_STORY.length);
    expect(new Set([...sectionIds, ...anchorIds]).size).toBe(PRODUCT_STORY.length * 2);
    expect(anchorIds).toEqual(sectionIds.map((id) => `${id}-scene`));
  });

  it('derives primary navigation only from registered story stages', () => {
    expect(PRODUCT_HEADER_NAV).toEqual([
      { id: 'context', label: 'System' },
      { id: 'memory', label: 'Continuity' },
      { id: 'models', label: 'Models' },
    ]);
  });

  it('derives the stage rail from the same ordered story definitions', () => {
    expect(PRODUCT_STAGE_RAIL).toEqual(
      PRODUCT_STORY.map(({ formation, id, railLabel }) => ({ formation, id, railLabel }))
    );
  });

  it('keeps formations explicit when section order changes', () => {
    expect(PRODUCT_STORY.map((stage) => stage.formation)).toEqual([
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
});
