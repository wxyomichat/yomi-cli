import { createHash, randomBytes } from 'node:crypto';

/**
 * PKCE (RFC 7636, method S256) for `yomi login`: the verifier stays in this process, only its
 * challenge goes into the authorize link. A one-time code that leaks on its way back (another
 * program on this machine reading the callback) is worthless without the verifier.
 */

/** 32 random bytes, base64url without padding: 43 characters of `[A-Za-z0-9_-]`. */
export function createCodeVerifier(): string {
  return randomBytes(32).toString('base64url');
}

/** `base64url(SHA-256(ASCII(verifier)))`, without padding (43 characters). */
export function codeChallenge(verifier: string): string {
  return createHash('sha256').update(verifier, 'ascii').digest('base64url');
}
