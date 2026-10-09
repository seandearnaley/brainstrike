import { projectToolOutputArtifactPage } from '@brainstrike/agent/tool-runtime';

/** The central model-projection wrapper invokes this with the sanitized tool as receiver, including its exact callable id. */
export function createArtifactReaderModelProjection(
  resolveBudget: () => number
): (this: { id: string }, output: unknown) => unknown {
  return function projectArtifactReaderModelOutput(this: { id: string }, output: unknown): unknown {
    return projectToolOutputArtifactPage(output, resolveBudget(), this.id);
  };
}
