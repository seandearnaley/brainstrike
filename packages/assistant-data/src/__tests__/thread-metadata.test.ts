import { describe, expect, it } from 'vitest';
import {
  assertPersistableThreadMetadataForTest,
  sanitizeThreadMetadataForTest,
} from '../assistant-memory-repository';

describe('forge metadata', () => {
  it('keeps a forge PR URL and a watch flag', () => {
    const metadata = sanitizeThreadMetadataForTest({
      forgePrUrl: 'https://github.com/acme/widgets/pull/42',
      forgePrWatch: false,
    });
    expect(metadata).toEqual({
      forgePrUrl: 'https://github.com/acme/widgets/pull/42',
      forgePrWatch: false,
    });
  });

  it('drops a non-string forge PR URL and a non-boolean watch flag', () => {
    expect(sanitizeThreadMetadataForTest({ forgePrUrl: 42, forgePrWatch: 'yes' })).toBeUndefined();
  });

  it('rejects an unknown forge key on persistence', () => {
    expect(() => assertPersistableThreadMetadataForTest({ forgePr: 'x' } as never)).toThrow(
      'Invalid assistant thread metadata key: forgePr.'
    );
  });

  it('rejects a blank forge PR URL on persistence', () => {
    expect(() => assertPersistableThreadMetadataForTest({ forgePrUrl: '   ' })).toThrow();
  });
});
