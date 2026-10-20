const banner = document.querySelector('#banner');
const connectPanel = document.querySelector('#connect-panel');
const uploadPanel = document.querySelector('#upload-panel');
const previewPanel = document.querySelector('#preview-panel');
const progressPanel = document.querySelector('#progress-panel');
const summaryPanel = document.querySelector('#summary-panel');
const sessionBox = document.querySelector('#session');
const customDomain = document.querySelector('#custom-domain');
const skipFlagged = document.querySelector('#skip-flagged');

let preview = null;
let resultsCsv = '';

function showBanner(message) {
  if (!message) {
    banner.hidden = true;
    banner.textContent = '';
    return;
  }
  banner.hidden = false;
  banner.textContent = message;
}

function selectedLoginUrl() {
  const selected = document.querySelector('input[name="login"]:checked').value;
  if (selected === 'custom') return customDomain.value.trim();
  return selected;
}

function setConnected(me) {
  const connected = Boolean(me?.connected);
  connectPanel.hidden = connected;
  uploadPanel.hidden = !connected;
  sessionBox.hidden = !connected;
  if (!connected) {
    previewPanel.hidden = true;
    progressPanel.hidden = true;
    summaryPanel.hidden = true;
    return;
  }
  const user = me.user || {};
  const name = user.name || 'Salesforce user';
  const username = user.username ? ` (${user.username})` : '';
  document.querySelector('#who').textContent = `Connected as ${name}${username}`;
  const org = user.orgName || 'Salesforce org';
  const orgId = user.orgId ? ` · ${user.orgId}` : '';
  let host = '';
  try {
    host = me.instanceUrl ? ` · ${new URL(me.instanceUrl).host}` : '';
  } catch {
    host = me.instanceUrl ? ` · ${me.instanceUrl}` : '';
  }
  document.querySelector('#org').textContent = `${org}${orgId}${host}`;
}

function renderIssues(container, title, messages) {
  container.replaceChildren();
  if (!messages.length) return;
  const heading = document.createElement('h3');
  heading.textContent = title;
  const list = document.createElement('ul');
  list.className = 'issue-list';
  for (const message of messages) {
    const item = document.createElement('li');
    item.textContent = message;
    list.append(item);
  }
  container.append(heading, list);
}

function updateUploadGate() {
  const hint = document.querySelector('#upload-hint');
  const button = document.querySelector('#upload-button');
  if (!preview) {
    button.disabled = true;
    return;
  }
  const headerProblems = preview.headerIssues.length > 0;
  const electionProblem = Boolean(preview.electionIssue);
  const flagged = preview.summary.flagged;
  const readyRows = skipFlagged.checked ? preview.summary.valid : preview.summary.valid + flagged;
  document.querySelector('#skip-label').hidden = flagged === 0;

  if (electionProblem) {
    hint.textContent = preview.electionIssue;
    button.disabled = true;
    return;
  }
  if (headerProblems) {
    hint.textContent = 'Fix the candidate ID headers, then preview again. Flagged rows cannot bypass a bad header.';
    button.disabled = true;
    return;
  }
  if (flagged > 0 && !skipFlagged.checked) {
    hint.textContent = 'Choose skip flagged rows, or fix the CSV and preview again. Nothing is uploaded until you confirm.';
    button.disabled = true;
    return;
  }
  if (readyRows === 0) {
    hint.textContent = 'No rows left to upload.';
    button.disabled = true;
    return;
  }
  const noun = readyRows === 1 ? 'vote' : 'votes';
  hint.textContent = `Ready to create ${readyRows} ${noun}. Nothing is sent until you confirm.`;
  button.disabled = false;
  button.textContent = `Upload ${readyRows} ${noun} to Salesforce`;
}

function renderPreview(data) {
  preview = data;
  resultsCsv = '';
  previewPanel.hidden = false;
  progressPanel.hidden = true;
  summaryPanel.hidden = true;
  skipFlagged.checked = false;

  const summary = data.summary;
  const sample = data.rows.find((row) => !row.flagged);
  const blanks = sample ? sample.preferences.filter((preference) => preference.value == null).length : 0;
  const sampleText = sample
    ? ` Row ${sample.rowNumber} becomes a Formal vote for ${sample.firstPreferenceCandidateId} with ${sample.preferences.length} preferences${blanks ? ` (${blanks} blank)` : ''}.`
    : '';
  const preferenceCount = summary.preferences ?? 0;
  document.querySelector('#preview-summary').textContent =
    `${summary.dataRows} data rows, ${preferenceCount} preferences: ${summary.valid} valid, ${summary.flagged} flagged.${sampleText}`;

  const headerMessages = [];
  if (data.electionIssue) headerMessages.push(data.electionIssue);
  headerMessages.push(...data.headerIssues.map((issue) => issue.message));
  renderIssues(document.querySelector('#header-issues'), 'Fix before upload', headerMessages);

  const flaggedRows = data.rows.filter((row) => row.flagged);
  const rowBox = document.querySelector('#row-issues');
  rowBox.replaceChildren();
  if (flaggedRows.length) {
    const heading = document.createElement('h3');
    heading.textContent = 'Flagged rows';
    const table = document.createElement('table');
    const head = document.createElement('tr');
    for (const label of ['Row', 'Ballot', 'Issues']) {
      const cell = document.createElement('th');
      cell.textContent = label;
      head.append(cell);
    }
    table.append(head);
    for (const row of flaggedRows.slice(0, 200)) {
      const line = document.createElement('tr');
      for (const value of [row.rowNumber, row.ballot || '—', row.issues.join(' ')]) {
        const cell = document.createElement('td');
        cell.textContent = value;
        line.append(cell);
      }
      table.append(line);
    }
    rowBox.append(heading, table);
    if (flaggedRows.length > 200) {
      const note = document.createElement('p');
      note.className = 'hint-block';
      note.textContent = `Showing the first 200 of ${flaggedRows.length} flagged rows.`;
      rowBox.append(note);
    }
  }

  updateUploadGate();
}

function renderSummary(event) {
  progressPanel.hidden = true;
  summaryPanel.hidden = false;
  resultsCsv = event.csv || '';
  const summary = event.summary || {};
  const counts = document.querySelector('#summary-counts');
  counts.replaceChildren();
  const items = [
    ['Votes created', summary.votesCreated ?? 0],
    ['Votes failed', summary.votesFailed ?? 0],
    ['Preferences created', summary.preferencesCreated ?? 0],
    ['Preferences failed', summary.preferencesFailed ?? 0],
    ['Rows skipped', summary.skipped ?? 0],
  ];
  for (const [label, value] of items) {
    const wrap = document.createElement('div');
    const term = document.createElement('dt');
    term.textContent = label;
    const amount = document.createElement('dd');
    amount.textContent = value;
    wrap.append(term, amount);
    counts.append(wrap);
  }

  const failed = (event.results || []).filter((row) => row.status === 'failed' || row.preferencesFailed > 0);
  const box = document.querySelector('#failure-table');
  box.replaceChildren();
  if (!failed.length) return;
  const heading = document.createElement('h3');
  heading.textContent = 'Rows with errors';
  const table = document.createElement('table');
  const head = document.createElement('tr');
  for (const label of ['Row', 'Ballot', 'Vote', 'Preferences']) {
    const cell = document.createElement('th');
    cell.textContent = label;
    head.append(cell);
  }
  table.append(head);
  for (const row of failed.slice(0, 100)) {
    const line = document.createElement('tr');
    const vote = row.voteId || row.voteError || row.status;
    const prefs = `${row.preferencesCreated} created, ${row.preferencesFailed} failed`;
    for (const value of [row.rowNumber, row.ballot || '—', vote, row.preferenceErrors ? `${prefs}. ${row.preferenceErrors}` : prefs]) {
      const cell = document.createElement('td');
      cell.textContent = value;
      line.append(cell);
    }
    table.append(line);
  }
  box.append(heading, table);
}

async function readError(response) {
  try {
    const data = await response.json();
    return data.error || `Request failed (${response.status})`;
  } catch {
    return `Request failed (${response.status})`;
  }
}

document.querySelectorAll('input[name="login"]').forEach((input) => {
  input.addEventListener('change', () => {
    customDomain.disabled = input.value !== 'custom' || !input.checked;
    if (document.querySelector('input[name="login"]:checked').value !== 'custom') {
      customDomain.disabled = true;
    }
  });
});

document.querySelector('#connect').addEventListener('click', async () => {
  showBanner('');
  const button = document.querySelector('#connect');
  button.disabled = true;
  try {
    const response = await fetch('/api/org/salesforce/login', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ loginUrl: selectedLoginUrl() }),
    });
    if (!response.ok) throw new Error(await readError(response));
    const data = await response.json();
    window.location = data.authorizeUrl;
  } catch (error) {
    showBanner(error.message);
    button.disabled = false;
  }
});

document.querySelector('#logout').addEventListener('click', async () => {
  await fetch('/api/logout', { method: 'POST' });
  preview = null;
  setConnected({ connected: false });
  showBanner('');
});

document.querySelector('#preview-button').addEventListener('click', async () => {
  showBanner('');
  const file = document.querySelector('#csv-file').files[0];
  if (!file) {
    showBanner('Choose a CSV file.');
    return;
  }
  const button = document.querySelector('#preview-button');
  button.disabled = true;
  try {
    const csv = await file.text();
    const response = await fetch('/api/preview', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        csv,
        electionId: document.querySelector('#election-id').value,
      }),
    });
    if (!response.ok) throw new Error(await readError(response));
    renderPreview(await response.json());
  } catch (error) {
    showBanner(error.message);
  } finally {
    button.disabled = false;
  }
});

skipFlagged.addEventListener('change', updateUploadGate);

document.querySelector('#upload-button').addEventListener('click', async () => {
  if (!preview) return;
  showBanner('');
  const button = document.querySelector('#upload-button');
  button.disabled = true;
  progressPanel.hidden = false;
  summaryPanel.hidden = true;
  const progressText = document.querySelector('#progress-text');
  const progressBar = document.querySelector('#progress-bar');
  progressText.textContent = 'Starting upload…';
  progressBar.value = 0;

  let streamStarted = false;
  try {
    const response = await fetch('/api/upload', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        previewId: preview.previewId,
        skipFlagged: skipFlagged.checked,
      }),
    });
    if (!response.ok) throw new Error(await readError(response));
    streamStarted = true;

    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    let buffer = '';
    let doneEvent = null;
    while (true) {
      const chunk = await reader.read();
      if (chunk.done) break;
      buffer += decoder.decode(chunk.value, { stream: true });
      const lines = buffer.split('\n');
      buffer = lines.pop() ?? '';
      for (const line of lines) {
        if (!line.trim()) continue;
        const event = JSON.parse(line);
        if (event.type === 'progress') {
          const label = event.phase === 'votes' ? 'votes' : 'preferences';
          progressText.textContent = event.batches
            ? `Inserting ${label}: batch ${event.batch} of ${event.batches} (${event.processed} of ${event.total})`
            : `No ${label} to insert`;
          progressBar.max = event.total || 1;
          progressBar.value = event.processed || 0;
        } else if (event.type === 'error') {
          throw new Error(event.error || 'Upload failed.');
        } else if (event.type === 'done') {
          doneEvent = event;
        }
      }
    }
    if (!doneEvent) throw new Error('Upload ended before a summary was returned.');
    renderSummary(doneEvent);
    preview = null;
    updateUploadGate();
  } catch (error) {
    progressPanel.hidden = true;
    if (streamStarted) {
      preview = null;
      showBanner(`${error.message} Preview the CSV again before another upload. Votes already created are in Salesforce.`);
    } else {
      showBanner(error.message);
    }
    updateUploadGate();
  }
});

document.querySelector('#download-button').addEventListener('click', () => {
  if (!resultsCsv) return;
  const blob = new Blob([resultsCsv], { type: 'text/csv;charset=utf-8' });
  const url = URL.createObjectURL(blob);
  const link = document.createElement('a');
  link.href = url;
  link.download = 'voteloader-results.csv';
  link.click();
  URL.revokeObjectURL(url);
});

async function boot() {
  const params = new URLSearchParams(window.location.search);
  if (params.get('error')) {
    showBanner(params.get('error'));
    window.history.replaceState({}, '', '/');
  }
  const config = await fetch('/api/config').then((response) => response.json());
  document.querySelector('#redirect-uri').textContent = config.redirectUri;
  const warning = document.querySelector('#config-warning');
  if (!config.oauthConfigured) {
    warning.hidden = false;
    warning.textContent = 'SALESFORCE_CLIENT_ID and SALESFORCE_CLIENT_SECRET are missing from .env. Add them and restart.';
    document.querySelector('#connect').disabled = true;
  }
  const known = ['https://login.salesforce.com', 'https://test.salesforce.com'];
  if (known.includes(config.defaultLoginUrl)) {
    document.querySelector(`input[name="login"][value="${config.defaultLoginUrl}"]`).checked = true;
  } else if (config.defaultLoginUrl) {
    document.querySelector('input[name="login"][value="custom"]').checked = true;
    customDomain.disabled = false;
    customDomain.value = config.defaultLoginUrl;
  }
  setConnected(await fetch('/api/me').then((response) => response.json()));
}

boot().catch((error) => showBanner(error.message));
