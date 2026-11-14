import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { test } from 'node:test';

test('every chapter has its scene notes, written by one run that kept going', async () => {
  for (let chapter = 1; chapter <= 36; chapter += 1) {
    const notes = await readFile(
      new URL(`../notes/chapter-${chapter}.md`, import.meta.url),
      'utf8'
    );
    const scenes = notes.split('\n').filter((line) => line.startsWith(`- Chapter ${chapter}:`));
    assert.ok(scenes.length >= 360, `notes/chapter-${chapter}.md has ${scenes.length} scenes`);
  }
});
