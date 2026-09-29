import { type RenderOptions, type RenderResult, render } from '@testing-library/react';
import type { ReactNode } from 'react';
import { ApprovalSubmissionProvider } from '../approval-submission-provider';

/** Standalone notices have the same explicit submission owner as the full panel. */
export function renderWithApprovalSubmissions(
  ui: ReactNode,
  options?: RenderOptions
): RenderResult {
  const Wrapper = options?.wrapper;
  return render(ui, {
    ...options,
    wrapper: ({ children }) => (
      <ApprovalSubmissionProvider>
        {Wrapper ? <Wrapper>{children}</Wrapper> : children}
      </ApprovalSubmissionProvider>
    ),
  });
}
