import fs from 'node:fs';
import path from 'node:path';
import readline from 'node:readline';
import dotenv from 'dotenv';
import { createApp, publicDirectory, readConfig } from './app.js';
import { pages as embeddedPages } from './embedded-pages.js';
import {
  isPackagedRuntime,
  missingCookieSecretMessage,
  missingEnvMessage,
  locateSnapshotIndex,
  openBrowser,
  resolveEnvFile,
  shouldHoldConsole,
  shouldOpenBrowser,
} from './startup.js';

function holdConsole() {
  if (!shouldHoldConsole()) return Promise.resolve();
  console.error('');
  console.error('Press Enter to close this window.');
  return new Promise((resolve) => {
    let settled = false;
    const rl = readline.createInterface({ input: process.stdin, output: process.stderr });
    const finish = () => {
      if (settled) return;
      settled = true;
      rl.close();
      resolve();
    };
    rl.once('line', finish);
    process.stdin.once('end', finish);
  });
}

async function fail(message) {
  console.error(message);
  await holdConsole();
  process.exit(1);
}

const PAGE_NAMES = ['index.html', 'styles.css', 'app.js'];

function readPagesAt(indexPath) {
  const slash = indexPath.includes('\\') ? '\\' : '/';
  const directory = indexPath.slice(0, indexPath.lastIndexOf(slash));
  const pages = {};
  for (const name of PAGE_NAMES) {
    const file = `${directory}${slash}${name}`;
    if (!fs.existsSync(file)) return null;
    pages[name] = fs.readFileSync(file, 'utf8');
  }
  return pages;
}

function loadEmbeddedPages() {
  if (!embeddedPages?.['index.html'] || !embeddedPages['styles.css'] || !embeddedPages['app.js']) {
    return null;
  }
  return embeddedPages;
}

async function loadPages() {
  const indexPath = path.join(publicDirectory(), 'index.html');
  const located = locateSnapshotIndex(indexPath, (candidate) => {
    try {
      return fs.existsSync(candidate);
    } catch {
      return false;
    }
  });
  if (located) {
    try {
      const pages = readPagesAt(located);
      if (pages) return pages;
    } catch {
      // The snapshot reported the file, but the read failed. Use the embedded copy.
    }
  }

  const embedded = loadEmbeddedPages();
  if (embedded) return embedded;

  await fail(`VoteLoader could not find its pages at ${path.dirname(indexPath)}.`);
  return null;
}

async function main() {
  const packaged = isPackagedRuntime();
  const envPath = resolveEnvFile({
    packaged,
    execPath: process.execPath,
    cwd: process.cwd(),
  });

  if (!fs.existsSync(envPath)) {
    await fail(missingEnvMessage(envPath, packaged));
    return;
  }

  dotenv.config({ path: envPath });
  const config = readConfig();
  if (!config.cookieSecret) {
    await fail(missingCookieSecretMessage(envPath));
    return;
  }

  const pages = await loadPages();
  if (!pages) return;

  const app = createApp({ ...config, pages });
  const port = Number.isInteger(config.port) && config.port > 0 ? config.port : 3000;
  const server = app.listen(port, () => {
    const url = `http://localhost:${port}`;
    console.log(`VoteLoader listening on ${url}`);
    if (shouldOpenBrowser()) openBrowser(url);
  });
  server.on('error', (error) => {
    const message = error.code === 'EADDRINUSE'
      ? `Port ${port} is already in use. Close the other program using it, or set PORT in ${envPath}.`
      : `VoteLoader could not start: ${error.message}`;
    fail(message);
  });
}

main().catch(async (error) => {
  console.error(error?.message || error);
  await holdConsole();
  process.exit(1);
});
