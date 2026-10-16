import { describe, expect, it } from 'vitest';
import { extensionOps, type WebStateExtensionInstance } from '../extension';

function instance(...ops: string[]): WebStateExtensionInstance {
  return {
    close: () => undefined,
    handlers: Object.fromEntries(ops.map((op) => [op, () => op])),
  };
}

describe('writer extension ops', () => {
  it('serves each namespaced op by its extension', () => {
    const ops = extensionOps([instance('index.search', 'index.catchUp'), instance('files.scan')]);
    expect([...ops.keys()]).toEqual(['index.search', 'index.catchUp', 'files.scan']);
    expect(ops.get('files.scan')?.(undefined)).toBe('files.scan');
  });

  it('refuses an op that could shadow a writer op', () => {
    expect(() => extensionOps([instance('append')])).toThrow('append is not namespaced');
    expect(() => extensionOps([instance('.search')])).toThrow('not namespaced');
  });

  it('refuses an op two extensions both serve, rather than picking one', () => {
    expect(() => extensionOps([instance('index.search'), instance('index.search')])).toThrow(
      'Two writer extensions both serve index.search'
    );
  });
});
