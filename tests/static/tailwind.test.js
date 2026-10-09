// tailwind.css is built from the pages (npm run build:css) and committed; the pages no longer compile Tailwind
// in the browser. A page or script that gains a Tailwind class must ship with a rebuilt tailwind.css.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { execFileSync } from 'child_process';
import { fileURLToPath } from 'url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const cli = path.join(root, 'node_modules/tailwindcss3/lib/cli.js');
const pages = fs.readdirSync(root).filter((f) => f.endsWith('.html'));

test('no page loads the Tailwind CDN compiler', () => {
  const left = pages.filter((p) => /cdn\.tailwindcss\.com/.test(fs.readFileSync(path.join(root, p), 'utf8')));
  assert.deepEqual(left, []);
});

test('tailwind.css is linked last in <head> (where the CDN put its styles)', () => {
  for (const p of pages) {
    const html = fs.readFileSync(path.join(root, p), 'utf8');
    if (!html.includes('tailwind.css')) continue;
    const head = html.slice(0, html.indexOf('</head>'));
    const lastTag = head.trimEnd().split('\n').pop();
    assert.match(lastTag, /<link rel="stylesheet" href="tailwind\.css\?v=[\w-]+">/, p);
  }
});

test('tailwind.css is up to date with the pages (run npm run build:css)', { skip: !fs.existsSync(cli) && 'tailwindcss3 dev dependency not installed', timeout: 60000 }, () => {
  const out = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'tw-')), 'tailwind.css');
  execFileSync(process.execPath, [cli, '-c', 'tailwind.config.cjs', '-i', 'tailwind.src.css', '-o', out, '--minify'], { cwd: root, stdio: 'pipe' });
  assert.ok(fs.readFileSync(out, 'utf8') === fs.readFileSync(path.join(root, 'tailwind.css'), 'utf8'), 'tailwind.css is stale: run npm run build:css and commit it');
});
