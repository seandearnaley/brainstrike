import { describe, expect, it } from 'vitest';
import { isWebRootPath, webRootPath, webStateExtensionPool, webStateNames } from '../protocol';

describe('the store names', () => {
  it("keeps an extension's pool beside its store's, where no other store's pool can be", () => {
    expect(webStateExtensionPool('default', 'files')).toEqual({
      pool: 'brainstrike-web-state-default--files',
      vfs: 'brainstrike-web-state-default--files',
    });
    // A store name cannot contain the separator, so `default-files` stays a store of its own.
    expect(() => webStateNames('default--files')).toThrow(RangeError);
    expect(webStateNames('default-files').pool).toBe('brainstrike-web-state-default-files');
    expect(() => webStateExtensionPool('default', 'Files')).toThrow(RangeError);
  });

  it("names a browser root by its own id, and by no other root's", () => {
    const id = crypto.randomUUID();
    expect(isWebRootPath(webRootPath(id), id)).toBe(true);
    expect(isWebRootPath(webRootPath(id), crypto.randomUUID())).toBe(false);
    expect(() => webRootPath('not-a-uuid')).toThrow();
  });
});
