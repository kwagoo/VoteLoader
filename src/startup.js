import { createRequire } from 'node:module';
import path from 'node:path';
import { spawn } from 'node:child_process';

const require = createRequire(import.meta.url);

export function isPackagedRuntime(proc = process) {
  if (proc.pkg) return true;
  try {
    const { isSea } = require('node:sea');
    return typeof isSea === 'function' && isSea();
  } catch {
    return false;
  }
}

export function resolveEnvFile({ packaged, execPath, cwd }) {
  const directory = packaged ? path.dirname(execPath) : cwd;
  return path.join(directory, '.env');
}

export function missingEnvMessage(envPath, packaged) {
  const place = packaged ? 'the same folder as VoteLoader.exe' : 'the project folder';
  return `No .env file found at ${envPath}.\nCopy .env.example into ${place}, fill in the Salesforce keys and COOKIE_SECRET, then start VoteLoader again.`;
}

export function missingCookieSecretMessage(envPath) {
  return `COOKIE_SECRET is missing from ${envPath}.\nAdd a long random string, save the file, then start VoteLoader again.`;
}

export function shouldHoldConsole(stdin = process.stdin) {
  return Boolean(stdin?.isTTY);
}

export function shouldOpenBrowser(env = process.env) {
  return env.VOTELOADER_NO_BROWSER !== '1';
}

// pkg's Windows SEA filesystem often fails fs.existsSync on C:\snapshot\...
// even when the same file is visible as /snapshot/... or V:\snapshot\...
export function snapshotIndexCandidates(indexPath) {
  const candidates = [indexPath];
  const posix = String(indexPath).replace(/\\/g, '/').replace(/^[A-Za-z]:/, '');
  if (posix.startsWith('/snapshot/')) {
    candidates.push(posix);
    candidates.push(`V:${posix}`);
    candidates.push(`V:${posix.replace(/\//g, '\\')}`);
  }
  return [...new Set(candidates)];
}

export function locateSnapshotIndex(indexPath, existsSync) {
  for (const candidate of snapshotIndexCandidates(indexPath)) {
    if (existsSync(candidate)) return candidate;
  }
  return null;
}

export function browserCommand(platform, url) {
  if (platform === 'win32') {
    return { file: 'cmd', args: ['/c', 'start', '', url] };
  }
  if (platform === 'darwin') {
    return { file: 'open', args: [url] };
  }
  return { file: 'xdg-open', args: [url] };
}

export function openBrowser(url, { platform = process.platform, spawnImpl = spawn } = {}) {
  const command = browserCommand(platform, url);
  try {
    const child = spawnImpl(command.file, command.args, {
      detached: true,
      stdio: 'ignore',
      windowsHide: true,
    });
    child.on?.('error', () => {});
    child.unref?.();
  } catch {
    // The listening URL is already printed if the browser cannot be opened.
  }
  return command;
}
