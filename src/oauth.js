import crypto from 'node:crypto';

function base64url(buffer) {
  return buffer
    .toString('base64')
    .replaceAll('+', '-')
    .replaceAll('/', '_')
    .replace(/=+$/, '');
}

export function createPkce() {
  const verifier = base64url(crypto.randomBytes(32));
  const challenge = base64url(crypto.createHash('sha256').update(verifier).digest());
  const state = base64url(crypto.randomBytes(16));
  return { verifier, challenge, state };
}

export function safeEqual(left, right) {
  const a = Buffer.from(String(left ?? ''));
  const b = Buffer.from(String(right ?? ''));
  if (a.length !== b.length) return false;
  return crypto.timingSafeEqual(a, b);
}

export function buildAuthorizeUrl({
  loginUrl,
  clientId,
  redirectUri,
  state,
  codeChallenge,
  scopes = 'api refresh_token',
}) {
  const url = new URL('/services/oauth2/authorize', loginUrl);
  url.searchParams.set('response_type', 'code');
  url.searchParams.set('client_id', clientId);
  url.searchParams.set('redirect_uri', redirectUri);
  url.searchParams.set('scope', scopes);
  url.searchParams.set('state', state);
  url.searchParams.set('code_challenge', codeChallenge);
  url.searchParams.set('code_challenge_method', 'S256');
  return url.toString();
}

export function normalizeLoginUrl(input) {
  const raw = String(input ?? '').trim();
  if (!raw) return { ok: false, error: 'Enter a Salesforce login URL.' };

  const withProtocol = /^https?:\/\//i.test(raw) ? raw : `https://${raw}`;
  let url;
  try {
    url = new URL(withProtocol);
  } catch {
    return { ok: false, error: 'Enter a valid Salesforce login URL.' };
  }

  if (url.username || url.password) {
    return { ok: false, error: 'Salesforce login URL must not include a username or password.' };
  }
  if (url.protocol !== 'https:') {
    return { ok: false, error: 'Salesforce login URL must use https.' };
  }
  if (url.port) {
    return { ok: false, error: 'Salesforce login URL must not include a port.' };
  }
  if (url.pathname !== '/' && url.pathname !== '') {
    return { ok: false, error: 'Salesforce login URL must not include a path.' };
  }

  const host = url.hostname.toLowerCase();
  const allowed = host === 'login.salesforce.com'
    || host === 'test.salesforce.com'
    || host.endsWith('.salesforce.com')
    || host.endsWith('.force.com');
  if (!allowed) {
    return { ok: false, error: 'Use login.salesforce.com, test.salesforce.com, or a Salesforce My Domain.' };
  }

  return { ok: true, url: `https://${host}` };
}
