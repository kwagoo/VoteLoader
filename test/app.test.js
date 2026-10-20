import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import { once } from 'node:events';
import test from 'node:test';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createApp, publicDirectory } from '../src/app.js';

const ELECTION = 'a0E000000000001';
const ALICE = 'a01000000000001';
const BOB = 'a01000000000002';

function cookieHeader(response) {
  const cookies = typeof response.headers.getSetCookie === 'function'
    ? response.headers.getSetCookie()
    : [response.headers.get('set-cookie')].filter(Boolean);
  return cookies.map((cookie) => cookie.split(';')[0]).join('; ');
}

async function listen(app) {
  const server = app.listen(0, '127.0.0.1');
  await once(server, 'listening');
  return {
    server,
    base: `http://127.0.0.1:${server.address().port}`,
    close() {
      return new Promise((resolve) => {
        server.close(resolve);
        server.closeAllConnections?.();
      });
    },
  };
}

test('preview and upload wait for confirmation and skip flagged rows', async (t) => {
  const inserts = [];
  const app = createApp({
    cookieSecret: 'test-secret',
    clientId: 'client-id',
    clientSecret: 'client-secret',
    redirectUri: 'http://localhost:3000/api/org/salesforce/callback',
    testUser: { accessToken: 'token' },
    insertRecords: async ({ type, records }) => {
      inserts.push({ type, records });
      return records.map((record, index) => ({
        success: true,
        id: `${type}-${inserts.length}-${index}`,
        errors: [],
      }));
    },
  });
  const running = await listen(app);
  const { base } = running;
  t.after(() => running.close());

  const anonymous = createApp({
    cookieSecret: 'test-secret',
    clientId: 'client-id',
    clientSecret: 'client-secret',
  });
  const anonymousRun = await listen(anonymous);
  t.after(() => anonymousRun.close());
  const blocked = await fetch(`${anonymousRun.base}/api/preview`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ csv: 'a', electionId: ELECTION }),
  });
  assert.equal(blocked.status, 401);
  assert.equal(inserts.length, 0);

  const previewResponse = await fetch(`${base}/api/preview`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      csv: `Ballot papers,${ALICE},${BOB}\n1,2,3\n2,1,\n`,
      electionId: ELECTION,
    }),
  });
  assert.equal(previewResponse.status, 200);
  const preview = await previewResponse.json();
  assert.equal(preview.summary.flagged, 1);
  assert.equal(preview.summary.valid, 1);
  assert.equal(inserts.length, 0);

  const cookie = cookieHeader(previewResponse);
  const refused = await fetch(`${base}/api/upload`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', cookie },
    body: JSON.stringify({ previewId: preview.previewId, skipFlagged: false }),
  });
  assert.equal(refused.status, 400);
  assert.equal(inserts.length, 0);

  const upload = await fetch(`${base}/api/upload`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', cookie },
    body: JSON.stringify({ previewId: preview.previewId, skipFlagged: true }),
  });
  assert.equal(upload.status, 200);
  const events = (await upload.text()).trim().split('\n').map((line) => JSON.parse(line));
  assert.equal(events[0].type, 'progress');
  assert.equal(events.at(-1).type, 'done');
  assert.equal(events.at(-1).summary.votesCreated, 1);
  assert.equal(events.at(-1).summary.skipped, 1);
  assert.equal(inserts[0].type, 'Vote__c');
  assert.equal(inserts[0].records.length, 1);
  assert.equal(inserts[0].records[0].CurrentCandidate__c, ALICE);
  assert.equal(inserts[1].type, 'VotePreference__c');
  assert.equal(inserts[1].records.length, 2);
  assert.equal(inserts[1].records[0].Vote__c, 'Vote__c-1-0');
  assert.equal(inserts[1].records[0].CandidateId__c, ALICE);
  assert.equal(inserts[1].records[0].NormalisedEntry__c, 1);
  assert.equal(inserts[1].records[1].CandidateId__c, BOB);
  assert.equal(inserts[1].records[1].NormalisedEntry__c, null);
  assert.equal(events.at(-1).summary.preferencesCreated, 2);
  assert.match(events.at(-1).csv, /skipped/);
  assert.match(events.at(-1).csv, /Vote__c-1-0,,2,0,/);
  assert.equal(preview.summary.preferences, 4);
});

test('bad candidate headers are not uploaded', async (t) => {
  const inserts = [];
  const app = createApp({
    cookieSecret: 'test-secret',
    clientId: 'client-id',
    clientSecret: 'client-secret',
    testUser: { accessToken: 'token' },
    insertRecords: async ({ records }) => {
      inserts.push(records);
      return [];
    },
  });
  const running = await listen(app);
  const { base } = running;
  t.after(() => running.close());

  const previewResponse = await fetch(`${base}/api/preview`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      csv: `Ballot papers,Alice\n1,1\n`,
      electionId: ELECTION,
    }),
  });
  const preview = await previewResponse.json();
  assert.match(preview.headerIssues[0].message, /Alice/);
  const upload = await fetch(`${base}/api/upload`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      cookie: cookieHeader(previewResponse),
    },
    body: JSON.stringify({ previewId: preview.previewId, skipFlagged: true }),
  });
  assert.equal(upload.status, 400);
  assert.match(await upload.text(), /header/i);
  assert.equal(inserts.length, 0);
});

test('OAuth login builds a PKCE authorize URL and the callback rejects a missing state', async (t) => {
  const app = createApp({
    cookieSecret: 'test-secret',
    clientId: 'client-id',
    clientSecret: 'client-secret',
    redirectUri: 'http://localhost:3000/api/org/salesforce/callback',
  });
  const running = await listen(app);
  const { base } = running;
  t.after(() => running.close());

  const rejected = await fetch(`${base}/api/org/salesforce/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ loginUrl: 'https://evil.example' }),
  });
  assert.equal(rejected.status, 400);

  const login = await fetch(`${base}/api/org/salesforce/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ loginUrl: 'https://test.salesforce.com' }),
  });
  assert.equal(login.status, 200);
  const body = await login.json();
  const authorize = new URL(body.authorizeUrl);
  assert.equal(authorize.origin, 'https://test.salesforce.com');
  assert.equal(authorize.searchParams.get('code_challenge_method'), 'S256');
  assert.equal(
    authorize.searchParams.get('redirect_uri'),
    'http://localhost:3000/api/org/salesforce/callback',
  );

  const callback = await fetch(`${base}/api/org/salesforce/callback`, { redirect: 'manual' });
  assert.equal(callback.status, 302);
  assert.match(decodeURIComponent(callback.headers.get('location')), /login state did not match/);

  const me = await fetch(`${base}/api/me`);
  assert.deepEqual(await me.json(), { connected: false });
});

test('callback sends the session PKCE verifier and keeps the connected user', async (t) => {
  const calls = [];
  const fetchImpl = async (url, options) => {
    calls.push({ url, body: options.body?.toString?.() ?? '' });
    if (String(url).endsWith('/services/oauth2/token')) {
      return {
        ok: true,
        status: 200,
        text: async () => JSON.stringify({
          access_token: 'access-token',
          refresh_token: 'refresh-token',
          instance_url: 'https://acme.my.salesforce.com',
          id: 'https://test.salesforce.com/id/00D000000000001/005000000000001',
        }),
      };
    }
    if (String(url).includes('/id/')) {
      return {
        ok: true,
        status: 200,
        text: async () => JSON.stringify({
          display_name: 'Edison',
          username: 'edison@example.com',
          email: 'edison@example.com',
          user_id: '005000000000001',
          organization_id: '00D000000000001',
        }),
      };
    }
    if (String(url).includes('/query')) {
      return {
        ok: true,
        status: 200,
        text: async () => JSON.stringify({ records: [{ Name: 'County Org' }] }),
      };
    }
    throw new Error(`Unexpected request ${url}`);
  };

  const app = createApp({
    cookieSecret: 'test-secret',
    clientId: 'client-id',
    clientSecret: 'client-secret',
    redirectUri: 'http://localhost:3000/api/org/salesforce/callback',
    fetchImpl,
  });
  const running = await listen(app);
  t.after(() => running.close());

  const login = await fetch(`${running.base}/api/org/salesforce/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ loginUrl: 'https://test.salesforce.com' }),
  });
  const started = await login.json();
  const authorize = new URL(started.authorizeUrl);
  const callback = await fetch(
    `${running.base}/api/org/salesforce/callback?code=auth-code&state=${authorize.searchParams.get('state')}`,
    { headers: { cookie: cookieHeader(login) }, redirect: 'manual' },
  );
  assert.equal(callback.status, 302);
  assert.equal(callback.headers.get('location'), '/');

  const token = new URLSearchParams(calls[0].body);
  assert.equal(calls[0].url, 'https://test.salesforce.com/services/oauth2/token');
  assert.equal(token.get('grant_type'), 'authorization_code');
  assert.equal(token.get('code'), 'auth-code');
  assert.equal(token.get('client_id'), 'client-id');
  assert.equal(token.get('redirect_uri'), 'http://localhost:3000/api/org/salesforce/callback');
  const challenge = crypto.createHash('sha256').update(token.get('code_verifier')).digest('base64url');
  assert.equal(challenge, authorize.searchParams.get('code_challenge'));

  const me = await fetch(`${running.base}/api/me`, {
    headers: { cookie: cookieHeader(callback) },
  });
  assert.deepEqual(await me.json(), {
    connected: true,
    instanceUrl: 'https://acme.my.salesforce.com',
    loginUrl: 'https://test.salesforce.com',
    user: {
      name: 'Edison',
      username: 'edison@example.com',
      email: 'edison@example.com',
      userId: '005000000000001',
      orgId: '00D000000000001',
      orgName: 'County Org',
    },
  });
});

test('the app serves the ballot pages from memory and from public/', async (t) => {
  const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
  const pages = {
    'index.html': fs.readFileSync(path.join(root, 'public', 'index.html'), 'utf8'),
    'styles.css': fs.readFileSync(path.join(root, 'public', 'styles.css'), 'utf8'),
    'app.js': fs.readFileSync(path.join(root, 'public', 'app.js'), 'utf8'),
  };
  const app = createApp({ cookieSecret: 'test-secret', pages });
  const running = await listen(app);
  t.after(() => running.close());

  const home = await fetch(`${running.base}/`);
  assert.equal(home.status, 200);
  assert.match(home.headers.get('content-type'), /text\/html/);
  const html = await home.text();
  assert.match(html, /Salesforce ballot loader/);
  assert.match(html, /empty normalised entry/);

  const css = await fetch(`${running.base}/styles.css`);
  assert.equal(css.status, 200);
  assert.match(await css.text(), /max-width: 880px/);

  const script = await fetch(`${running.base}/app.js`);
  assert.equal(script.status, 200);
  assert.match(await script.text(), /preferences/);

  const missing = await fetch(`${running.base}/secret.env`);
  assert.equal(missing.status, 404);

  const disk = createApp({ cookieSecret: 'test-secret' });
  const diskRun = await listen(disk);
  t.after(() => diskRun.close());
  const fromDisk = await fetch(`${diskRun.base}/`);
  assert.equal(fromDisk.status, 200);
  assert.match(await fromDisk.text(), /Salesforce ballot loader/);
  assert.equal(fs.existsSync(path.join(publicDirectory(), 'index.html')), true);
});
