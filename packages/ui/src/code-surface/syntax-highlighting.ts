import { HighlightStyle, syntaxHighlighting } from '@codemirror/language';
import type { Extension } from '@codemirror/state';
import { tags } from '@lezer/highlight';

/**
 * Syntax colours for every CodeMirror surface (file editor and diff view). The
 * colours are the `--syntax-*` tokens in globals.css, so one style follows the
 * app theme without reconfiguring the editor: GitHub Light in light mode and
 * Monokai in dark mode, matching the Shiki themes of chat code blocks.
 * CodeMirror's `defaultHighlightStyle` is a light-only palette (navy keywords,
 * dark blue names) that is unreadable on the dark background.
 */
const APP_HIGHLIGHT_STYLE = HighlightStyle.define([
  { color: 'var(--syntax-keyword)', tag: [tags.keyword, tags.operatorKeyword, tags.modifier] },
  { color: 'var(--syntax-keyword)', tag: [tags.operator, tags.compareOperator] },
  { color: 'var(--syntax-string)', tag: [tags.string, tags.special(tags.string), tags.inserted] },
  {
    color: 'var(--syntax-number)',
    tag: [tags.number, tags.bool, tags.atom, tags.null, tags.regexp, tags.escape, tags.unit],
  },
  {
    color: 'var(--syntax-function)',
    tag: [
      tags.function(tags.variableName),
      tags.function(tags.definition(tags.variableName)),
      tags.function(tags.propertyName),
      tags.macroName,
    ],
  },
  {
    color: 'var(--syntax-type)',
    fontStyle: 'italic',
    tag: [tags.typeName, tags.standard(tags.typeName)],
  },
  {
    color: 'var(--syntax-class)',
    tag: [tags.className, tags.namespace, tags.definition(tags.typeName)],
  },
  { color: 'var(--syntax-property)', tag: [tags.propertyName, tags.labelName] },
  { color: 'var(--syntax-tag)', tag: [tags.tagName, tags.deleted] },
  { color: 'var(--syntax-attribute)', tag: tags.attributeName },
  { color: 'var(--syntax-comment)', fontStyle: 'italic', tag: [tags.comment, tags.meta] },
  { color: 'var(--syntax-function)', fontWeight: 'bold', tag: tags.heading },
  { fontWeight: 'bold', tag: tags.strong },
  { fontStyle: 'italic', tag: tags.emphasis },
  { tag: tags.strikethrough, textDecoration: 'line-through' },
  { color: 'var(--syntax-type)', tag: [tags.link, tags.url], textDecoration: 'underline' },
  { color: 'var(--syntax-invalid)', tag: tags.invalid },
]);

export const appSyntaxHighlighting: Extension = syntaxHighlighting(APP_HIGHLIGHT_STYLE);
