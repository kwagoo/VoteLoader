const SALESFORCE_ID = /^[a-zA-Z0-9]{15}(?:[a-zA-Z0-9]{3})?$/;
const WHOLE_NUMBER = /^\d+$/;

export function isSalesforceId(value) {
  return SALESFORCE_ID.test(String(value ?? '').trim());
}

export function columnLetter(index) {
  let number = index + 1;
  let letters = '';
  while (number > 0) {
    const remainder = (number - 1) % 26;
    letters = String.fromCharCode(65 + remainder) + letters;
    number = Math.floor((number - 1) / 26);
  }
  return letters;
}

export function parseCsv(text) {
  let input = String(text ?? '');
  if (input.charCodeAt(0) === 0xfeff) input = input.slice(1);

  const table = [];
  let row = [];
  let field = '';
  let inQuotes = false;

  for (let index = 0; index < input.length; index += 1) {
    const char = input[index];
    if (inQuotes) {
      if (char === '"') {
        if (input[index + 1] === '"') {
          field += '"';
          index += 1;
        } else {
          inQuotes = false;
        }
      } else {
        field += char;
      }
      continue;
    }

    if (char === '"') {
      inQuotes = true;
    } else if (char === ',') {
      row.push(field);
      field = '';
    } else if (char === '\n' || char === '\r') {
      if (char === '\r' && input[index + 1] === '\n') index += 1;
      row.push(field);
      table.push(row);
      row = [];
      field = '';
    } else {
      field += char;
    }
  }

  if (field.length > 0 || row.length > 0) {
    row.push(field);
    table.push(row);
  }

  while (table.length > 0 && table[table.length - 1].every((cell) => cell.trim() === '')) {
    table.pop();
  }

  const headers = (table.shift() ?? []).map((cell) => cell.trim());
  const rows = table.map((cells) => cells.map((cell) => cell.trim()));
  return { headers, rows };
}

function formatColumnList(letters) {
  if (letters.length <= 1) return letters[0] ?? '';
  if (letters.length === 2) return `${letters[0]} and ${letters[1]}`;
  return `${letters.slice(0, -1).join(', ')}, and ${letters[letters.length - 1]}`;
}

export function analyzeCsv(csvText, electionId) {
  const parsed = parseCsv(csvText);
  const trimmedElectionId = String(electionId ?? '').trim();
  let electionIssue = null;
  if (!trimmedElectionId) {
    electionIssue = 'Enter an Election record ID.';
  } else if (!isSalesforceId(trimmedElectionId)) {
    electionIssue = 'Election ID must be a 15- or 18-character Salesforce ID.';
  }

  const headerIssues = [];
  const candidateColumns = [];
  const seenIds = new Map();

  for (let index = 1; index < parsed.headers.length; index += 1) {
    const header = parsed.headers[index] ?? '';
    const letter = columnLetter(index);
    if (!header) {
      headerIssues.push({
        columnIndex: index,
        columnLetter: letter,
        header,
        message: `Column ${letter} header is blank.`,
      });
      continue;
    }
    if (!isSalesforceId(header)) {
      headerIssues.push({
        columnIndex: index,
        columnLetter: letter,
        header,
        message: `Column ${letter} header "${header}" is not a 15- or 18-character Salesforce ID.`,
      });
      continue;
    }
    if (seenIds.has(header)) {
      headerIssues.push({
        columnIndex: index,
        columnLetter: letter,
        header,
        message: `Candidate ID ${header} is used in columns ${seenIds.get(header)} and ${letter}.`,
      });
      continue;
    }
    seenIds.set(header, letter);
    candidateColumns.push({ index, header, letter });
  }

  const rows = [];
  parsed.rows.forEach((cells, index) => {
    const width = Math.max(parsed.headers.length, cells.length);
    const padded = cells.slice();
    while (padded.length < width) padded.push('');
    if (padded.every((cell) => cell === '')) return;

    const issues = [];
    for (let cellIndex = parsed.headers.length; cellIndex < padded.length; cellIndex += 1) {
      if (padded[cellIndex]) {
        issues.push(`Column ${columnLetter(cellIndex)} has a value but no header.`);
      }
    }

    const preferences = [];
    for (const column of candidateColumns) {
      const raw = padded[column.index] ?? '';
      if (!raw) {
        preferences.push({
          candidateId: column.header,
          columnIndex: column.index,
          columnLetter: column.letter,
          value: null,
        });
        continue;
      }
      if (!WHOLE_NUMBER.test(raw)) {
        issues.push(`Column ${column.letter} value "${raw}" is not a whole number.`);
        continue;
      }
      const value = Number(raw);
      if (value > 999) {
        issues.push(`Column ${column.letter} value "${raw}" is outside the 0–999 range for NormalisedEntry__c.`);
        continue;
      }
      preferences.push({
        candidateId: column.header,
        columnIndex: column.index,
        columnLetter: column.letter,
        value,
      });
    }

    const firstPreferences = preferences.filter((preference) => preference.value === 1);
    let firstPreferenceCandidateId = null;
    if (firstPreferences.length === 0) {
      issues.push('No first preference: no cell contains 1.');
    } else if (firstPreferences.length > 1) {
      const columns = formatColumnList(firstPreferences.map((preference) => preference.columnLetter));
      issues.push(`More than one first preference: columns ${columns} contain 1.`);
      firstPreferenceCandidateId = null;
    } else {
      firstPreferenceCandidateId = firstPreferences[0].candidateId;
    }

    rows.push({
      rowNumber: index + 2,
      ballot: padded[0] ?? '',
      issues,
      flagged: issues.length > 0,
      firstPreferenceCandidateId,
      preferences,
    });
  });

  return {
    electionId: trimmedElectionId,
    electionIssue,
    headerIssues,
    rows,
    summary: {
      dataRows: rows.length,
      valid: rows.filter((row) => !row.flagged).length,
      flagged: rows.filter((row) => row.flagged).length,
      preferences: rows.reduce((count, row) => count + row.preferences.length, 0),
    },
  };
}

export function mapVote(row, electionId) {
  return {
    Election__c: electionId,
    VoteType__c: 'Formal',
    CurrentCandidate__c: row.firstPreferenceCandidateId,
    FirstPreferenceCandidate__c: row.firstPreferenceCandidateId,
    CurrentTransferRound__c: 1,
    PreviousCandidate__c: null,
    Exhausted__c: false,
  };
}

export function mapPreferences(row, voteId) {
  return row.preferences.map((preference) => ({
    Vote__c: voteId,
    CandidateId__c: preference.candidateId,
    NormalisedEntry__c: preference.value,
  }));
}

export function selectRowsForUpload(analysis, { skipFlagged }) {
  if (analysis.electionIssue) {
    return { ok: false, error: analysis.electionIssue, rows: [] };
  }
  if (analysis.headerIssues.length > 0) {
    return { ok: false, error: 'Fix the candidate ID headers before uploading.', rows: [] };
  }
  const flagged = analysis.rows.filter((row) => row.flagged);
  if (flagged.length > 0 && !skipFlagged) {
    return { ok: false, error: 'Skip flagged rows or fix them before uploading.', rows: [] };
  }
  const rows = skipFlagged ? analysis.rows.filter((row) => !row.flagged) : analysis.rows.slice();
  if (rows.length === 0) {
    return { ok: false, error: 'No rows to upload.', rows: [] };
  }
  return { ok: true, rows };
}
