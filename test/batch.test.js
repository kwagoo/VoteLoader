import assert from 'node:assert/strict';
import test from 'node:test';
import { BATCH_SIZE, buildResultsCsv, toCollectionBody, uploadBallots } from '../src/batch.js';
import { insertSObjectCollection } from '../src/salesforce.js';

const ELECTION = 'a0E000000000001';
const ALICE = 'a01000000000001';
const BOB = 'a01000000000002';

function row(n, preferences = [
  { candidateId: ALICE, value: 1 },
  { candidateId: BOB, value: 2 },
]) {
  return {
    rowNumber: n + 1,
    ballot: String(n),
    firstPreferenceCandidateId: preferences[0].candidateId,
    preferences,
  };
}

test('collection requests send 200 records with allOrNone false', () => {
  assert.equal(BATCH_SIZE, 200);
  const records = [{ Election__c: ELECTION, Exhausted__c: false, PreviousCandidate__c: null }];
  const body = toCollectionBody('Vote__c', records);
  assert.equal(body.allOrNone, false);
  assert.equal(body.records.length, 1);
  assert.deepEqual(body.records[0].attributes, { type: 'Vote__c' });
  assert.equal(body.records[0].Election__c, ELECTION);
  assert.equal(body.records[0].PreviousCandidate__c, null);
  assert.equal(body.records[0].Exhausted__c, false);
});

test('insertSObjectCollection posts the collection body and returns per-record results', async () => {
  const calls = [];
  const fetchImpl = async (url, options) => {
    calls.push({ url, options });
    return {
      ok: true,
      status: 200,
      json: async () => [{ id: 'a0V000000000001', success: true, errors: [] }],
      text: async () => '',
    };
  };

  const results = await insertSObjectCollection({
    fetchImpl,
    instanceUrl: 'https://example.my.salesforce.com',
    accessToken: 'token',
    apiVersion: '59.0',
    type: 'Vote__c',
    records: [{ Election__c: ELECTION }],
  });

  assert.equal(results[0].id, 'a0V000000000001');
  assert.equal(calls.length, 1);
  assert.equal(
    calls[0].url,
    'https://example.my.salesforce.com/services/data/v59.0/composite/sobjects',
  );
  assert.equal(calls[0].options.method, 'POST');
  assert.equal(calls[0].options.headers.Authorization, 'Bearer token');
  const body = JSON.parse(calls[0].options.body);
  assert.equal(body.allOrNone, false);
  assert.equal(body.records[0].attributes.type, 'Vote__c');
});

test('a failed collection HTTP call fails that batch without throwing away the status', async () => {
  await assert.rejects(
    () => insertSObjectCollection({
      fetchImpl: async () => ({
        ok: false,
        status: 400,
        json: async () => ({}),
        text: async () => '[{"message":"bad request"}]',
      }),
      instanceUrl: 'https://example.my.salesforce.com',
      accessToken: 'token',
      apiVersion: '59.0',
      type: 'Vote__c',
      records: [{ Election__c: ELECTION }],
    }),
    /400/,
  );
});

test('votes are inserted 200 at a time and ids map back to the same rows', async () => {
  const rows = Array.from({ length: 201 }, (_, index) => row(index + 1));
  const calls = [];

  const out = await uploadBallots({
    rows,
    electionId: ELECTION,
    insertRecords: async ({ type, records }) => {
      calls.push({ type, records });
      return records.map((record, index) => ({
        success: true,
        id: `${type}-${calls.length}-${index}`,
        errors: [],
      }));
    },
  });

  const voteCalls = calls.filter((call) => call.type === 'Vote__c');
  assert.deepEqual(voteCalls.map((call) => call.records.length), [200, 1]);
  assert.equal(voteCalls[0].records[0].Election__c, ELECTION);
  assert.equal(voteCalls[0].records[0].VoteType__c, 'Formal');
  assert.equal(voteCalls[0].records[0].CurrentCandidate__c, ALICE);
  assert.equal(voteCalls[0].records[0].FirstPreferenceCandidate__c, ALICE);
  assert.equal(voteCalls[0].records[0].CurrentTransferRound__c, 1);
  assert.equal(voteCalls[0].records[0].PreviousCandidate__c, null);
  assert.equal(voteCalls[0].records[0].Exhausted__c, false);

  assert.equal(out.results[0].voteId, 'Vote__c-1-0');
  assert.equal(out.results[200].voteId, 'Vote__c-2-0');
  assert.equal(out.results[0].status, 'created');
  assert.equal(out.summary.votesCreated, 201);
  assert.equal(out.summary.votesFailed, 0);
});

test('one vote failure does not stop later votes, and its preferences are not inserted', async () => {
  const rows = Array.from({ length: 201 }, (_, index) => row(index + 1));
  const calls = [];

  const out = await uploadBallots({
    rows,
    electionId: ELECTION,
    insertRecords: async ({ type, records }) => {
      const callNumber = calls.filter((call) => call.type === type).length + 1;
      calls.push({ type, records });
      if (type === 'Vote__c' && callNumber === 1) {
        return records.map((_, index) => (
          index === 0
            ? { success: false, errors: [{ message: 'validation failed', statusCode: 'FIELD_CUSTOM_VALIDATION_EXCEPTION' }] }
            : { success: true, id: `v-${index}`, errors: [] }
        ));
      }
      return records.map((_, index) => ({ success: true, id: `${type}-${callNumber}-${index}`, errors: [] }));
    },
  });

  assert.equal(calls.filter((call) => call.type === 'Vote__c').length, 2);
  assert.equal(out.results[0].voteId, null);
  assert.match(out.results[0].voteError, /validation failed/);
  assert.equal(out.results[0].preferencesCreated, 0);
  assert.equal(out.results[0].preferencesFailed, 2);
  assert.equal(out.results[1].voteId, 'v-1');
  assert.equal(out.results[200].status, 'created');

  const preferenceRecords = calls
    .filter((call) => call.type === 'VotePreference__c')
    .flatMap((call) => call.records);
  assert.equal(preferenceRecords.length, 400);
  assert.equal(preferenceRecords.some((record) => record.Vote__c === 'v-1'), true);
  assert.equal(preferenceRecords.some((record) => !record.Vote__c), false);
  assert.equal(out.summary.votesFailed, 1);
  assert.equal(out.summary.preferencesCreated, 400);
});

test('preference inserts stay in batches of 200 and a single failure is counted on its row', async () => {
  const rows = [row(1), row(2, [{ candidateId: ALICE, value: 1 }])];
  const extra = Array.from({ length: 99 }, (_, index) => row(index + 3));
  const allRows = [...rows, ...extra];
  assert.equal(allRows.reduce((sum, item) => sum + item.preferences.length, 0), 201);

  const calls = [];
  const out = await uploadBallots({
    rows: allRows,
    electionId: ELECTION,
    insertRecords: async ({ type, records }) => {
      calls.push({ type, count: records.length, records });
      if (type === 'VotePreference__c' && calls.filter((call) => call.type === type).length === 1) {
        return records.map((_, index) => (
          index === 1
            ? { success: false, errors: [{ message: 'bad preference' }] }
            : { success: true, id: `p-${index}`, errors: [] }
        ));
      }
      return records.map((_, index) => ({ success: true, id: `${type}-${index}`, errors: [] }));
    },
  });

  const preferenceCalls = calls.filter((call) => call.type === 'VotePreference__c');
  assert.deepEqual(preferenceCalls.map((call) => call.count), [200, 1]);
  assert.equal(out.results[0].preferencesCreated, 1);
  assert.equal(out.results[0].preferencesFailed, 1);
  assert.match(out.results[0].preferenceErrors, /bad preference/);
  assert.equal(out.results[1].preferencesCreated, 1);
  assert.equal(out.results[1].preferencesFailed, 0);
  assert.equal(out.summary.preferencesFailed, 1);
});

test('a thrown batch error fails only that batch and later batches still run', async () => {
  const rows = Array.from({ length: 201 }, (_, index) => row(index + 1, [
    { candidateId: ALICE, value: 1 },
  ]));
  let voteCalls = 0;

  const out = await uploadBallots({
    rows,
    electionId: ELECTION,
    insertRecords: async ({ type, records }) => {
      if (type === 'Vote__c') {
        voteCalls += 1;
        if (voteCalls === 1) throw new Error('network down');
      }
      return records.map((_, index) => ({ success: true, id: `${type}-${voteCalls}-${index}`, errors: [] }));
    },
  });

  assert.equal(voteCalls, 2);
  assert.equal(out.results[0].status, 'failed');
  assert.match(out.results[0].voteError, /network down/);
  assert.equal(out.results[200].status, 'created');
  assert.equal(out.summary.votesCreated, 1);
  assert.equal(out.summary.votesFailed, 200);
  assert.equal(out.summary.preferencesCreated, 1);
});

test('results CSV lists each row, the vote id or error, and preference counts', () => {
  const csv = buildResultsCsv([
    {
      rowNumber: 2,
      ballot: '1, special',
      status: 'failed',
      voteId: null,
      voteError: 'He said "no"',
      preferencesCreated: 0,
      preferencesFailed: 2,
      preferenceErrors: '',
    },
  ]);
  assert.match(csv, /Row,Ballot,Status,Vote Id,Vote Error,Preferences Created,Preferences Failed,Preference Errors/);
  assert.match(csv, /"1, special"/);
  assert.match(csv, /"He said ""no"""/);
  assert.match(csv, /,0,2,/);
});

test('progress reports each vote batch and each preference batch', async () => {
  const events = [];
  await uploadBallots({
    rows: Array.from({ length: 2 }, (_, index) => row(index + 1)),
    electionId: ELECTION,
    insertRecords: async ({ type, records }) => records.map((_, index) => ({
      success: true,
      id: `${type}-${index}`,
      errors: [],
    })),
    onProgress: (event) => events.push(event),
  });

  assert.deepEqual(events.map((event) => event.phase), ['votes', 'preferences']);
  assert.equal(events[0].batch, 1);
  assert.equal(events[0].batches, 1);
  assert.equal(events[0].batchSucceeded, 2);
  assert.equal(events[0].batchFailed, 0);
  assert.equal(events[1].processed, 4);
  assert.equal(events[1].total, 4);
});
