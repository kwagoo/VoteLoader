import fs from 'node:fs';
import path from 'node:path';
import readline from 'node:readline';
import dotenv from 'dotenv';
import { createApp, publicDirectory, readConfig } from './app.js';
import {
  isPackagedRuntime,
  missingCookieSecretMessage,
  missingEnvMessage,
  openBrowser,
  resolveEnvFile,
  shouldHoldConsole,
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

  const pages = publicDirectory();
  if (!fs.existsSync(path.join(pages, 'index.html'))) {
    await fail(`VoteLoader could not find its pages at ${pages}.`);
    return;
  }

  const app = createApp(config);
  const port = Number.isInteger(config.port) && config.port > 0 ? config.port : 3000;
  const server = app.listen(port, () => {
    const url = `http://localhost:${port}`;
    console.log(`VoteLoader listening on ${url}`);
    openBrowser(url);
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
