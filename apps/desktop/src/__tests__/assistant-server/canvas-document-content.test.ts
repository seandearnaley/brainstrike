import { describe, expect, it } from 'vitest';
import { isEmptyCanvasDocument } from '../../assistant-server/canvas-document-content';

describe('isEmptyCanvasDocument', () => {
  it.each([
    ['empty string', ''],
    ['whitespace only', '   \n\t'],
    ['bare shell', '<html><body></body></html>'],
    // Run 6/7 shape: a titled shell "ready to receive the report". The head
    // block is removed BEFORE the text check, so <title> never counts as body
    // text. Mutation: dropping the head strip fails this row.
    ['head-only title', '<html><head><title>Report</title></head><body></body></html>'],
    // Mutation: dropping the comment strip fails this row.
    ['comment only', '<body><!-- report goes here --></body>'],
    ['non-breaking spaces only', '<p>&nbsp;&nbsp;</p><div>&#160;</div>'],
    ['empty wrappers', '<div><section><p></p></section></div>'],
  ])('treats %s as empty', (_label, html) => {
    expect(isEmptyCanvasDocument(html)).toBe(true);
  });

  it.each([
    ['one line of text', '<p>Findings: 3 modules exceed the split threshold.</p>'],
    ['text without tags', 'plain report text'],
    // Content-bearing elements are content even with no text at all.
    // Mutation: dropping the element check fails these rows.
    ['an inline svg chart', '<svg viewBox="0 0 10 10"><rect width="4" height="4"/></svg>'],
    ['an image', '<img src="data:image/png;base64,AAAA" alt="">'],
    [
      'a script that draws into a canvas',
      '<body><canvas id="c"></canvas><script>draw()</script></body>',
    ],
    // No text at all: the element check is the ONLY thing that makes this content.
    [
      'a canvas drawn by an external script',
      '<body><canvas id="c"></canvas><script src="draw.js"></script></body>',
    ],
    ['text after a comment', '<!-- header --><h1>Report</h1>'],
  ])('treats %s as content', (_label, html) => {
    expect(isEmptyCanvasDocument(html)).toBe(false);
  });
});
