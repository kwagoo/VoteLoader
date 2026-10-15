# VoteLoader

VoteLoader is a local Node.js app (Node 20 or newer) for loading a ballot CSV into Salesforce. Each data row becomes one `Vote__c`. Each filled candidate cell becomes a `VotePreference__c` under that vote.

It runs on your machine, on port **3000**, and reuses the ReleasePath Connected App. The OAuth callback is the same URL ReleasePath already uses:

`http://localhost:3000/api/org/salesforce/callback`

VoteLoader and ReleasePath are not meant to run on the same machine at the same time, because they share that port and callback.

## Salesforce setup

### Reuse the ReleasePath Connected App

1. In Salesforce, open **Setup → App Manager** and open the ReleasePath Connected App.
2. Confirm the callback URL list already contains exactly:

   `http://localhost:3000/api/org/salesforce/callback`

   If it does, do not add another callback. VoteLoader listens on that path.
3. Copy the **Consumer Key** and **Consumer Secret**. They go in `.env` as `SALESFORCE_CLIENT_ID` and `SALESFORCE_CLIENT_SECRET`.
4. Confirm these OAuth settings (this matches a classic Connected App with the web server flow and PKCE):
   - OAuth is enabled.
   - The allowed scopes include **Manage user data via APIs (`api`)** and **Perform requests at any time (`refresh_token`, `offline_access`)**.
   - **Require Proof Key for Code Exchange (PKCE)** is enabled. VoteLoader always sends a PKCE challenge.
   - **Require Secret for Web Server Flow** is enabled. VoteLoader sends the consumer secret.
   - Your user is allowed to authorize the app. If **Permitted Users** is “Admin approved users are pre-authorized”, assign the Connected App to your profile or permission set.

### Create a Connected App only if you are not reusing ReleasePath

1. **Setup → App Manager → New Connected App**.
2. Enable OAuth Settings.
3. Callback URL: `http://localhost:3000/api/org/salesforce/callback`
4. Selected OAuth Scopes: `api` and `refresh_token`.
5. Enable **Require Proof Key for Code Exchange (PKCE)** and **Require Secret for Web Server Flow**.
6. Save, then copy the Consumer Key and Consumer Secret. Salesforce can take a few minutes before a new Connected App can be used.

### Record access

The Salesforce user who connects needs:

- **API Enabled**.
- Create on `Vote__c` and `VotePreference__c`.
- Read on `Election__c` and on the Candidate object used by the lookups.
- Field-level security that lets that user set:
  - `Vote__c`: `Election__c`, `VoteType__c`, `CurrentCandidate__c`, `FirstPreferenceCandidate__c`, `CurrentTransferRound__c`, `PreviousCandidate__c`, `Exhausted__c`
  - `VotePreference__c`: `Vote__c`, `CandidateId__c`, `NormalisedEntry__c`
- The `VoteType__c` picklist value **Formal**.

`CurrentCandidate__c` and `FirstPreferenceCandidate__c` are lookups, so the header values must be real Candidate record IDs. `CandidateId__c` is text, and the same ID is stored there.

Have an `Election__c` record ID ready to paste into the page. In the CSV header, replace candidate names with Candidate record IDs (15 or 18 characters). Column A stays the ballot number and is not loaded.

If a validation rule, required field, or lookup rejects a row, that row is reported in the results CSV. The other rows still insert.

## Configure the app

From the project folder in VS Code:

```bat
copy .env.example .env
npm install
```

Edit `.env`:

| Variable | Value |
| --- | --- |
| `SALESFORCE_CLIENT_ID` | Connected App consumer key |
| `SALESFORCE_CLIENT_SECRET` | Connected App consumer secret |
| `SALESFORCE_REDIRECT_URI` | `http://localhost:3000/api/org/salesforce/callback` |
| `SALESFORCE_LOGIN_URL` | Default login host. The connect screen can still switch this. |
| `COOKIE_SECRET` | A long random string. It signs the session cookie that holds the PKCE verifier, OAuth state, and Salesforce session. |
| `PORT` | `3000` |

Leave the redirect URI as the value above so it matches the Connected App character for character. Do not commit `.env`.

PowerShell can make a cookie secret:

```powershell
[Convert]::ToBase64String((1..48 | ForEach-Object { Get-Random -Maximum 256 }))
```

`SALESFORCE_LOGIN_URL` is the default only. On the connect screen you can choose:

- Production: `https://login.salesforce.com`
- Sandbox: `https://test.salesforce.com`
- A custom My Domain, such as `https://mydomain.my.salesforce.com` or a sandbox My Domain

## Run

```bat
npm start
```

Open [http://localhost:3000](http://localhost:3000). The Salesforce session stays in memory, and `COOKIE_SECRET` signs the cookie. Restarting VoteLoader logs you out.

Inserts use Salesforce REST API v59.0. Set `SALESFORCE_API_VERSION` (for example `62.0`) if the org needs a different version.

1. Connect to Salesforce. The page shows the org name, org ID, instance host, and user, plus **Log out**.
2. Paste the `Election__c` record ID and choose the CSV.
3. Choose **Preview**. Nothing is inserted yet. The preview flags:
   - candidate headers that are not 15- or 18-character Salesforce IDs
   - rows with no `1`, or with more than one `1`
   - cells that are not whole numbers from 0 through 999
4. To leave flagged rows out, check **Skip flagged rows**. Bad headers must be fixed; they cannot be skipped.
5. Choose **Upload**. Votes are inserted 200 at a time with the sObject Collections API and `allOrNone` false, then preferences are inserted the same way. One rejected record does not stop the rest.
6. Download the results CSV. It has one line per ballot row: the Vote ID or the error, and how many preferences were created or failed. Skipped rows are included.

Running the file again creates new votes. It does not update votes already loaded.

## CSV shape

```csv
Ballot papers,a01000000000001,a01000000000002,a01000000000003
1,1,2,3
2,2,,1
3,1,1,2
```

- Column A is the ballot number. It is stored only in the results file, not on the Salesforce record (`Vote__c.Name` is an auto number).
- Each other column header is a Candidate record ID.
- A blank cell creates no `VotePreference__c`.
- The column whose cell is `1` is `CurrentCandidate__c` and `FirstPreferenceCandidate__c`.
- Every vote is created with `VoteType__c` = `Formal`, `CurrentTransferRound__c` = `1`, `PreviousCandidate__c` = null, and `Exhausted__c` = false.
- Each preference gets `CandidateId__c` from the header and `NormalisedEntry__c` from the cell.

`examples/sample-ballots.csv` is a small file you can preview. The ballots numbered 3 and 4 are flagged on purpose.

## Tests

```bat
npm test
```

The tests cover CSV parsing, the vote and preference mapping, validation, and the 200-record batches.
