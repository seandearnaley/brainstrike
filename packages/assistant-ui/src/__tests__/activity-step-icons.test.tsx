// @vitest-environment jsdom
import '@testing-library/jest-dom/vitest';
import { render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { type StepGlyphState, StepStateGlyph } from '../activity-step-icons';
import { FAMILY_ICONS, STEP_STATE_LABELS } from '../activity-step-tokens';
import type { VerbFamily } from '../activity-verbs';

const FAMILIES: readonly VerbFamily[] = [
  'ask',
  'call',
  'canvas',
  'delegate',
  'edit',
  'other',
  'read',
  'run',
  'search',
  'skill',
  'tasks',
  'web',
  'worktree',
];

describe('FAMILY_ICONS', () => {
  it('has an icon for every verb family', () => {
    for (const family of FAMILIES) {
      expect(FAMILY_ICONS[family], family).toBeDefined();
    }
  });
});

describe('StepStateGlyph', () => {
  it('names every state for assistive tech and is live only while running', () => {
    const { rerender } = render(<StepStateGlyph state="running" />);
    expect(screen.getByRole('img', { name: STEP_STATE_LABELS.running })).toBeInTheDocument();
    expect(document.querySelectorAll('[data-live="true"]')).toHaveLength(1);
    for (const state of ['done', 'failed', 'cancelled', 'waiting', 'no-answer'] as const) {
      rerender(<StepStateGlyph state={state} />);
      expect(screen.getByRole('img', { name: STEP_STATE_LABELS[state] })).toBeInTheDocument();
      expect(document.querySelectorAll('[data-live="true"]')).toHaveLength(0);
    }
  });

  it('renders nothing for a state outside the union instead of its raw text', () => {
    // Bot round 1, Claude Minor 10. The `satisfies never` check is a COMPILE
    // -time guard; at runtime an unmapped state used to be RETURNED from the
    // switch, so a future state added to `StepGlyphState` and forgotten here
    // would paint its own identifier into the row. The cast is what a broken
    // producer looks like from this component's side.
    const { container } = render(
      <StepStateGlyph state={'teleported' as unknown as StepGlyphState} />
    );
    expect(container).not.toHaveTextContent('teleported');
  });

  it('spells the labels the e2e specs query', () => {
    expect(STEP_STATE_LABELS).toEqual({
      cancelled: 'Stopped',
      done: 'Completed',
      failed: 'Failed',
      'no-answer': 'No answer',
      running: 'Running',
      waiting: 'Waiting for approval',
    });
  });
});
