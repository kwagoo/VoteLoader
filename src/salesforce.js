import { toCollectionBody } from './batch.js';

async function readJson(response) {
  const text = await response.text();
  if (!text) return {};
  try {
    return JSON.parse(text);
  } catch {
    return { error_description: text };
  }
}

export async function postToken({ fetchImpl, loginUrl, params }) {
  const response = await fetchImpl(`${loginUrl}/services/oauth2/token`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/x-www-form-urlencoded',
      Accept: 'application/json',
    },
    body: new URLSearchParams(params),
  });
  const body = await readJson(response);
  if (!response.ok) {
    const error = new Error(body.error_description || body.error || `Token request failed (${response.status})`);
    error.status = response.status;
    throw error;
  }
  return body;
}

export function exchangeAuthorizationCode({
  fetchImpl,
  loginUrl,
  clientId,
  clientSecret,
  redirectUri,
  code,
  codeVerifier,
}) {
  return postToken({
    fetchImpl,
    loginUrl,
    params: {
      grant_type: 'authorization_code',
      code,
      client_id: clientId,
      client_secret: clientSecret,
      redirect_uri: redirectUri,
      code_verifier: codeVerifier,
    },
  });
}

export function refreshAccessToken({
  fetchImpl,
  loginUrl,
  clientId,
  clientSecret,
  refreshToken,
}) {
  return postToken({
    fetchImpl,
    loginUrl,
    params: {
      grant_type: 'refresh_token',
      refresh_token: refreshToken,
      client_id: clientId,
      client_secret: clientSecret,
    },
  });
}

export async function revokeToken({ fetchImpl, loginUrl, token }) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 5000);
  let response;
  try {
    response = await fetchImpl(`${loginUrl}/services/oauth2/revoke`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ token }),
      signal: controller.signal,
    });
  } finally {
    clearTimeout(timer);
  }
  if (!response.ok) {
    const error = new Error(`Revoke failed (${response.status})`);
    error.status = response.status;
    throw error;
  }
}

export async function fetchIdentity({ fetchImpl, identityUrl, accessToken }) {
  const response = await fetchImpl(identityUrl, {
    headers: {
      Authorization: `Bearer ${accessToken}`,
      Accept: 'application/json',
    },
  });
  const body = await readJson(response);
  if (!response.ok) {
    const error = new Error(body.error_description || body.message || `Identity request failed (${response.status})`);
    error.status = response.status;
    throw error;
  }
  return body;
}

export async function fetchOrganizationName({ fetchImpl, instanceUrl, accessToken, apiVersion }) {
  const query = 'SELECT Name FROM Organization';
  const url = `${instanceUrl}/services/data/v${apiVersion}/query?q=${encodeURIComponent(query)}`;
  const response = await fetchImpl(url, {
    headers: {
      Authorization: `Bearer ${accessToken}`,
      Accept: 'application/json',
    },
  });
  const body = await readJson(response);
  if (!response.ok) {
    const message = body[0]?.message || body.message || `Organization query failed (${response.status})`;
    const error = new Error(message);
    error.status = response.status;
    throw error;
  }
  return body.records?.[0]?.Name || '';
}

export async function insertSObjectCollection({
  fetchImpl,
  instanceUrl,
  accessToken,
  apiVersion,
  type,
  records,
}) {
  const response = await fetchImpl(
    `${instanceUrl}/services/data/v${apiVersion}/composite/sobjects`,
    {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${accessToken}`,
        'Content-Type': 'application/json',
        Accept: 'application/json',
      },
      body: JSON.stringify(toCollectionBody(type, records)),
    },
  );
  if (!response.ok) {
    const text = await response.text();
    const error = new Error(`Salesforce insert failed (${response.status}): ${text}`);
    error.status = response.status;
    throw error;
  }
  const body = await response.json();
  if (!Array.isArray(body)) {
    throw new Error('Salesforce returned an unexpected result for this batch.');
  }
  return body;
}

export function createInserter({ fetchImpl, session, clientId, clientSecret, apiVersion }) {
  let refreshed = false;

  return async function insertRecords({ type, records }) {
    try {
      return await insertSObjectCollection({
        fetchImpl,
        instanceUrl: session.instanceUrl,
        accessToken: session.accessToken,
        apiVersion,
        type,
        records,
      });
    } catch (error) {
      if (error.status !== 401 || refreshed || !session.refreshToken) throw error;
      refreshed = true;
      const tokens = await refreshAccessToken({
        fetchImpl,
        loginUrl: session.loginUrl,
        clientId,
        clientSecret,
        refreshToken: session.refreshToken,
      });
      session.accessToken = tokens.access_token;
      if (tokens.instance_url) session.instanceUrl = tokens.instance_url;
      return insertSObjectCollection({
        fetchImpl,
        instanceUrl: session.instanceUrl,
        accessToken: session.accessToken,
        apiVersion,
        type,
        records,
      });
    }
  };
}
