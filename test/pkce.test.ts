import { describe, expect, it } from 'vitest';

import { codeChallenge, createCodeVerifier } from '../src/auth/pkce.js';

describe('PKCE', () => {
  it('derives the S256 challenge of RFC 7636, appendix B', () => {
    expect(codeChallenge('dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXk')).toBe(
      'E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM',
    );
  });

  it('makes a fresh 43-character base64url verifier each time', () => {
    const verifiers = new Set(Array.from({ length: 20 }, () => createCodeVerifier()));
    expect(verifiers.size).toBe(20);
    for (const verifier of verifiers) {
      expect(verifier).toMatch(/^[A-Za-z0-9_-]{43}$/);
      expect(codeChallenge(verifier)).toMatch(/^[A-Za-z0-9_-]{43}$/);
    }
  });
});
