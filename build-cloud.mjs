import { createHash } from 'node:crypto';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';

const read = (name) => readFileSync(new URL(name, import.meta.url), 'utf8');
const resources = ['manifest.webmanifest', 'icon.svg', 'icon-192.png', 'icon-512.png', 'apple-touch-icon.png'];
const assets = new Map(resources.map((name) => [name, readFileSync(new URL(`cloud/${name}`, import.meta.url))]));
const touchIconVersion = createHash('sha256').update(assets.get('apple-touch-icon.png')).digest('hex').slice(0, 8);
const inlineScripts = [];
const html = read('index.html')
  .replace('<link rel="stylesheet" href="styles.css">', () => `<link rel="manifest" href="/manifest.webmanifest">
    <link rel="icon" href="/icon.svg" type="image/svg+xml">
    <link rel="apple-touch-icon" href="/apple-touch-icon.png?v=${touchIconVersion}">
    <meta name="apple-mobile-web-app-title" content="Fíggjarætlan">
    <style>\n${read('styles.css')}\n</style>`)
  .replace('<script defer src="app.js"></script>', '<script defer src="cloud/sync.js"></script>\n    <script defer src="app.js"></script>')
  .replace(/^\s*<script defer src="([^"]+)"><\/script>$/gm, (_tag, source) => {
    inlineScripts.push(`\n${read(source).replace(/<\/script/gi, '<\\/script')}\n`);
    return '';
  })
  .replace('</body>', () => `${inlineScripts.map((source) => `<script>${source}</script>`).join('\n')}\n</body>`);

const serviceWorker = read('cloud/sw.js');
const build = createHash('sha256').update(html).update(serviceWorker);
for (const [, asset] of assets) build.update(asset);
const version = build.digest('hex').slice(0, 16);
const scriptHashes = inlineScripts.map((script) => `'sha256-${createHash('sha256').update(script).digest('base64')}'`);
const csp = ["default-src 'none'", `script-src ${scriptHashes.join(' ')}`, "style-src 'unsafe-inline'",
  "img-src 'self'", "connect-src 'self'", "worker-src 'self'", "manifest-src 'self'",
  "base-uri 'none'", "form-action 'self'", "frame-ancestors 'none'"].join('; ');
const headers = `/*
  Content-Security-Policy: ${csp}
  Referrer-Policy: no-referrer
  X-Content-Type-Options: nosniff
  Cache-Control: no-cache
`;

mkdirSync(new URL('dist/', import.meta.url), { recursive: true });
function write(name, content) {
  writeFileSync(new URL(`dist/${name}`, import.meta.url), content);
}
write('index.html', html);
write('_headers', headers);
write('sw.js', serviceWorker.replaceAll('__FIGGJARAETLAN_BUILD__', version));
for (const [name, asset] of assets) write(name, asset);
console.log(`Built private sync app (${version}).`);
