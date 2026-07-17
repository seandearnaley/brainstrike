import { describe, expect, it } from 'vitest';
import { FakeFileHandle, fakeNote } from '../../__tests__/support/fake-handles';
import { writeNoteFile } from '../write-note';

describe('writeNoteFile', () => {
  it('replaces the note content atomically', async () => {
    const note = fakeNote('a.md', { content: 'old' });

    await writeNoteFile(note, '# New content\n');

    expect(note.state.content).toBe('# New content\n');
  });

  it('propagates write failures instead of swallowing them', async () => {
    const broken = new FakeFileHandle('b.md');
    broken.createWritable = () =>
      Promise.reject(new DOMException('no write permission', 'NotAllowedError'));

    await expect(writeNoteFile(broken, 'x')).rejects.toMatchObject({
      name: 'NotAllowedError',
    });
  });
});
