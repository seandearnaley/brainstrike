import '@testing-library/jest-dom';
import { vi } from 'vitest';
import { PreviewPanel } from '../../preview-panel';
import { render } from './preview-panel-test-utils';
import { createCompositeKey, uiTestProps } from './preview-panel-test-utils';

it('memoizes token calculations per file', () => {
  const file = createCompositeKey('file.txt');
  const selectedFiles = new Set([file]);
  const fileContents = { [file]: 'Hello world' };

  const countTokensHeuristic = vi.fn(() => 5);

  const { rerender } = render(
    <PreviewPanel
      {...uiTestProps}
      countTokensHeuristic={countTokensHeuristic}
      selectedFiles={selectedFiles}
      fileContents={fileContents}
    />
  );

  expect(countTokensHeuristic).toHaveBeenCalledTimes(1);

  rerender(
    <PreviewPanel
      {...uiTestProps}
      countTokensHeuristic={countTokensHeuristic}
      selectedFiles={selectedFiles}
      fileContents={fileContents}
    />
  );

  expect(countTokensHeuristic).toHaveBeenCalledTimes(1);
});
