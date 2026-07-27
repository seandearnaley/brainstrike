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
 * This checks the parts that are mechanically checkable — parameter NAMES, enum
 * options, and required-ness — for EVERY native tool, so the next divergence
 * fails here.
 *
 * Every mismatch must FAIL rather than skip. The first version of this spec
 * skipped when a display parameter was absent, when it carried no `enumValues`,
 * and when the Zod schema was not an object — so a display schema that dropped
 * `mode` entirely, the very drift it was written for, would have passed silently
 * on all 27 other tools. A parity check with an escape hatch is not a parity
 * check.
 *
 * HONEST LIMIT: prose is NOT mechanically checkable, and prose is where this
 * pair keeps drifting (a `description` that enumerated three of four modes
 * survived a green run of this file). The querySelf case below pins the specific
 * sentences that went stale; nothing generic can.
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

  /** Optional or defaulted in Zod ⇒ the display schema must say `required: false`. */
  function isOptionalField(field: z.ZodTypeAny): boolean {
    return field instanceof z.ZodOptional || field instanceof z.ZodDefault;
  }

  it.each(entries)('%s mirrors its Zod schema exactly', (toolId, zodSchema) => {
    const shape = objectShape(zodSchema as z.ZodTypeAny);
    // Asserted, not skipped: a non-object schema would silently exempt the tool
    // from every check below.
    expect(shape, `${toolId} input schema is not a Zod object, so parity is unverifiable`).not.toBe(
      null
    );
    const fields = shape as Record<string, z.ZodTypeAny>;

    const display = NATIVE_TOOL_SCHEMAS[toolId as keyof typeof NATIVE_TOOL_SCHEMAS];
    const byName = new Map<string, ToolParameterDisplay>(
      display.parameters.map((parameter) => [parameter.name, parameter])
    );

    expect(
      [...byName.keys()].sort(),
      `${toolId} display parameters drifted from the Zod field set`
    ).toEqual(Object.keys(fields).sort());

    for (const [name, field] of Object.entries(fields)) {
      const declared = byName.get(name);
      // Non-null asserted by the set comparison above; narrow for the compiler.
      if (declared === undefined) {
        throw new Error(`unreachable: ${toolId}.${name}`);
      }

      expect(declared.required === true, `${toolId}.${name} required-ness drifted`).toBe(
        !isOptionalField(field)
      );

      const inner = unwrap(field);
      if (!(inner instanceof z.ZodEnum)) {
        continue;
      }
      // An enum field with no advertised options renders as a free-text box in
      // the inspector, so absence is a drift, not an exemption.
      expect(
        declared.enumValues,
        `${toolId}.${name} is a Zod enum but the display schema advertises no options`
      ).toBeDefined();
      expect(
        [...(declared.enumValues ?? [])].sort(),
        `${toolId}.${name} display enumValues drifted from the Zod enum`
      ).toEqual([...(inner.options as string[])].sort());
    }
  });

  /**
   * The mechanical checks above cannot read prose, and prose is where this pair
   * drifts. Both mirrors once described `sql` as "Required for mode=query" while
   * the runtime also required it for `mode=explain`, and the display schema's
   * `mode` description enumerated three of the four modes it accepts.
   */
  it('pins the querySelf prose that keeps going stale', () => {
    const display = NATIVE_TOOL_SCHEMAS['brainstrike.querySelf'];
    const zodShape = objectShape(
      NATIVE_TOOL_INPUT_SCHEMAS['brainstrike.querySelf'] as z.ZodTypeAny
    ) as Record<string, z.ZodTypeAny>;

    const modeField = unwrap(zodShape['mode'] as z.ZodTypeAny);
    expect(modeField).toBeInstanceOf(z.ZodEnum);
    const modes = [...((modeField as z.ZodEnum<[string, ...string[]]>).options as string[])];
    expect(modes.sort()).toEqual([
      'describeTable',
      'explain',
      'lens',
      'listLenses',
      'listTables',
      'query',
    ]);

    const modeDescription =
      display.parameters.find((parameter) => parameter.name === 'mode')?.description ?? '';
    for (const mode of modes) {
      expect(modeDescription, `the mode description omits '${mode}'`).toContain(mode);
    }

    // `sql` is required by BOTH query and explain — runtime truth is
    // QUERY_SELF_ERROR_MESSAGES.missingSql — so neither mirror may claim it is
    // needed for query alone.
    const sqlDescriptions = [
      display.parameters.find((parameter) => parameter.name === 'sql')?.description ?? '',
      (zodShape['sql'] as { description?: string }).description ?? '',
    ];
    for (const description of sqlDescriptions) {
      expect(description).toContain('mode=query');
      expect(description, 'sql is required for mode=explain too').toContain('mode=explain');
    }
  });
});
