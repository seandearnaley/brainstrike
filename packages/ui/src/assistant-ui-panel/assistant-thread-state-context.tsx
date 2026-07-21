import type { ReactNode } from 'react';
import { AssistantRunEventProvider } from './assistant-run-event-context';
import { AssistantToolArgumentProvider } from './tool-argument-context';

export function AssistantThreadStateProvider({ children }: { readonly children: ReactNode }) {
  return (
    <AssistantRunEventProvider>
      <AssistantToolArgumentProvider>{children}</AssistantToolArgumentProvider>
    </AssistantRunEventProvider>
  );
}
