import { describe, expect, it } from 'vitest';
import { NATIVE_TOOL_ID, NATIVE_TOOL_IDS } from '../native-tool-catalog';
import { NATIVE_TOOL_DEFAULTS } from '../tool-categories';
import { getNativeToolDescription, TOOL_DESCRIPTIONS } from '../tool-descriptions';

describe('TOOL_DESCRIPTIONS', () => {
  it('provides a non-empty description for EVERY native tool (no generic-label fallback)', () => {
    // Settings surfaces use the guarded dynamic lookup; a missing entry would
    // silently hide the tool's real (often destructive) behavior. Every
    // catalog id must have a concrete description.
    for (const id of NATIVE_TOOL_IDS) {
      const description = TOOL_DESCRIPTIONS[id];
      expect(description, `missing description for ${id}`).toBeTruthy();
      expect((description ?? '').trim().length, `empty description for ${id}`).toBeGreaterThan(0);
    }
  });

  it('does not carry descriptions for ids absent from the native-tool catalog', () => {
    const knownIds = new Set(Object.keys(NATIVE_TOOL_DEFAULTS));
    for (const id of Object.keys(TOOL_DESCRIPTIONS)) {
      expect(knownIds.has(id), `stale description for unknown tool ${id}`).toBe(true);
    }
  });

  it('guards dynamic lookups instead of widening the exact registry', () => {
    expect(getNativeToolDescription(NATIVE_TOOL_ID.executeCommand)).toBe(
      TOOL_DESCRIPTIONS[NATIVE_TOOL_ID.executeCommand]
    );
    expect(getNativeToolDescription('mcp.unregistered')).toBeUndefined();
  });
});
