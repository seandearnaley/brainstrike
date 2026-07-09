import { describe, expect, it } from 'vitest';
import { extractFrontmatter } from '../frontmatter';

describe('extractFrontmatter', () => {
  it('passes through documents without frontmatter', () => {
    const r = extractFrontmatter('# Hello\n');
    expect(r).toEqual({ body: '# Hello\n', data: null, error: null, raw: null });
  });
  it('extracts a YAML mapping and removes it from the body', () => {
    const r = extractFrontmatter('---\ntitle: Test\ntags:\n  - a\n---\n# Body\n');
    expect(r.data).toEqual({ tags: ['a'], title: 'Test' });
    expect(r.body).toBe('# Body\n');
    expect(r.error).toBeNull();
  });
  it('handles CRLF and BOM', () => {
    const r = extractFrontmatter('﻿---\r\ntitle: X\r\n---\r\nbody');
    expect(r.data).toEqual({ title: 'X' });
    expect(r.body).toBe('body');
  });
  it('reports invalid YAML with the raw block, never throws', () => {
    const r = extractFrontmatter('---\n: : :\n---\nbody');
    expect(r.data).toBeNull();
    expect(r.raw).toBe(': : :');
    expect(typeof r.error).toBe('string');
    expect(r.body).toBe('body');
  });
  it('reports non-mapping YAML (a list) as an error', () => {
    const r = extractFrontmatter('---\n- a\n- b\n---\nbody');
    expect(r.data).toBeNull();
    expect(r.error).toMatch(/mapping/i);
  });
  it('treats empty frontmatter as no properties block, stripped from body', () => {
    const r = extractFrontmatter('---\n---\n# Body\n');
    expect(r).toEqual({ body: '# Body\n', data: null, error: null, raw: null });
  });
  it('does not treat a mid-document --- as frontmatter', () => {
    const src = 'intro\n---\ntitle: nope\n---\n';
    expect(extractFrontmatter(src).body).toBe(src);
  });
});
