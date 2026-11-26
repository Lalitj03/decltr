// Runs every test/*.test.js file. Node 20 does not expand glob patterns given to `node --test`
// and Node 22 treats a folder name as a pattern, so the files are listed here instead.
import { spawnSync } from 'node:child_process';
import { readdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const dir = join(dirname(fileURLToPath(import.meta.url)), '..', 'test');
const files = readdirSync(dir).filter((f) => f.endsWith('.test.js')).sort().map((f) => join(dir, f));
if (files.length === 0) {
  console.error('No test files found in test/.');
  process.exit(1);
}
const { status } = spawnSync(process.execPath, ['--test', ...process.argv.slice(2), ...files], { stdio: 'inherit' });
process.exit(status ?? 1);
