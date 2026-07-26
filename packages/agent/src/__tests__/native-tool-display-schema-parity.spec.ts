import {
  isDesktopNativeToolId,
  NATIVE_TOOL_SCHEMAS,
  type ToolParameterDisplay,
} from '@brainstrike/assistant-contract';
import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import { NATIVE_TOOL_INPUT_SCHEMAS } from '../tools/schemas';

/**
 * The display schemas in `tool-schemas-display.ts` are hand-maintained mirrors
 * of the Zod input schemas, and nothing tied them together: `native-tool-catalog`
 * only asserts each entry's `toolId` matches its key.
 *
 * That let a real drift through — `querySelf` gained an `explain` mode and an
 * `analyze` parameter while the display schema still advertised three modes and
 * no `analyze`, so the tool inspector rendered a capability set that no longer
 * matched the tool. Same seam class as the other bugs in this feature: the
 * capability moved at one layer and its description at another went stale
 * unchecked.
 *
 * This checks the parts that are mechanically checkable — enum options and
 * required-ness — for EVERY native tool, so the next divergence fails here.
 */

function unwrap(schema: z.ZodTypeAny): z.ZodTypeAny {
  let current = schema;
  for (;;) {
    if (current instanceof z.ZodOptional || current instanceof z.ZodDefault) {
      current = current.def.innerType as z.ZodTypeAny;
      continue;
    }
    return current;
  }
}

function objectShape(schema: z.ZodTypeAny): Record<string, z.ZodTypeAny> | null {
  const unwrapped = unwrap(schema);
  return unwrapped instanceof z.ZodObject
    ? (unwrapped.shape as Record<string, z.ZodTypeAny>)
    : null;
}

describe('native tool display schema parity', () => {
  const entries = Object.entries(NATIVE_TOOL_INPUT_SCHEMAS).filter(([toolId]) =>
    isDesktopNativeToolId(toolId)
  );

  it.each(entries)('%s advertises the same enum options it accepts', (toolId, zodSchema) => {
    const shape = objectShape(zodSchema as z.ZodTypeAny);
    if (shape === null) {
      return;
    }
    const display = NATIVE_TOOL_SCHEMAS[toolId as keyof typeof NATIVE_TOOL_SCHEMAS];
    const byName = new Map<string, ToolParameterDisplay>(
      display.parameters.map((parameter) => [parameter.name, parameter])
    );

    for (const [name, field] of Object.entries(shape)) {
      const inner = unwrap(field);
      if (!(inner instanceof z.ZodEnum)) {
        continue;
      }
      const declared = byName.get(name);
      if (declared?.enumValues === undefined) {
        continue;
      }
      expect(
        [...declared.enumValues].sort(),
        `${toolId}.${name} display enumValues drifted from the Zod enum`
      ).toEqual([...(inner.options as string[])].sort());
    }
  });

  it('pins querySelf, the tool whose display schema actually drifted', () => {
    const shape = objectShape(NATIVE_TOOL_INPUT_SCHEMAS['brainstrike.querySelf'] as z.ZodTypeAny);
    expect(shape).not.toBeNull();

    const modeField = unwrap((shape as Record<string, z.ZodTypeAny>)['mode'] as z.ZodTypeAny);
    expect(modeField).toBeInstanceOf(z.ZodEnum);
    expect(
      [...((modeField as z.ZodEnum<[string, ...string[]]>).options as string[])].sort()
    ).toEqual(['describeTable', 'explain', 'listTables', 'query']);

    const names = NATIVE_TOOL_SCHEMAS['brainstrike.querySelf'].parameters.map(
      (parameter) => parameter.name
    );
    expect(names).toContain('analyze');
  });
});
