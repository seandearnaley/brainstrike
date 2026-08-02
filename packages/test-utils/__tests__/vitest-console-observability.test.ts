import { render } from '@testing-library/react';
import { createElement, useState } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { type ConsoleErrorProbe, captureConsoleError } from '../src/console-error-probe.js';

let consoleErrorProbe: ConsoleErrorProbe;
let downstreamConsoleError: ReturnType<typeof vi.spyOn>;
let triggerUpdate: (() => void) | undefined;

function ActWarningProbe() {
  const [, setRenderCount] = useState(0);
  triggerUpdate = () => setRenderCount((count) => count + 1);
  return null;
}

beforeEach(() => {
  downstreamConsoleError = vi.spyOn(console, 'error').mockImplementation(() => {});
  consoleErrorProbe = captureConsoleError();
  triggerUpdate = undefined;
});

afterEach(() => {
  consoleErrorProbe.restore();
  downstreamConsoleError.mockRestore();
});

describe('Vitest setup console observability', () => {
  it('forwards real React act warnings to the active console error sink', () => {
    render(createElement(ActWarningProbe));

    if (!triggerUpdate) {
      throw new Error('Act warning probe did not render');
    }
    triggerUpdate();

    expect(
      consoleErrorProbe.calls.some((call) =>
        String(call[0]).includes('was not wrapped in act(...)')
      )
    ).toBe(true);
    expect(downstreamConsoleError).toHaveBeenCalled();
  });
});
