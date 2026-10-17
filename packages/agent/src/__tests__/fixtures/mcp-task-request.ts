import type { JSONObject } from '@modelcontextprotocol/client';
import type { McpClientExtensionRequestContract } from '../../mcp/client-extension-registry';
import type { McpTaskPollingClient, McpTaskRequestOptions } from '../../mcp/tasks-lifecycle';

export type TaskRequestResponder = (
  contract: Pick<McpClientExtensionRequestContract, 'method' | 'protocol'>,
  params: JSONObject,
  options?: McpTaskRequestOptions
) => Promise<unknown>;

/** Keep response spies raw; the actual contract earns their generic result type. */
export function validatedTaskRequest(
  respond: TaskRequestResponder
): McpTaskPollingClient['requestExtension'] {
  return async (contract, params, options) => {
    const result = await contract.resultSchema['~standard'].validate(
      await respond(contract, params, options)
    );
    if (result.issues) {
      throw new Error(
        `Invalid ${contract.method} fixture response: ${JSON.stringify(result.issues)}`
      );
    }
    return result.value;
  };
}
