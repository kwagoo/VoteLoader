import express from 'express';
import session from 'express-session';
import crypto from 'node:crypto';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { analyzeCsv, selectRowsForUpload } from './csv.js';
import { buildResultsCsv, uploadBallots } from './batch.js';
import { buildAuthorizeUrl, createPkce, normalizeLoginUrl, safeEqual } from './oauth.js';
import {
  createInserter,
  exchangeAuthorizationCode,
  fetchIdentity,
  fetchOrganizationName,
  revokeToken,
} from './salesforce.js';

const PUBLIC_DIR = path.join(path.dirname(fileURLToPath(import.meta.url)), '../public');
const PREVIEW_TTL_MS = 60 * 60 * 1000;

export function readConfig(env = process.env) {
  return {
    clientId: env.SALESFORCE_CLIENT_ID || '',
    clientSecret: env.SALESFORCE_CLIENT_SECRET || '',
    redirectUri: env.SALESFORCE_REDIRECT_URI || 'http://localhost:3000/api/org/salesforce/callback',
    defaultLoginUrl: env.SALESFORCE_LOGIN_URL || 'https://login.salesforce.com',
    cookieSecret: env.COOKIE_SECRET || '',
    port: Number(env.PORT || 3000),
    apiVersion: env.SALESFORCE_API_VERSION || '59.0',
  };
}

function queryValue(value) {
  if (Array.isArray(value)) return value[0] ?? '';
  return value ?? '';
}

export function createApp(options = {}) {
  const config = {
    clientId: options.clientId ?? '',
    clientSecret: options.clientSecret ?? '',
    redirectUri: options.redirectUri || 'http://localhost:3000/api/org/salesforce/callback',
    defaultLoginUrl: options.defaultLoginUrl || 'https://login.salesforce.com',
    cookieSecret: options.cookieSecret,
    apiVersion: options.apiVersion || '59.0',
  };
  if (!config.cookieSecret) {
    throw new Error('COOKIE_SECRET is required');
  }

  const fetchImpl = options.fetchImpl ?? globalThis.fetch;
  const previews = options.previews ?? new Map();
  const app = express();
  app.disable('x-powered-by');
  app.use(express.json({ limit: '15mb' }));
  app.use(session({
    name: 'voteloader.sid',
    secret: config.cookieSecret,
    resave: false,
    saveUninitialized: false,
    cookie: {
      httpOnly: true,
      sameSite: 'lax',
      secure: false,
      maxAge: 12 * 60 * 60 * 1000,
    },
  }));

  if (options.testUser) {
    app.use((req, _res, next) => {
      req.session.sf = {
        accessToken: 'test-token',
        instanceUrl: 'https://example.my.salesforce.com',
        loginUrl: 'https://login.salesforce.com',
        user: {
          name: 'Edison',
          username: 'edison@example.com',
          orgId: '00D000000000001',
          orgName: 'Test Org',
        },
        ...options.testUser,
      };
      next();
    });
  }

  function oauthConfigured() {
    return Boolean(config.clientId && config.clientSecret && config.redirectUri);
  }

  function requireConnection(req, res, next) {
    if (!req.session.sf?.accessToken) {
      res.status(401).json({ error: 'Connect to Salesforce first.' });
      return;
    }
    next();
  }

  app.get('/api/config', (_req, res) => {
    const login = normalizeLoginUrl(config.defaultLoginUrl);
    res.json({
      oauthConfigured: oauthConfigured(),
      redirectUri: config.redirectUri,
      defaultLoginUrl: login.ok ? login.url : 'https://login.salesforce.com',
    });
  });

  app.get('/api/me', (req, res) => {
    const sf = req.session.sf;
    if (!sf?.accessToken) {
      res.json({ connected: false });
      return;
    }
    res.json({
      connected: true,
      instanceUrl: sf.instanceUrl,
      loginUrl: sf.loginUrl,
      user: sf.user,
    });
  });

  app.post('/api/org/salesforce/login', (req, res) => {
    if (!oauthConfigured()) {
      res.status(500).json({
        error: 'Set SALESFORCE_CLIENT_ID and SALESFORCE_CLIENT_SECRET in .env, then restart VoteLoader.',
      });
      return;
    }
    const normalized = normalizeLoginUrl(req.body?.loginUrl || config.defaultLoginUrl);
    if (!normalized.ok) {
      res.status(400).json({ error: normalized.error });
      return;
    }
    const pkce = createPkce();
    req.session.oauth = {
      state: pkce.state,
      verifier: pkce.verifier,
      loginUrl: normalized.url,
    };
    const authorizeUrl = buildAuthorizeUrl({
      loginUrl: normalized.url,
      clientId: config.clientId,
      redirectUri: config.redirectUri,
      state: pkce.state,
      codeChallenge: pkce.challenge,
    });
    req.session.save((error) => {
      if (error) {
        res.status(500).json({ error: 'Could not start the login session.' });
        return;
      }
      res.json({ authorizeUrl });
    });
  });

  app.get('/api/org/salesforce/callback', async (req, res) => {
    const redirectError = (message) => {
      res.redirect(`/?error=${encodeURIComponent(message)}`);
    };
    try {
      const oauthError = queryValue(req.query.error_description) || queryValue(req.query.error);
      if (oauthError) {
        redirectError(oauthError);
        return;
      }
      const oauth = req.session.oauth;
      const state = queryValue(req.query.state);
      if (!oauth?.state || !oauth.verifier || !safeEqual(oauth.state, state)) {
        redirectError('Salesforce login state did not match. Try connecting again.');
        return;
      }
      const code = queryValue(req.query.code);
      if (!code) {
        redirectError('Salesforce did not return an authorization code.');
        return;
      }

      const tokens = await exchangeAuthorizationCode({
        fetchImpl,
        loginUrl: oauth.loginUrl,
        clientId: config.clientId,
        clientSecret: config.clientSecret,
        redirectUri: config.redirectUri,
        code,
        codeVerifier: oauth.verifier,
      });
      const identity = await fetchIdentity({
        fetchImpl,
        identityUrl: tokens.id,
        accessToken: tokens.access_token,
      });
      let orgName = '';
      try {
        orgName = await fetchOrganizationName({
          fetchImpl,
          instanceUrl: tokens.instance_url,
          accessToken: tokens.access_token,
          apiVersion: config.apiVersion,
        });
      } catch (error) {
        console.error('Organization name lookup failed:', error.message);
      }

      const sf = {
        accessToken: tokens.access_token,
        refreshToken: tokens.refresh_token || null,
        instanceUrl: tokens.instance_url,
        loginUrl: oauth.loginUrl,
        identityUrl: tokens.id,
        user: {
          name: identity.display_name || identity.nick_name || identity.username || 'Salesforce user',
          username: identity.username || '',
          email: identity.email || '',
          userId: identity.user_id || '',
          orgId: identity.organization_id || '',
          orgName,
        },
      };

      req.session.regenerate((error) => {
        if (error) {
          redirectError('Could not save the Salesforce session.');
          return;
        }
        req.session.sf = sf;
        req.session.save(() => {
          res.redirect('/');
        });
      });
    } catch (error) {
      redirectError(error.message || 'Salesforce login failed.');
    }
  });

  app.post('/api/logout', async (req, res) => {
    const sf = req.session.sf;
    if (sf?.accessToken) {
      try {
        await revokeToken({
          fetchImpl,
          loginUrl: sf.loginUrl || sf.instanceUrl,
          token: sf.refreshToken || sf.accessToken,
        });
      } catch (error) {
        console.error('Token revoke failed:', error.message);
      }
    }
    req.session.destroy(() => {
      res.json({ ok: true });
    });
  });

  app.post('/api/preview', requireConnection, (req, res) => {
    const now = Date.now();
    for (const [id, preview] of previews) {
      if (now - preview.createdAt > PREVIEW_TTL_MS) previews.delete(id);
    }
    const analysis = analyzeCsv(String(req.body?.csv ?? ''), req.body?.electionId ?? '');
    const previewId = crypto.randomBytes(16).toString('hex');
    previews.set(previewId, {
      sessionId: req.sessionID,
      analysis,
      createdAt: now,
      started: false,
    });
    res.json({ previewId, ...analysis });
  });

  app.post('/api/upload', requireConnection, async (req, res) => {
    const preview = previews.get(req.body?.previewId);
    if (!preview || preview.sessionId !== req.sessionID) {
      res.status(400).json({ error: 'Preview expired. Check the CSV again.' });
      return;
    }
    const selected = selectRowsForUpload(preview.analysis, {
      skipFlagged: Boolean(req.body?.skipFlagged),
    });
    if (!selected.ok) {
      res.status(400).json({ error: selected.error });
      return;
    }
    if (preview.started) {
      res.status(409).json({
        error: 'This preview was already submitted. Preview the CSV again. Check Salesforce before a second load, because some rows may already exist.',
      });
      return;
    }
    preview.started = true;

    res.setHeader('Content-Type', 'application/x-ndjson; charset=utf-8');
    res.setHeader('Cache-Control', 'no-cache, no-transform');
    res.setHeader('X-Accel-Buffering', 'no');
    if (typeof res.flushHeaders === 'function') res.flushHeaders();

    const write = (event) => {
      res.write(`${JSON.stringify(event)}\n`);
    };

    const insertRecords = options.insertRecords ?? createInserter({
      fetchImpl,
      session: req.session.sf,
      clientId: config.clientId,
      clientSecret: config.clientSecret,
      apiVersion: config.apiVersion,
    });

    try {
      const uploaded = await uploadBallots({
        rows: selected.rows,
        electionId: preview.analysis.electionId,
        insertRecords,
        onProgress: async (event) => {
          console.log(
            `${event.phase} batch ${event.batch}/${event.batches}: ${event.batchSucceeded} succeeded, ${event.batchFailed} failed`,
          );
          write({ type: 'progress', ...event });
        },
      });

      const skipped = preview.analysis.rows
        .filter((row) => row.flagged && !selected.rows.includes(row))
        .map((row) => ({
          rowNumber: row.rowNumber,
          ballot: row.ballot,
          status: 'skipped',
          voteId: null,
          voteError: row.issues.join('; '),
          preferencesCreated: 0,
          preferencesFailed: 0,
          preferenceErrors: '',
        }));

      const results = [...uploaded.results, ...skipped].sort((a, b) => a.rowNumber - b.rowNumber);
      const summary = { ...uploaded.summary, skipped: skipped.length };
      write({ type: 'done', summary, results, csv: buildResultsCsv(results) });
      res.end();
    } catch (error) {
      console.error(error);
      write({ type: 'error', error: error.message || 'Upload failed.' });
      res.end();
    }
  });

  app.use(express.static(PUBLIC_DIR));

  app.use((error, _req, res, _next) => {
    console.error(error);
    if (res.headersSent) {
      res.end();
      return;
    }
    res.status(500).json({ error: 'Something went wrong.' });
  });

  return app;
}
