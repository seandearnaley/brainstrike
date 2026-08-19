import { describe, expect, it } from 'vitest';
import {
  computeS256Challenge,
  createPkceVerifier,
  createState,
  PKCE_VERIFIER_LENGTH,
} from '../../provider-auth/pkce';

/** RFC 7636 unreserved characters (§4.1): ALPHA / DIGIT / "-" / "." / "_" / "~". */
const RFC7636_UNRESERVED = /^[A-Za-z0-9\-._~]+$/;

describe('createPkceVerifier', () => {
  it('produces 43-character verifiers from the RFC 7636 unreserved alphabet', () => {
    for (let i = 0; i < 200; i += 1) {
      const verifier = createPkceVerifier();
      expect(verifier).toHaveLength(43);
      expect(verifier).toHaveLength(PKCE_VERIFIER_LENGTH);
      expect(verifier).toMatch(RFC7636_UNRESERVED);
    }
  });

  it('produces distinct verifiers across calls', () => {
    const seen = new Set(Array.from({ length: 64 }, () => createPkceVerifier()));
    expect(seen.size).toBe(64);
  });
});

describe('computeS256Challenge', () => {
  it('matches the RFC 7636 Appendix B known vector', () => {
    // RFC 7636 Appendix B: this exact verifier must hash to this exact
    // S256 challenge (base64url, no padding).
    expect(computeS256Challenge('dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXk')).toBe(
      'E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM'
    );
  });

  it('emits base64url without padding for arbitrary verifiers', () => {
    const challenge = computeS256Challenge(createPkceVerifier());
    // SHA-256 = 32 bytes -> ceil(32 * 4 / 3) = 43 base64url chars, no '='.
    expect(challenge).toHaveLength(43);
    expect(challenge).toMatch(/^[A-Za-z0-9\-_]+$/);
  });
});

describe('createState', () => {
  it('encodes 32 random bytes as unpadded base64url', () => {
    const state = createState();
    expect(state).toHaveLength(43);
    expect(state).toMatch(/^[A-Za-z0-9\-_]+$/);
  });

  it('produces distinct values across calls', () => {
    const seen = new Set(Array.from({ length: 64 }, () => createState()));
    expect(seen.size).toBe(64);
  });
});
