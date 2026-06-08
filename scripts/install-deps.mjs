import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const tempDir = resolve(root, '.tmp');
const npmCache = resolve(root, '.npm-cache');
const windowsNpmCli = 'C:\\Program Files\\nodejs\\node_modules\\npm\\bin\\npm-cli.js';

mkdirSync(tempDir, { recursive: true });
mkdirSync(npmCache, { recursive: true });

const npmCommand = process.platform === 'win32' && existsSync(windowsNpmCli)
  ? process.execPath
  : 'npm';
const npmArgs = process.platform === 'win32' && existsSync(windowsNpmCli)
  ? [windowsNpmCli]
  : [];

const args = [
  ...npmArgs,
  'install',
  '--cache',
  npmCache,
  '--no-audit',
  '--no-fund',
  '--fetch-timeout',
  '15000',
  '--fetch-retries',
  '0'
];

process.stdout.write(`Installing MIXOMESH dependencies with ${npmCommand}\n`);
process.stdout.write(`npm cache: ${npmCache}\n`);
process.stdout.write(`temp dir: ${tempDir}\n\n`);

const result = spawnSync(npmCommand, args, {
  cwd: root,
  env: {
    ...process.env,
    TEMP: tempDir,
    TMP: tempDir,
    npm_config_cache: npmCache,
    npm_config_audit: 'false',
    npm_config_fund: 'false',
    npm_config_update_notifier: 'false'
  },
  stdio: 'inherit',
  timeout: 120000
});

if (result.error) {
  process.stderr.write(`\nDependency install could not start: ${result.error.message}\n`);
  process.exit(1);
}

if (result.status !== 0) {
  process.stderr.write('\nDependency install failed.\n');
  process.stderr.write('If the error is EACCES while fetching registry.npmjs.org, run this script from a normal terminal outside the restricted agent sandbox.\n');
  if (result.signal) {
    process.stderr.write(`Installer was stopped by signal ${result.signal}.\n`);
  }
  process.exit(result.status ?? 1);
}

process.stdout.write('\nDependencies installed. Next: npm run typecheck && npm run build\n');
process.stdout.write('On Windows with a broken npm shim, use C:\\Program Files\\nodejs\\npm.cmd for npm run commands.\n');
