// Cliente de sync (src/ui/sync.js) contra o servidor de verdade, com o fetch interceptado para simular falhas.
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { startServer } from '../server/server.mjs';

const store = new Map();
globalThis.localStorage = { getItem: (key) => store.get(key) ?? null, setItem: (key, value) => store.set(key, String(value)), removeItem: (key) => store.delete(key), key: (index) => [...store.keys()][index] ?? null, get length() { return store.size; } };
globalThis.location = { search: '', hash: '', pathname: '/', origin: 'http://x' };

const dir = mkdtempSync(join(tmpdir(), 'rushdaily-client-'));
const app = startServer({ port: 0, dbPath: join(dir, 'sync.db'), log: () => {} });
const port = await app.ready;
const realFetch = globalThis.fetch;
const server = (url, init) => realFetch(`http://127.0.0.1:${port}/${url}`, init);
let intercept = null; // (url, init) => Response | undefined
globalThis.fetch = async (url, init) => (await intercept?.(url, init)) ?? server(url, init);

const { credOf, rotateSecret, syncNow } = await import('../src/ui/sync.js');
const { writeJson } = await import('../src/ui/common.js');
const as = (key) => { store.set('rushdaily-player-key', key); return key; };

test.after(async () => { await app.close(); rmSync(dir, { recursive: true, force: true }); });

test('troca de segredo: servidor troca, a resposta se perde e o sync seguinte continua ligado', async () => {
  const key = as('ROT001');
  assert.equal((await syncNow()).status, 'on');
  const old = credOf(key).secret;
  intercept = async (url, init) => {
    if (!url.endsWith('/rotate')) return undefined;
    await server(url, init); // o servidor grava a troca...
    throw new DOMException('abortado', 'AbortError'); // ...e a resposta não chega
  };
  assert.equal(await rotateSecret(key), false);
  intercept = null;
  const pending = credOf(key);
  assert.equal(pending.secret, old);
  assert.ok(pending.next && pending.next !== old, 'next gravado antes do POST');
  assert.equal((await syncNow()).status, 'on', 'o 403 do segredo antigo tenta o next');
  assert.equal(credOf(key).secret, pending.next);
  assert.equal(credOf(key).next, undefined);
  assert.equal(await rotateSecret(key), true, 'troca normal: 204 promove o next');
  assert.notEqual(credOf(key).secret, pending.next);
  assert.equal((await syncNow()).status, 'on');
});

test('403 depois de já ter sincronizado vira "segredo trocado" (lastError 403); 429 fica salvo até o próximo sucesso', async () => {
  const key = as('ERR001');
  assert.equal((await syncNow()).status, 'on');
  intercept = (url) => (url.startsWith('api/sync/') ? new Response('{}', { status: 429 }) : undefined);
  assert.equal((await syncNow()).status, 'error');
  assert.equal(credOf(key).lastError.code, 429);
  intercept = null;
  assert.equal((await syncNow()).status, 'on');
  assert.equal(credOf(key).lastError, undefined, 'sucesso limpa o erro');
  // Outro aparelho troca o segredo:
  const res = await server(`api/sync/${key}/rotate`, { method: 'POST', headers: { Authorization: `Bearer ${credOf(key).secret}`, 'Content-Type': 'application/json' }, body: JSON.stringify({ secret: 'z'.repeat(43) }) });
  assert.equal(res.status, 204);
  assert.equal((await syncNow()).status, 'taken');
  assert.equal(credOf(key).status, 'taken');
  assert.equal(credOf(key).lastError.code, 403);
});

test('gravação no meio de um sync lento gera um segundo PUT', async () => {
  const key = as('DRT001');
  assert.equal((await syncNow()).status, 'on');
  const puts = [];
  intercept = async (url, init) => {
    if (init.method !== 'PUT') return undefined;
    puts.push(JSON.parse(init.body).data);
    if (puts.length === 1) {
      writeJson('rushdaily-history', { [key]: { '2026-10-09': 'win' } }); // o jogo grava enquanto o PUT viaja
      await new Promise((done) => setTimeout(done, 50));
    }
    return undefined;
  };
  store.set('rushdaily-classic-pity:DRT001', '2');
  assert.equal((await syncNow()).status, 'on');
  intercept = null;
  assert.equal(puts.length, 2);
  assert.equal(puts[0].history['2026-10-09'], undefined);
  assert.equal(puts[1].history['2026-10-09'], 'win');
  const saved = await (await server(`api/sync/${key}`, { headers: { Authorization: `Bearer ${credOf(key).secret}` } })).json();
  assert.equal(saved.data.history['2026-10-09'], 'win');
});
