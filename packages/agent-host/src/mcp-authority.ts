import { canonical, jsonValue } from './json-value.js';
import type { McpToolAuthority } from './protocol.js';

export class McpAuthorityReconstructionError extends Error {
  readonly code = 'mcp-authority-reconstruction-refused';

  constructor(
    readonly reason:
      | 'configuration-changed'
      | 'legacy-missing-capture'
      | 'private-comparison-unavailable'
  ) {
    super('Persisted MCP approval authority cannot be reconstructed safely');
    this.name = 'McpAuthorityReconstructionError';
  }
}

/** BST-1977 A-to-B restart incident; descriptions come from the configured owner. */
export function assertMcpAuthorityReconstruction(
  captured: McpToolAuthority | undefined,
  current: McpToolAuthority
): void {
  if (!captured) {
    throw new McpAuthorityReconstructionError('legacy-missing-capture');
  }
  if (captured.kind === 'unavailable' || current.kind === 'unavailable') {
    throw new McpAuthorityReconstructionError('private-comparison-unavailable');
  }
  if (canonical(jsonValue(captured)) !== canonical(jsonValue(current))) {
    throw new McpAuthorityReconstructionError('configuration-changed');
  }
  // A stable credential reference can detect replacement, but the current
  // owner exposes no non-secret principal/version for edits within that record.
  if (current.kind === 'http' && current.auth.type === 'bearer') {
    throw new McpAuthorityReconstructionError('private-comparison-unavailable');
  }
}
