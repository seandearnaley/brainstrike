import { expect, it } from 'vitest';

it('keeps the renderer tools bridge selection-event-only at compile time', () => {
  const assertNoExecutionCapability = (): void => {
    // @ts-expect-error Tool execution must not be exposed through Window.tools.
    void window.tools?.execute;
  };

  expect(assertNoExecutionCapability).toBeTypeOf('function');
});
