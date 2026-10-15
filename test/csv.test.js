import assert from 'node:assert/strict';
import test from 'node:test';
import {
  analyzeCsv,
  isSalesforceId,
  mapPreferences,
  mapVote,
  parseCsv,
  selectRowsForUpload,
} from '../src/csv.js';

const ELECTION = 'a0E000000000001';
const ALICE = 'a01000000000001';
const BOB = 'a01000000000002';
const CAROL = 'a01000000000003AAA';

function csv(body) {
  return `Ballot papers,${ALICE},${BOB},${CAROL}\n${body}`;
}

test('isSalesforceId accepts 15- and 18-character ids only', () => {
  assert.equal(isSalesforceId(ALICE), true);
  assert.equal(isSalesforceId(CAROL), true);
  assert.equal(isSalesforceId('Alice'), false);
  assert.equal(isSalesforceId('a0100000000000'), false);
  assert.equal(isSalesforceId('a010000000000011'), false);
  assert.equal(isSalesforceId('a01000000000001!'), false);
  assert.equal(isSalesforceId(''), false);
  assert.equal(isSalesforceId('  a01000000000001  '), true);
});

test('parseCsv strips a BOM, handles quotes and CRLF, and trims cells', () => {
  const text = `\uFEFFBallot papers,"${ALICE}",${BOB}\r\n"1, special",1,2\r\n3,"",4\r\n`;
  const parsed = parseCsv(text);
  assert.deepEqual(parsed.headers, ['Ballot papers', ALICE, BOB]);
  assert.deepEqual(parsed.rows, [
    ['1, special', '1', '2'],
    ['3', '', '4'],
  ]);
});

test('parseCsv ignores a trailing blank line and keeps a blank candidate cell', () => {
  const parsed = parseCsv(`Ballot,${ALICE}\n1,1\n\n`);
  assert.equal(parsed.rows.length, 1);
  assert.deepEqual(parsed.rows[0], ['1', '1']);
});

test('each data row maps to one Formal vote and one preference per filled cell', () => {
  const analysis = analyzeCsv(
    csv('7,2,1,\n8,1,,3\n'),
    ELECTION,
  );

  assert.equal(analysis.electionIssue, null);
  assert.deepEqual(analysis.headerIssues, []);
  assert.equal(analysis.rows.length, 2);

  const first = analysis.rows[0];
  assert.equal(first.rowNumber, 2);
  assert.equal(first.ballot, '7');
  assert.equal(first.flagged, false);
  assert.equal(first.firstPreferenceCandidateId, BOB);
  assert.deepEqual(
    first.preferences.map((pref) => [pref.candidateId, pref.value]),
    [
      [ALICE, 2],
      [BOB, 1],
    ],
  );

  const vote = mapVote(first, ELECTION);
  assert.deepEqual(vote, {
    Election__c: ELECTION,
    VoteType__c: 'Formal',
    CurrentCandidate__c: BOB,
    FirstPreferenceCandidate__c: BOB,
    CurrentTransferRound__c: 1,
    PreviousCandidate__c: null,
    Exhausted__c: false,
  });

  assert.deepEqual(mapPreferences(first, 'a0V000000000009'), [
    { Vote__c: 'a0V000000000009', CandidateId__c: ALICE, NormalisedEntry__c: 2 },
    { Vote__c: 'a0V000000000009', CandidateId__c: BOB, NormalisedEntry__c: 1 },
  ]);

  const second = analysis.rows[1];
  assert.equal(second.firstPreferenceCandidateId, ALICE);
  assert.deepEqual(
    second.preferences.map((pref) => pref.candidateId),
    [ALICE, CAROL],
  );
  assert.equal(second.preferences[1].value, 3);
});

test('blank cells do not become preference records', () => {
  const analysis = analyzeCsv(csv('6,1,,2\n'), ELECTION);
  assert.equal(analysis.rows[0].preferences.length, 2);
  assert.deepEqual(
    analysis.rows[0].preferences.map((pref) => pref.candidateId),
    [ALICE, CAROL],
  );
});

test('column A is the ballot number and is never a preference', () => {
  const analysis = analyzeCsv(`1,${ALICE}\n${BOB},1\n`, ELECTION);
  assert.equal(analysis.rows[0].ballot, BOB);
  assert.equal(analysis.rows[0].preferences.length, 1);
  assert.equal(analysis.rows[0].preferences[0].candidateId, ALICE);
  assert.equal(analysis.headerIssues.length, 0);
});

test('flags rows with no 1, more than one 1, and non-numeric cells', () => {
  const analysis = analyzeCsv(
    [
      `Ballot papers,${ALICE},${BOB},${CAROL}`,
      '1,2,3,4',
      '13,1,2,1',
      '6,x,1,',
      '20,1,1.5,2',
      '9,01,,',
    ].join('\n'),
    ELECTION,
  );

  assert.equal(analysis.rows[0].flagged, true);
  assert.match(analysis.rows[0].issues[0], /no cell contains 1/i);

  assert.equal(analysis.rows[1].flagged, true);
  assert.match(analysis.rows[1].issues[0], /more than one/i);
  assert.match(analysis.rows[1].issues[0], /B/);
  assert.match(analysis.rows[1].issues[0], /D/);
  assert.equal(analysis.rows[1].firstPreferenceCandidateId, null);

  assert.equal(analysis.rows[2].flagged, true);
  assert.match(analysis.rows[2].issues.join(' '), /Column B/);
  assert.match(analysis.rows[2].issues.join(' '), /"x"/);

  assert.equal(analysis.rows[3].flagged, true);
  assert.match(analysis.rows[3].issues.join(' '), /"1\.5"/);

  assert.equal(analysis.rows[4].flagged, false);
  assert.equal(analysis.rows[4].firstPreferenceCandidateId, ALICE);
  assert.equal(analysis.rows[4].preferences[0].value, 1);

  assert.equal(analysis.summary.valid, 1);
  assert.equal(analysis.summary.flagged, 4);
});

test('flags candidate headers that are not 15- or 18-character Salesforce ids', () => {
  const analysis = analyzeCsv(
    `Ballot papers,Alice,${ALICE},${'a010000000000011'},\n1,1,2,3,4\n`,
    `  ${ELECTION}  `,
  );

  assert.equal(analysis.electionIssue, null);
  const messages = analysis.headerIssues.map((issue) => issue.message).join('\n');
  assert.match(messages, /Column B/);
  assert.match(messages, /Alice/);
  assert.match(messages, /Column D/);
  assert.match(messages, /Column E/);
  assert.match(messages, /blank/i);
  assert.equal(analysis.headerIssues.some((issue) => issue.header === ALICE), false);
});

test('flags a duplicate candidate id and a bad election id', () => {
  const analysis = analyzeCsv(
    `Ballot papers,${ALICE},${ALICE}\n1,1,2\n`,
    'not-an-id',
  );
  assert.match(analysis.electionIssue, /Election ID/);
  assert.match(analysis.headerIssues.map((issue) => issue.message).join(' '), /used in columns B and C/);
});

test('selectRowsForUpload blocks until flagged rows are skipped and headers are valid', () => {
  const analysis = analyzeCsv(csv('1,2,3,4\n2,1,2,\n'), ELECTION);

  const blocked = selectRowsForUpload(analysis, { skipFlagged: false });
  assert.equal(blocked.ok, false);
  assert.equal(blocked.rows.length, 0);

  const skipped = selectRowsForUpload(analysis, { skipFlagged: true });
  assert.equal(skipped.ok, true);
  assert.equal(skipped.rows.length, 1);
  assert.equal(skipped.rows[0].ballot, '2');

  const badHeaders = analyzeCsv(`Ballot papers,Alice\n1,1\n`, ELECTION);
  const headersBlocked = selectRowsForUpload(badHeaders, { skipFlagged: true });
  assert.equal(headersBlocked.ok, false);
  assert.match(headersBlocked.error, /header/i);
});

test('a fully blank data line is ignored', () => {
  const analysis = analyzeCsv(csv('1,1,2,\n,,,\n'), ELECTION);
  assert.equal(analysis.rows.length, 1);
  assert.equal(analysis.summary.dataRows, 1);
});
