#!/usr/bin/env node
// Builds two zips of the extension:
//
//   dist/decltr-<version>-store.zip     for Edge Add-ons and the Chrome Web Store. Stores assign their own
//                                       extension ID, so this one has no "key".
//   dist/decltr-<version>-unpacked.zip  for a GitHub release, to unzip and "Load unpacked". It keeps the
//                                       "key", so every copy gets the pinned ID that the optional server accepts.
//
// The "key" is a public key, not a secret. The build refuses to finish if a zip would contain something that
// should never ship: a private key, an API key, a source map, a home-folder path or a dotfile.
//
//   npm run package
import { execFileSync } from 'node:child_process';
import { cpSync, mkdirSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { dirname, join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const source = join(root, 'extension');
const dist = join(root, 'dist');

const manifest = JSON.parse(readFileSync(join(source, 'manifest.json'), 'utf8'));
const pkg = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'));
if (manifest.version !== pkg.version) {
  fail(`manifest.json is version ${manifest.version} but package.json is ${pkg.version}. Make them match first.`);
}
if (!manifest.key) fail('manifest.json has no "key", so the unpacked zip would not get the pinned extension ID.');

const built = [build('store', { keepKey: false }), build('unpacked', { keepKey: true })];
for (const b of built) console.log(`Built ${b.zip} (${b.files} files, ${b.kb} KB)${b.keepKey ? ', with the pinned ID for Load unpacked' : ', without the development "key"'}.`);
console.log('Upload the store zip at https://partner.microsoft.com/dashboard/microsoftedge/overview (or the Chrome Web Store dashboard).');
console.log('Attach the unpacked zip to a GitHub release for people who load Decltr by hand.');

function build(kind, { keepKey }) {
  const stage = join(dist, kind);
  rmSync(stage, { recursive: true, force: true });
  mkdirSync(stage, { recursive: true });
  cpSync(source, stage, { recursive: true, filter: (path) => !/(^|\/)\.[^/]+$/.test(relative(source, path)) });
  const copy = { ...manifest };
  if (!keepKey) delete copy.key;
  writeFileSync(join(stage, 'manifest.json'), `${JSON.stringify(copy, null, 2)}\n`);

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
  if (problems.length) fail(`Not packaged (${kind}):\n  ${problems.join('\n  ')}`);

  const zip = join(dist, `decltr-${manifest.version}-${kind}.zip`);
  rmSync(zip, { force: true });
  execFileSync('zip', ['-q', '-r', '-X', zip, '.'], { cwd: stage, stdio: 'inherit' });
  return { zip: relative(root, zip), files: files.length, kb: (statSync(zip).size / 1024).toFixed(0), keepKey };
}

function walk(dir) {
  return readdirSync(dir, { withFileTypes: true }).flatMap((e) => (e.isDirectory() ? walk(join(dir, e.name)) : [join(dir, e.name)]));
}
function fail(message) {
  console.error(message);
  process.exit(1);
}
