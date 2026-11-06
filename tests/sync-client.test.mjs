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
const app = startServer({ port: 0, dbPath: join(dir, 'sync.db'), log: () => {}, limits: { claim: [100, 3600e3] } }); // todos os testes reivindicam do mesmo IP
const port = await app.ready;
const realFetch = globalThis.fetch;
const server = (url, init) => realFetch(`http://127.0.0.1:${port}/${url}`, init);
let intercept = null; // (url, init) => Response | undefined
globalThis.fetch = async (url, init) => (await intercept?.(url, init)) ?? server(url, init);

const { credOf, rotateSecret, syncNow } = await import('../src/ui/sync.js');
const { writeJson } = await import('../src/ui/common.js');
// Perfil com um dia jogado: sem progresso o cliente não reivindica a chave (ver o teste próprio).
const as = (key, played = true) => {
  store.set('rushdaily-player-key', key);
  if (played) store.set('rushdaily-history', JSON.stringify({ ...JSON.parse(store.get('rushdaily-history') ?? '{}'), [key]: { '2026-10-01': 'win' } }));
  return key;
};

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

const auth = (key, secret = credOf(key).secret) => ({ headers: { Authorization: `Bearer ${secret}` } });
const record = (log) => async (url, init) => {
  const res = await server(url, init);
  log.push([init.method, res.status, init.headers?.['Content-Encoding'] || '']);
  return res;
};

test('sem progresso não reivindica a chave; o primeiro sync com progresso cria (PUT baseRev 0)', async () => {
  const key = as('NOP001', false);
  assert.equal((await syncNow()).status, 'on');
  assert.equal((await server(`api/sync/${key}`, auth(key))).status, 404, 'servidor não guardou nada');
  assert.equal(credOf(key).rev, 0);
  store.set('rushdaily-history', JSON.stringify({ ...JSON.parse(store.get('rushdaily-history') ?? '{}'), [key]: { '2026-10-05': 'win' } }));
  assert.equal((await syncNow()).status, 'on');
  assert.equal(credOf(key).rev, 1);
  assert.equal((await (await server(`api/sync/${key}`, auth(key))).json()).data.history['2026-10-05'], 'win');
  const shared = as('NOP002', false); // vai mandar um link de desafio: reivindica mesmo sem progresso
  assert.equal((await syncNow({ claim: true })).status, 'on');
  assert.equal(credOf(shared).rev, 1);
});

test('GET com If-None-Match: 304 sem PUT quando nada mudou; muda o local, 304 e PUT; credencial sem resumo reenvia', async () => {
  const key = as('NM0001');
  assert.equal((await syncNow()).status, 'on');
  const log = [];
  intercept = record(log);
  assert.equal((await syncNow()).status, 'on');
  assert.deepEqual(log.map(([m, s]) => [m, s]), [['GET', 304]]);
  log.length = 0;
  store.set(`rushdaily-classic-pity:${key}`, '3');
  assert.equal((await syncNow()).status, 'on');
  assert.deepEqual(log.map(([m, s]) => [m, s]), [['GET', 304], ['PUT', 200]]);
  log.length = 0;
  const { sum, ...old } = credOf(key);
  store.set(`rushdaily-sync:${key}`, JSON.stringify(old)); // credencial de antes do 304
  assert.equal((await syncNow()).status, 'on');
  assert.deepEqual(log.map(([m, s]) => [m, s]), [['GET', 304], ['PUT', 200]]);
  log.length = 0;
  // Outro aparelho grava: a rev muda e o GET volta a trazer o corpo.
  const rev = credOf(key).rev;
  await server(`api/sync/${key}`, { method: 'PUT', headers: { ...auth(key).headers, 'Content-Type': 'application/json' }, body: JSON.stringify({ data: { v: 1, history: { '2026-10-01': 'win', '2026-10-07': 'win' }, pity: 3 }, baseRev: rev }) });
  assert.equal((await syncNow()).status, 'on');
  intercept = null;
  assert.deepEqual(log.map(([m, s]) => [m, s]), [['GET', 200]]);
  assert.equal(JSON.parse(store.get('rushdaily-history'))[key]['2026-10-07'], 'win');
});

test('ligar aparelho com progresso próprio: junta K2 em K por união, sem contar cartas duas vezes', async () => {
  const { getPlayerKey } = await import('../src/ui/common.js');
  const S = 's'.repeat(43);
  const pack = (openedAt, ids) => ({ openedAt, seed: 'x', tier: 'common', cards: ids.map((id) => ({ id })) });
  const claimed = await server('api/sync/LNK001', { method: 'PUT', headers: { Authorization: `Bearer ${S}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ data: { v: 1, history: { '2026-10-01': 'win' }, boosters: { '2026-10-01~duelist': pack('2026-10-01T10:00:00Z', [111, 222]) }, collection: { 111: 1, 222: 1, 999: 3 } }, baseRev: 0 }) });
  assert.equal(claimed.status, 201);
  // Este aparelho jogava com a chave LNK002 (coleção inicial dela + um pacote).
  as('LNK002');
  store.set('rushdaily-classic-booster:LNK002:2026-10-02~duelist', JSON.stringify(pack('2026-10-02T10:00:00Z', [111, 333])));
  store.set('rushdaily-classic-collection:LNK002', JSON.stringify({ 111: 1, 333: 1, 888: 3 }));
  const asked = [];
  globalThis.confirm = (text) => { asked.push(text); return true; };
  globalThis.history = { replaceState: () => { location.hash = ''; } };
  Object.assign(location, { search: '?player=LNK001', hash: `#sync=${S}` });
  try {
    assert.equal(getPlayerKey(), 'LNK001');
    assert.equal(location.hash, '', 'segredo fora da barra');
    assert.equal(asked.length, 2);
    assert.match(asked[1], /Juntar o progresso deste aparelho \(perfil LNK002\) ao perfil LNK001/);
    assert.equal(getPlayerKey(), 'LNK001', 'não pergunta de novo na mesma página');
    assert.equal(asked.length, 2);
  } finally { location.search = ''; }
  assert.equal((await syncNow()).status, 'on');
  const saved = await (await server('api/sync/LNK001', auth('LNK001', S))).json();
  assert.deepEqual(saved.data.collection, { 111: 2, 222: 1, 333: 1, 888: 3, 999: 3 }, 'cada pacote conta uma vez');
  assert.deepEqual(Object.keys(saved.data.boosters).sort(), ['2026-10-01~duelist', '2026-10-02~duelist']);
  assert.equal(saved.data.history['2026-10-01'], 'win');
  assert.equal((await syncNow()).status, 'on');
  assert.deepEqual(JSON.parse(store.get('rushdaily-classic-collection:LNK001')), { 111: 2, 222: 1, 333: 1, 888: 3, 999: 3 }, 'sync seguinte não soma de novo');
  assert.deepEqual(JSON.parse(store.get('rushdaily-classic-collection:LNK002')), { 111: 1, 333: 1, 888: 3 }, 'o perfil antigo continua salvo');
});

test('link recusado: mantém o perfil e tira o #sync= da barra mesmo assim', async () => {
  const { getPlayerKey } = await import('../src/ui/common.js?recusa'); // instância nova (a resposta do confirm fica guardada por página)
  as('REF001');
  globalThis.confirm = () => false;
  globalThis.history = { replaceState: () => { location.hash = ''; } };
  Object.assign(location, { search: '?player=REF002', hash: `#sync=${'s'.repeat(43)}` });
  try {
    assert.equal(getPlayerKey(), 'REF001');
    assert.equal(location.hash, '');
    assert.equal(store.get('rushdaily-sync:REF002'), undefined);
  } finally { location.search = ''; }
});

test('progresso acima de ~800 KB: corta os replays PvP mais antigos, avisa em lastError e envia com gzip', async () => {
  const key = as('TRM001');
  const day = (i) => new Date(Date.UTC(2024, 0, 1 + i)).toISOString().slice(0, 10);
  const pvp = Array.from({ length: 100 }, (_, i) => ({ date: day(1000 - i), vs: 'ABC123', result: 'win', turns: 5, lp: 100, replay: 'A'.repeat(4000) }));
  store.set(`rushdaily-classic-pvp:${key}`, JSON.stringify(pvp));
  for (let i = 0; i < 1000; i += 1) {
    store.set(`rushdaily-classic-booster:${key}:${day(Math.floor(i / 3))}~${['rookie', 'duelist', 'expert'][i % 3]}`, JSON.stringify({ openedAt: `${day(i)}T00:00:00Z`, seed: `s${i}`, tier: 'common', cards: Array.from({ length: 10 }, (_, c) => ({ id: 10000000 + c })) }));
  }
  const log = [];
  intercept = record(log);
  assert.equal((await syncNow({ timeout: 20000 })).status, 'on');
  intercept = null;
  const put = log.find(([m]) => m === 'PUT');
  assert.deepEqual(put, ['PUT', 201, 'gzip']);
  const cred = credOf(key);
  assert.equal(cred.lastError.code, 'trimmed');
  assert.ok(cred.lastError.count > 0 && cred.lastError.count < 100, String(cred.lastError.count));
  const saved = await (await server(`api/sync/${key}`, auth(key))).json();
  assert.ok(JSON.stringify(saved.data).length <= 800 * 1024);
  assert.equal(saved.data.pvp.length, 100, 'o resultado de todo duelo continua');
  assert.ok(saved.data.pvp[0].replay, 'o mais novo mantém o replay');
  assert.equal(saved.data.pvp.at(-1).replay, undefined, 'o mais antigo perdeu');
  assert.equal(JSON.parse(store.get(`rushdaily-classic-pvp:${key}`)).at(-1).replay, undefined, 'cortado também no aparelho');
  assert.equal((await syncNow({ timeout: 20000 })).status, 'on');
  assert.equal(credOf(key).lastError.code, 'trimmed', 'o aviso continua depois do sync seguinte');
});

// Por último: depois do 400 o módulo deixa de tentar gzip até recarregar.
test('servidor sem gzip (400 ao corpo comprimido): repete o PUT cru', async () => {
  const key = as('GZF001');
  for (let i = 0; i < 20; i += 1) store.set(`rushdaily-classic-booster:${key}:2026-09-${String(i + 1).padStart(2, '0')}`, JSON.stringify({ openedAt: `2026-09-${String(i + 1).padStart(2, '0')}T00:00:00Z`, seed: `s${i}`, cards: Array.from({ length: 10 }, (_, c) => ({ id: 20000000 + c })) }));
  const log = [];
  intercept = async (url, init) => {
    if (init.headers?.['Content-Encoding'] === 'gzip') { log.push('gzip'); return new Response('{"error":"JSON inválido."}', { status: 400 }); }
    if (init.method === 'PUT') log.push(`cru ${init.body.length}`);
    return undefined;
  };
  assert.equal((await syncNow()).status, 'on');
  intercept = null;
  assert.equal(log[0], 'gzip');
  assert.match(log[1], /^cru \d+$/);
  assert.ok(Number(log[1].slice(4)) > 8 * 1024);
  assert.equal(Object.keys((await (await server(`api/sync/${key}`, auth(key))).json()).data.boosters).length, 20);
});
