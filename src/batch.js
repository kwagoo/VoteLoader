import { mapPreferences, mapVote } from './csv.js';

export const BATCH_SIZE = 200;

export function chunk(items, size = BATCH_SIZE) {
  const batches = [];
  for (let index = 0; index < items.length; index += size) {
    batches.push(items.slice(index, index + size));
  }
  return batches;
}

export function toCollectionBody(type, records) {
  return {
    allOrNone: false,
    records: records.map((record) => ({
      ...record,
      attributes: { type },
    })),
  };
}

function errorText(result) {
  if (!result || result.success) return '';
  const errors = Array.isArray(result.errors) ? result.errors : [];
  if (errors.length === 0) return 'Insert failed';
  return errors.map((error) => error.message || error.statusCode || 'Insert failed').join('; ');
}

function failedResult(message) {
  return { success: false, errors: [{ message }] };
}

async function insertBatch(insertRecords, type, records) {
  try {
    const response = await insertRecords({ type, records });
    if (!Array.isArray(response)) {
      return records.map(() => failedResult('Salesforce returned an unexpected result for this batch.'));
    }
    const aligned = response.slice(0, records.length);
    while (aligned.length < records.length) {
      aligned.push(failedResult('Salesforce returned an unexpected result for this batch.'));
    }
    return aligned;
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Insert failed';
    return records.map(() => failedResult(message));
  }
}

export async function uploadBallots({ rows, electionId, insertRecords, onProgress }) {
  const results = rows.map((row) => ({
    rowNumber: row.rowNumber,
    ballot: row.ballot,
    status: 'pending',
    voteId: null,
    voteError: null,
    preferencesCreated: 0,
    preferencesFailed: 0,
    preferenceErrors: '',
  }));

  const voteRecords = rows.map((row) => mapVote(row, electionId));
  const voteBatches = chunk(voteRecords);
  let processedVotes = 0;

  for (let batchIndex = 0; batchIndex < voteBatches.length; batchIndex += 1) {
    const batch = voteBatches[batchIndex];
    const offset = batchIndex * BATCH_SIZE;
    const batchResults = await insertBatch(insertRecords, 'Vote__c', batch);
    let batchSucceeded = 0;
    let batchFailed = 0;

    batch.forEach((_, index) => {
      const result = batchResults[index];
      const target = results[offset + index];
      if (result?.success && result.id) {
        target.voteId = result.id;
        target.status = 'created';
        batchSucceeded += 1;
      } else {
        target.status = 'failed';
        target.voteError = errorText(result) || 'Insert failed';
        target.preferencesFailed = rows[offset + index].preferences.length;
        batchFailed += 1;
      }
    });

    processedVotes += batch.length;
    if (onProgress) {
      await onProgress({
        phase: 'votes',
        batch: batchIndex + 1,
        batches: voteBatches.length,
        batchSucceeded,
        batchFailed,
        processed: processedVotes,
        total: rows.length,
      });
    }
  }

  const preferenceWork = [];
  rows.forEach((row, index) => {
    if (!results[index].voteId) return;
    for (const record of mapPreferences(row, results[index].voteId)) {
      preferenceWork.push({ rowIndex: index, record });
    }
  });

  const preferenceBatches = chunk(preferenceWork);
  let processedPreferences = 0;

  if (preferenceBatches.length === 0 && onProgress) {
    await onProgress({
      phase: 'preferences',
      batch: 0,
      batches: 0,
      batchSucceeded: 0,
      batchFailed: 0,
      processed: 0,
      total: 0,
    });
  }

  for (let batchIndex = 0; batchIndex < preferenceBatches.length; batchIndex += 1) {
    const batch = preferenceBatches[batchIndex];
    const batchResults = await insertBatch(
      insertRecords,
      'VotePreference__c',
      batch.map((item) => item.record),
    );
    let batchSucceeded = 0;
    let batchFailed = 0;
    const errorBuckets = new Map();

    batch.forEach((item, index) => {
      const result = batchResults[index];
      const target = results[item.rowIndex];
      if (result?.success) {
        target.preferencesCreated += 1;
        batchSucceeded += 1;
      } else {
        target.preferencesFailed += 1;
        const messages = errorBuckets.get(item.rowIndex) ?? [];
        messages.push(errorText(result) || 'Insert failed');
        errorBuckets.set(item.rowIndex, messages);
        batchFailed += 1;
      }
    });

    for (const [rowIndex, messages] of errorBuckets) {
      const prior = results[rowIndex].preferenceErrors;
      const joined = messages.join('; ');
      results[rowIndex].preferenceErrors = prior ? `${prior}; ${joined}` : joined;
    }

    processedPreferences += batch.length;
    if (onProgress) {
      await onProgress({
        phase: 'preferences',
        batch: batchIndex + 1,
        batches: preferenceBatches.length,
        batchSucceeded,
        batchFailed,
        processed: processedPreferences,
        total: preferenceWork.length,
      });
    }
  }

  const summary = {
    votesCreated: 0,
    votesFailed: 0,
    preferencesCreated: 0,
    preferencesFailed: 0,
  };
  for (const result of results) {
    if (result.status === 'created') summary.votesCreated += 1;
    else summary.votesFailed += 1;
    summary.preferencesCreated += result.preferencesCreated;
    summary.preferencesFailed += result.preferencesFailed;
  }

  return { results, summary };
}

function csvEscape(value) {
  const text = String(value ?? '');
  if (/[",\r\n]/.test(text)) return `"${text.replaceAll('"', '""')}"`;
  return text;
}

export function buildResultsCsv(results) {
  const header = [
    'Row',
    'Ballot',
    'Status',
    'Vote Id',
    'Vote Error',
    'Preferences Created',
    'Preferences Failed',
    'Preference Errors',
  ];
  const lines = [header.join(',')];
  for (const result of results) {
    lines.push([
      result.rowNumber,
      result.ballot ?? '',
      result.status ?? '',
      result.voteId ?? '',
      result.voteError ?? '',
      result.preferencesCreated ?? 0,
      result.preferencesFailed ?? 0,
      result.preferenceErrors ?? '',
    ].map(csvEscape).join(','));
  }
  return `\uFEFF${lines.join('\r\n')}\r\n`;
}
