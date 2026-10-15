import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import test from 'node:test';
import { buildAuthorizeUrl, createPkce, normalizeLoginUrl } from '../src/oauth.js';

test('PKCE challenge is the base64url SHA-256 of the verifier', () => {
  const pkce = createPkce();
  assert.match(pkce.verifier, /^[A-Za-z0-9_-]{43,128}$/);
  assert.match(pkce.state, /^[A-Za-z0-9_-]+$/);
  const expected = crypto
    .createHash('sha256')
    .update(pkce.verifier)
    .digest('base64')
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=+$/, '');
  assert.equal(pkce.challenge, expected);
});

test('authorize URL uses the web server flow and S256 PKCE', () => {
  const url = new URL(buildAuthorizeUrl({
    loginUrl: 'https://test.salesforce.com',
    clientId: 'client-id',
    redirectUri: 'http://localhost:3000/api/org/salesforce/callback',
    state: 'state-1',
    codeChallenge: 'challenge-1',
  }));

  assert.equal(url.origin, 'https://test.salesforce.com');
  assert.equal(url.pathname, '/services/oauth2/authorize');
  assert.equal(url.searchParams.get('response_type'), 'code');
  assert.equal(url.searchParams.get('client_id'), 'client-id');
  assert.equal(url.searchParams.get('redirect_uri'), 'http://localhost:3000/api/org/salesforce/callback');
  assert.equal(url.searchParams.get('code_challenge'), 'challenge-1');
  assert.equal(url.searchParams.get('code_challenge_method'), 'S256');
  assert.equal(url.searchParams.get('state'), 'state-1');
  assert.match(url.searchParams.get('scope'), /\bapi\b/);
  assert.match(url.searchParams.get('scope'), /refresh_token/);
});

test('login URL toggle accepts production, sandbox, and a My Domain', () => {
  assert.equal(normalizeLoginUrl('https://login.salesforce.com').url, 'https://login.salesforce.com');
  assert.equal(normalizeLoginUrl('https://test.salesforce.com/').url, 'https://test.salesforce.com');
  assert.equal(
    normalizeLoginUrl('https://acme.my.salesforce.com').url,
    'https://acme.my.salesforce.com',
  );
  assert.equal(
    normalizeLoginUrl('acme--dev.sandbox.my.salesforce.com').url,
    'https://acme--dev.sandbox.my.salesforce.com',
  );
  assert.equal(normalizeLoginUrl('https://evil.example').ok, false);
  assert.equal(normalizeLoginUrl('http://login.salesforce.com').ok, false);
  assert.equal(normalizeLoginUrl('https://login.salesforce.com.evil.com').ok, false);
  assert.equal(normalizeLoginUrl('https://user:pass@login.salesforce.com').ok, false);
});
