// Google's flow for desktop apps: PKCE, with the browser sending the code to a local port.
import { createHash, randomBytes } from 'node:crypto';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import type { Fetch } from '../types';

const AUTH_URL = 'https://accounts.google.com/o/oauth2/v2/auth';
const TOKEN_URL = 'https://oauth2.googleapis.com/token';
export const SCOPE = 'https://www.googleapis.com/auth/calendar.events';
const TIMEOUT_MS = 5 * 60_000;

export type GoogleClient = { clientId: string; clientSecret: string };
export type GoogleTokens = { accessToken: string; refreshToken: string; expiresAt: number };

const b64url = (buf: Buffer) => buf.toString('base64url');

type TokenResponse = { access_token?: string; refresh_token?: string; expires_in?: number; error?: string; error_description?: string };

async function tokenRequest(http: Fetch, params: Record<string, string>): Promise<TokenResponse> {
  const res = await http(TOKEN_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams(params).toString(),
  });
  const json = (await res.json()) as TokenResponse;
  if (!res.ok || !json.access_token) throw new Error(`Google sign-in: ${json.error_description ?? json.error ?? res.status}`);
  return json;
}

/** Opens the browser and waits on 127.0.0.1 for the redirect. */
export async function signIn(client: GoogleClient, openBrowser: (url: string) => void, http: Fetch = fetch, now: () => number = Date.now): Promise<GoogleTokens> {
  const verifier = b64url(randomBytes(48));
  const challenge = b64url(createHash('sha256').update(verifier).digest());
  const state = b64url(randomBytes(24));

  const { code, redirectUri } = await new Promise<{ code: string; redirectUri: string }>((resolve, reject) => {
    const server = createServer((req, res) => {
      const url = new URL(req.url ?? '/', 'http://127.0.0.1');
      if (url.pathname !== '/callback') {
        res.writeHead(404).end();
        return;
      }
      const code = url.searchParams.get('code');
      const fine = url.searchParams.get('state') === state && code;
      res.writeHead(fine ? 200 : 400, { 'Content-Type': 'text/plain' }).end(fine ? 'FlowState is connected. You can close this tab.' : 'Sign-in failed. Close this tab and try again.');
      clearTimeout(timer);
      server.close();
      if (fine) resolve({ code, redirectUri });
      else reject(new Error(`Google sign-in: ${url.searchParams.get('error') ?? 'state did not match'}`));
    });
    const timer = setTimeout(() => {
      server.close();
      reject(new Error('Google sign-in timed out.'));
    }, TIMEOUT_MS);
    let redirectUri = '';
    server.listen(0, '127.0.0.1', () => {
      redirectUri = `http://127.0.0.1:${(server.address() as AddressInfo).port}/callback`;
      const url = new URL(AUTH_URL);
      for (const [k, v] of Object.entries({
        client_id: client.clientId,
        redirect_uri: redirectUri,
        response_type: 'code',
        scope: SCOPE,
        access_type: 'offline',
        prompt: 'consent',
        code_challenge: challenge,
        code_challenge_method: 'S256',
        state,
      })) {
        url.searchParams.set(k, v);
      }
      openBrowser(url.href);
    });
  });

  const json = await tokenRequest(http, {
    client_id: client.clientId,
    client_secret: client.clientSecret,
    code,
    code_verifier: verifier,
    grant_type: 'authorization_code',
    redirect_uri: redirectUri,
  });
  if (!json.refresh_token) throw new Error('Google sign-in: no refresh token returned.');
  return { accessToken: json.access_token!, refreshToken: json.refresh_token, expiresAt: now() + (json.expires_in ?? 3600) * 1000 };
}

export async function refresh(client: GoogleClient, tokens: GoogleTokens, http: Fetch = fetch, now: () => number = Date.now): Promise<GoogleTokens> {
  const json = await tokenRequest(http, {
    client_id: client.clientId,
    client_secret: client.clientSecret,
    refresh_token: tokens.refreshToken,
    grant_type: 'refresh_token',
  });
  return { accessToken: json.access_token!, refreshToken: json.refresh_token ?? tokens.refreshToken, expiresAt: now() + (json.expires_in ?? 3600) * 1000 };
}
