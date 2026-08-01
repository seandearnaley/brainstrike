import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import {
  CONTENT_SECURITY_POLICY,
  productionContentSecurityPolicyMeta,
} from './content-security-policy';

describe('production content security policy', () => {
  it('keeps development HTML policy-free and supplies the production build tag', () => {
    const sourceHtml = readFileSync(new URL('../../index.html', import.meta.url), 'utf8');

    expect(sourceHtml).not.toContain('Content-Security-Policy');
    expect(productionContentSecurityPolicyMeta()).toMatchObject({
      attrs: {
        content: CONTENT_SECURITY_POLICY,
        'http-equiv': 'Content-Security-Policy',
      },
      injectTo: 'head-prepend',
      tag: 'meta',
    });
    expect(CONTENT_SECURITY_POLICY).not.toContain("'unsafe-inline'");
  });
});
