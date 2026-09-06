import { DESKTOP_NATIVE_TOOL_IDS, NATIVE_TOOL_ID } from '@brainstrike/assistant-contract';
import { describe, expect, it } from 'vitest';
import {
  NATIVE_TOOL_EXECUTORS,
  type NativeToolExecutorMap,
} from '../../assistant-server/native-tool-executors';

/**
 * The executor map is the adapter half of the native-tool contract
 * (BST-1646 step c): exactly one entry per `brainstrike.*` definition. The
 * mapped type makes a missing or stray entry a compile error; this pins the
 * same fact at runtime so a `satisfies Partial<…>` group can never hide one.
 */
describe('NATIVE_TOOL_EXECUTORS', () => {
  it('has exactly one executor per desktop catalog id', () => {
    expect(Object.keys(NATIVE_TOOL_EXECUTORS).sort()).toEqual([...DESKTOP_NATIVE_TOOL_IDS].sort());
    for (const toolId of DESKTOP_NATIVE_TOOL_IDS) {
      expect(typeof NATIVE_TOOL_EXECUTORS[toolId], toolId).toBe('function');
    }
  });

  it('is exhaustive at compile time: dropping one entry is a type error', () => {
    const { [NATIVE_TOOL_ID.grepSearch]: _dropped, ...withoutGrep } = NATIVE_TOOL_EXECUTORS;
    // @ts-expect-error — a map without brainstrike.grepSearch is not a NativeToolExecutorMap
    const incomplete: NativeToolExecutorMap = withoutGrep;
    expect(Object.keys(incomplete)).toHaveLength(DESKTOP_NATIVE_TOOL_IDS.length - 1);
  });
});
