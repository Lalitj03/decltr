// Dev-only preview: serves the real side panel in a normal browser tab with a
// mock chrome.* API and a fake Decltr server, so the UI can be exercised without
// loading the extension. Open http://localhost:5173/panel
//   ?server=ok | offline | nokey | billing    (default ok)
//   &tabs=many                                (a larger tab set)
import http from 'node:http';
import { readFile } from 'node:fs/promises';
import { extname, join, normalize } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(fileURLToPath(import.meta.url), '..', '..');
const types = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.png': 'image/png', '.json': 'application/json' };
const port = Number(process.env.PORT ?? 5173);

http
  .createServer(async (req, res) => {
    const url = new URL(req.url, 'http://localhost');
    try {
      if (url.pathname === '/panel') {
        let html = await readFile(join(root, 'extension', 'sidepanel.html'), 'utf8');
        html = html
          .replace('href="sidepanel.css"', 'href="/extension/sidepanel.css"')
          .replace('src="icons/icon32.png"', 'src="/extension/icons/icon32.png"')
          .replace('<script type="module" src="sidepanel.js">', '<script type="module" src="/dev/harness.js"></script>\n    <script type="module" src="/extension/sidepanel.js">');
        res.writeHead(200, { 'content-type': 'text/html' }).end(html);
        return;
      }
      const file = normalize(join(root, url.pathname));
      if (!file.startsWith(root) || !/^\/(extension|dev)\//.test(url.pathname)) throw new Error('nope');
      const data = await readFile(file);
      res.writeHead(200, { 'content-type': types[extname(file)] ?? 'application/octet-stream', 'cache-control': 'no-store' }).end(data);
    } catch {
      res.writeHead(404).end('not found');
    }
  })
  .listen(port, '127.0.0.1', () => console.log(`UI preview: http://localhost:${port}/panel`));
