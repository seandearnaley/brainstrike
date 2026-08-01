export const CONTENT_SECURITY_POLICY =
  "base-uri 'none'; connect-src 'self'; default-src 'self'; font-src 'self'; form-action 'none'; img-src 'self' data:; object-src 'none'; script-src 'self'; style-src 'self'; worker-src 'self' blob:";

interface ContentSecurityPolicyMeta {
  readonly attrs: {
    readonly content: string;
    readonly 'http-equiv': 'Content-Security-Policy';
  };
  readonly injectTo: 'head-prepend';
  readonly tag: 'meta';
}

export function productionContentSecurityPolicyMeta(): ContentSecurityPolicyMeta {
  return {
    attrs: {
      content: CONTENT_SECURITY_POLICY,
      'http-equiv': 'Content-Security-Policy',
    },
    injectTo: 'head-prepend',
    tag: 'meta',
  };
}
