#!/usr/bin/env node
// Builds dist/decltr-<version>.zip for the Chrome Web Store.
//
// The store assigns its own extension ID, so the upload must not contain the "key" that pins the
// development ID. Everything else is copied as is. The build refuses to finish if the zip would contain
// something that should never ship: a private key, an API key, a source map or a dotfile.
//
//   npm run package
import { execFileSync } from 'node:child_process';
import { cpSync, mkdirSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { dirname, join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const source = join(root, 'extension');
const dist = join(root, 'dist');
const stage = join(dist, 'extension');

const manifest = JSON.parse(readFileSync(join(source, 'manifest.json'), 'utf8'));
const pkg = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'));
if (manifest.version !== pkg.version) {
  fail(`manifest.json is version ${manifest.version} but package.json is ${pkg.version}. Make them match first.`);
}

rmSync(stage, { recursive: true, force: true });
mkdirSync(stage, { recursive: true });
cpSync(source, stage, { recursive: true, filter: (path) => !/(^|\/)\.[^/]+$/.test(relative(source, path)) });

delete manifest.key;
writeFileSync(join(stage, 'manifest.json'), `${JSON.stringify(manifest, null, 2)}\n`);

const files = walk(stage);
const problems = [];
for (const file of files) {
  const name = relative(stage, file);
  if (/\.(pem|crx|map|zip)$/i.test(name)) problems.push(`${name}: this kind of file must not ship`);
  if (!/\.(js|html|css|json|png|svg|txt|md)$/i.test(name)) problems.push(`${name}: unexpected file type`);
  if (/\.png$/i.test(name)) continue;
  const text = readFileSync(file, 'utf8');
  // Long, real-looking keys only. The short prefixes used in help text ("AIza…", "AQ.…") are fine.
  if (/AIza[0-9A-Za-z_-]{30,}|AQ\.[0-9A-Za-z_-]{30,}|sk-[0-9A-Za-z_-]{20,}|-----BEGIN [A-Z ]*PRIVATE KEY-----/.test(text)) {
    problems.push(`${name}: looks like it contains a key`);
  }
  if (/\/Users\/[^/\s]+/.test(text)) problems.push(`${name}: contains a home-folder path`);
}
if (problems.length) fail(`Not packaged:\n  ${problems.join('\n  ')}`);

const zip = join(dist, `decltr-${manifest.version}.zip`);
rmSync(zip, { force: true });
execFileSync('zip', ['-q', '-r', '-X', zip, '.'], { cwd: stage, stdio: 'inherit' });

const kb = (statSync(zip).size / 1024).toFixed(0);
console.log(`Built ${relative(root, zip)} (${files.length} files, ${kb} KB), without the development "key".`);
console.log('Upload it at https://chrome.google.com/webstore/devconsole');

function walk(dir) {
  return readdirSync(dir, { withFileTypes: true }).flatMap((e) => (e.isDirectory() ? walk(join(dir, e.name)) : [join(dir, e.name)]));
}
function fail(message) {
  console.error(message);
  process.exit(1);
}
