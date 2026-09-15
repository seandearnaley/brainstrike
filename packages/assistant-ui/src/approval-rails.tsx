import type { AssistantToolApprovalRequest } from '@brainstrike/assistant-contract/tool-approval';
import { delegationRailIndices } from './delegation-colour';

type DelegationPath = NonNullable<AssistantToolApprovalRequest['delegation']>['path'];

/**
 * One rail per ancestor edge, outermost delegation first, so a depth-3 pause
 * reads as a tree beside the depth indent. Decorative: the persona chain
 * text (`describeDelegationChain`) is the accessible signal.
 */
export function ApprovalRails({ path }: { readonly path: DelegationPath }) {
  if (path.length === 0) {
    return null;
  }
  const indices = delegationRailIndices(path);
  return (
    <span aria-hidden="true" className="bs-approval-rails">
      {path.map((edge, position) => (
        <span
          className="bs-approval-rail"
          data-delegation-colour={indices[position]}
          key={edge.childRuntimeRunId}
        />
      ))}
    </span>
  );
}
