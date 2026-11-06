import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';

const read = (f) => readFileSync(new URL(`../${f}`, import.meta.url), 'utf8');

test('sw.js: cards.json network-first, /api/ e não-GET nunca interceptados', () => {
  const sw = read('sw.js');
  assert.match(sw, /const VERSION = /);
  assert.match(sw, /request\.method !== 'GET'/);
  assert.match(sw, /startsWith\('\/api\/'\)/);
  // cards.json não pode casar com a regex cache-first
  const staticRe = new RegExp(/const STATIC = \/(.*)\/i;/.exec(sw)[1], 'i');
  assert.ok(!staticRe.test('/src/data/rush/cards.json'));
  assert.ok(staticRe.test('/src/vendor/ocgcore/ocgcore.wasm') && staticRe.test('/src/assets/rush-art/1.jpg'));
  assert.match(sw, /STATIC\.test\(url\.pathname\) \? cacheFirst\(request\) : networkFirst\(request\)/);
  assert.match(sw, /async function networkFirst[\s\S]*await fetch[\s\S]*caches\.match/);
  assert.match(sw, /caches\.delete/);
});

test('sw.js: arquivos do shell existem', () => {
  const list = [...read('sw.js').matchAll(/^ {2}'\/([^']+)',$/gm)].map((m) => m[1]);
  assert.ok(list.length > 20);
  for (const f of list) assert.ok(existsSync(new URL(`../${f}`, import.meta.url)), f);
});

test('manifest válido e ícones existem', () => {
  const m = JSON.parse(read('manifest.webmanifest'));
  assert.equal(m.name, 'RushDaily');
  assert.equal(m.display, 'standalone');
  assert.equal(m.start_url, '/');
  for (const k of ['background_color', 'theme_color']) assert.match(m[k], /^#[0-9a-f]{6}$/i);
  for (const size of ['192x192', '512x512']) {
    const icon = m.icons.find((i) => i.sizes === size);
    assert.ok(icon && existsSync(new URL(`../${icon.src}`, import.meta.url)), size);
  }
});

test('HTMLs linkam manifest e pwa.js', () => {
  for (const f of ['index.html', 'duel.html', 'screens.html', 'arena.html']) {
    const h = read(f);
    assert.match(h, /<link rel="manifest" href="manifest\.webmanifest"/, f);
    assert.match(h, /<meta name="theme-color"/, f);
    assert.match(h, /src="src\/ui\/pwa\.js"/, f);
  }
});
