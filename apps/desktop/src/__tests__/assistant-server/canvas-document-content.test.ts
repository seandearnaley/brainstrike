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
    // `</head>` and `<head>` are both optional in HTML5: the head ends where the
    // parser ends it, not at a closing tag the document may never write.
    ['head with omitted </head>', '<html><head><title>Report</title><body></body></html>'],
    ['implied head', '<title>Report</title><body></body>'],
    // A script inside an explicit head is head content whether or not the
    // head is closed. Mutation: never stripping a head script fails this row.
    [
      'script in a head with omitted </head>',
      '<html><head><script src="x.js"></script><body></body></html>',
    ],
    // Explicit-head counterparts of the template/noscript content rows below.
    [
      'a template inside an explicit head',
      '<head><template><canvas id="c"></canvas></template></head><body></body>',
    ],
    [
      'a noscript image inside an explicit head',
      '<head><noscript><img src="chart.png"></noscript></head><body></body>',
    ],
    // Pins the doctype, whitespace, meta and link head-token alternatives:
    // deleting any one of them leaves "Report" as text.
    [
      'doctype, meta and link before the head',
      '<!DOCTYPE html>\n<html><head><meta charset="utf-8"><link rel="stylesheet" href="x.css"><title>Report</title><body></body></html>',
    ],
    // A raw-text element the document never closes runs to end of input, as
    // the parser reads it, so a truncated head is still a head.
    ['head with a truncated title', '<head><title>Report'],
    ['truncated script inside an explicit head', '<head><script>render()'],
    // The `style` ruling: a style-only document has nothing to read or see.
    ['style only', '<style>body{margin:0}</style>'],
    // HTML_TAG alone swallows a comment that contains no `>`, so this row does
    // NOT pin the comment strip — the two rows below it do.
    ['comment only', '<body><!-- report goes here --></body>'],
    // Mutation: deleting the comment alternative from HEAD_TOKEN stops the
    // head scan here and leaves the title text, failing this row.
    [
      'comment before the head',
      '<!-- report --><html><head><title>Report</title></head><body></body></html>',
    ],
    // Commented-out markup renders nothing. Mutation: dropping the comment
    // strip makes the `<img` inside it read as content, failing this row.
    ['comment containing markup', '<body><!-- <img src="x.png"> --></body>'],
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
    // The head ends at the first token the parser would not keep in it, so
    // body text after an unclosed head is never stripped with the head.
    ['body text after an unclosed head', '<head><title>T</title><h1>Report</h1>'],
    // A script with no explicit head before it is content, not an implied head.
    // Mutation: stripping every leading script fails this row.
    ['a script-only document', '<script>render()</script>'],
    // Mutation: scanning past `</head>` strips this script with the head.
    ['a script after a closed head', '<head><title>T</title></head><script>render()</script>'],
    // Like script, template and noscript are body content outside an explicit
    // head. Mutation: dropping either from that guard fails its row.
    ['a template-only document', '<template><canvas id="c"></canvas></template>'],
    ['noscript with an image', '<noscript><img src="chart.png"></noscript>'],
    // The unclosed-to-EOF rule must not swallow a script the guard protects.
    // Mutation: dropping the guard consumes this as an implied head.
    ['truncated script outside a head', '<script>render()'],
  ])('treats %s as content', (_label, html) => {
    expect(isEmptyCanvasDocument(html)).toBe(false);
  });
});
