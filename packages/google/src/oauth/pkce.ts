const base64Url = (bytes: Uint8Array): string =>
  btoa(String.fromCharCode(...bytes))
    .replaceAll('+', '-')
    .replaceAll('/', '_')
    .replaceAll('=', '');

export interface PkcePair {
  readonly challenge: string;
  readonly verifier: string;
}

/**
 * RFC 7636 verifier/challenge pair (S256). Uses WebCrypto — available in Node
 * and Electron main; the iOS flow does its own PKCE via expo-auth-session.
 */
export const generatePkcePair = async (): Promise<PkcePair> => {
  const verifier = base64Url(crypto.getRandomValues(new Uint8Array(32)));
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(verifier));
  return { challenge: base64Url(new Uint8Array(digest)), verifier };
};

export const generateStateToken = (): string =>
  base64Url(crypto.getRandomValues(new Uint8Array(16)));
