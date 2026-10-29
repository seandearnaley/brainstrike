import { createOpenAI } from '@ai-sdk/openai';
import { describe, expect, it } from 'vitest';

// Intentional dependency canary, in the same spirit as
// `provider-native-tool-search-compat.spec.ts`: pin the exact installed surface
// so a later change forces the BST-616 evidence to be revisited instead of
// drifting stale.
//
// BST-1284 (2026-08-15): this canary fired. The adapter gap it was written to
// watch has CLOSED. BST-616's no-go recorded that the AI SDK OpenAI 4.0.8 path
// "cannot express the hosted tool, `allowed_callers`, function
// `output_schema`, nested `caller`, or `program` / `program_output`
// continuation items" — as of `@ai-sdk/openai` 4.0.42 all five exist.
//
// The DECISION is unchanged and this bump does not adopt the surface. The
// no-go's other ground is a correctness result, not an adapter gap: hosted
// Programmatic Tool Calling was strictly correct on only one of three first
// runs where direct calling passed all three. An SDK bump cannot move that
// number, so adoption still needs a fresh measured re-run behind the gates
// recorded in `docs/agents/assistant-providers.md`.
describe('provider-native programmatic tool-calling compatibility seam', () => {
  it('pins the installed adapter surface evaluated by BST-616', () => {
    const tools = createOpenAI({ apiKey: 'not-used' }).tools;
    const programmaticToolKeys = Object.keys(tools).filter((key) => /programmatic/iu.test(key));

    expect(programmaticToolKeys).toEqual(['programmaticToolCalling']);
    expect(tools.programmaticToolCalling()).toMatchObject({
      id: 'openai.programmatic_tool_calling',
      isProviderExecuted: true,
      type: 'provider',
    });
  });
});
