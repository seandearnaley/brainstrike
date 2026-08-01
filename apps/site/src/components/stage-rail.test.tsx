import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import type { ProductStageRailEntry } from '../content/product-story';
import { StageRail } from './stage-rail';

describe('StageRail', () => {
  it('marks exactly the active editorial frame without consulting GPU formations', () => {
    const stages = [
      { id: 'signal', railLabel: 'First' },
      { id: 'context', railLabel: 'Second' },
    ] as const satisfies readonly ProductStageRailEntry[];

    const markup = renderToStaticMarkup(<StageRail activeStageId="context" stages={stages} />);

    expect(markup.match(/aria-current="step"/g)).toHaveLength(1);
    expect(markup).toContain('<li class="is-active"><a aria-current="step" href="#context">');
  });
});
