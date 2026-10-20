import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { publicDirectory } from '../src/app.js';
import {
  browserCommand,
  isPackagedRuntime,
  missingCookieSecretMessage,
  missingEnvMessage,
  openBrowser,
  resolveEnvFile,
  locateSnapshotIndex,
  shouldHoldConsole,
  shouldOpenBrowser,
  snapshotIndexCandidates,
} from '../src/startup.js';

test('npm start reads .env from the working directory and the exe reads the folder it lives in', () => {
  assert.equal(
    resolveEnvFile({ packaged: false, execPath: '/usr/bin/node', cwd: '/work/voteloader' }),
    path.join('/work/voteloader', '.env'),
  );
  assert.equal(
    resolveEnvFile({
      packaged: true,
      execPath: path.join('/Apps', 'VoteLoader.exe'),
      cwd: '/somewhere/else',
    }),
    path.join('/Apps', '.env'),
  );
});

test('startup messages name the missing .env or COOKIE_SECRET and do not include secret values', () => {
  const envPath = path.join('/Apps', '.env');
  assert.match(missingEnvMessage(envPath, true), /VoteLoader\.exe/);
  assert.ok(missingEnvMessage(envPath, true).includes(envPath));
  assert.match(missingEnvMessage(envPath, false), /project folder/);
  assert.match(missingCookieSecretMessage(envPath), /COOKIE_SECRET is missing/);
  assert.doesNotMatch(missingCookieSecretMessage(envPath), /SECRET_VALUE/);
});

test('the browser stays closed when VOTELOADER_NO_BROWSER=1', () => {
  assert.equal(shouldOpenBrowser({ VOTELOADER_NO_BROWSER: '1' }), false);
  assert.equal(shouldOpenBrowser({}), true);
});

test('a Windows snapshot path is also tried as /snapshot and V:\\snapshot', () => {
  const winPath = 'C:\\snapshot\\VoteLoader-main\\public\\index.html';
  const posixPath = '/snapshot/VoteLoader-main/public/index.html';
  assert.ok(snapshotIndexCandidates(winPath).includes(posixPath));
  assert.ok(snapshotIndexCandidates(winPath).includes(`V:${posixPath}`));
  assert.ok(snapshotIndexCandidates(winPath).includes('V:\\snapshot\\VoteLoader-main\\public\\index.html'));
  const tried = [];
  const found = locateSnapshotIndex(winPath, (candidate) => {
    tried.push(candidate);
    return candidate === posixPath;
  });
  assert.equal(found, posixPath);
  assert.equal(tried[0], winPath);
});

test('the console stays open only when someone can press Enter', () => {
  assert.equal(shouldHoldConsole({ isTTY: true }), true);
  assert.equal(shouldHoldConsole({ isTTY: false }), false);
  assert.equal(shouldHoldConsole(undefined), false);
});

test('Windows opens the default browser through cmd start', () => {
  const calls = [];
  openBrowser('http://localhost:3000', {
    platform: 'win32',
    spawnImpl: (file, args) => {
      calls.push({ file, args });
      return { on() {}, unref() {} };
    },
  });
  assert.deepEqual(calls, [{
    file: 'cmd',
    args: ['/c', 'start', '', 'http://localhost:3000'],
  }]);
  assert.deepEqual(browserCommand('darwin', 'http://localhost:3000'), {
    file: 'open',
    args: ['http://localhost:3000'],
  });
});

test('this Node process is not treated as the packaged exe', () => {
  assert.equal(isPackagedRuntime(), false);
});

test('the page directory shipped with the source tree contains index.html', () => {
  assert.equal(fs.existsSync(path.join(publicDirectory(), 'index.html')), true);
});
