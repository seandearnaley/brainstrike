import type { ApprovalFileChange } from '@brainstrike/assistant-contract/tool-approval';
import { createContext, type ReactNode, use } from 'react';

/** Reads the file text a waiting call would change; rejects with why it cannot. */
export type ReadApprovalChange = (interactionId: string) => Promise<ApprovalFileChange>;

const ApprovalChangeContext = createContext<ReadApprovalChange | null>(null);

/**
 * The host's read of a waiting file call's change (ADR-0036), which the
 * desktop binds over its agent-host client.
 */
export function ApprovalChangeProvider({
  children,
  value,
}: {
  readonly children: ReactNode;
  readonly value: ReadApprovalChange | null;
}) {
  return <ApprovalChangeContext.Provider value={value}>{children}</ApprovalChangeContext.Provider>;
}

/**
 * The change reader, or `null` where no provider supplies one (web, tests):
 * capability gating (ADR-0008), never a disabled stub.
 */
export function useApprovalChange(): ReadApprovalChange | null {
  return use(ApprovalChangeContext);
}
