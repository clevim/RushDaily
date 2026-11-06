import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { startServer } from '../server/server.mjs';

const dir = mkdtempSync(join(tmpdir(), 'rushdaily-sync-'));
const SECRET = 'a'.repeat(43);
const OTHER = 'b'.repeat(43);

async function boot(options = {}) {
  const app = startServer({ port: 0, dbPath: join(dir, `${Math.random()}.db`), log: () => {}, ...options });
  apps.push(app);
  const port = await app.ready;
  const call = (method, path, { secret, body, headers = {} } = {}) => fetch(`http://127.0.0.1:${port}${path}`, {
    method,
    headers: { ...(secret ? { Authorization: `Bearer ${secret}` } : {}), ...(body !== undefined ? { 'Content-Type': 'application/json' } : {}), ...headers },
    body: body === undefined ? undefined : typeof body === 'string' || body instanceof Uint8Array ? body : JSON.stringify(body),
  });
  return { app, call };
}
const apps = [];
const data = (extra = {}) => ({ v: 1, history: { '2026-10-01': 'win' }, ...extra });

// Fecha tudo mesmo se um teste falhar no meio (senão o servidor segura o processo).
test.after(async () => { await Promise.all(apps.map((app) => app.close())); rmSync(dir, { recursive: true, force: true }); });

test('reivindica, lê, grava, 409 de concorrência, segredo errado, rotação e apagar', async () => {
  const { app, call } = await boot();
  assert.equal((await call('GET', '/api/health')).status, 200);
  assert.equal((await call('GET', '/api/sync/ABC123', { secret: SECRET })).status, 404);
  assert.equal((await call('PUT', '/api/sync/ABC123', { secret: SECRET, body: { data: data(), baseRev: 3 } })).status, 409, 'chave livre exige baseRev 0');
  const claim = await call('PUT', '/api/sync/ABC123', { secret: SECRET, body: { data: data(), baseRev: 0 } });
  assert.equal(claim.status, 201);
  assert.equal((await claim.json()).rev, 1);
  assert.equal((await call('PUT', '/api/sync/ABC123', { secret: OTHER, body: { data: data(), baseRev: 0 } })).status, 403, 'outro segredo não toma a chave');
  assert.equal((await call('GET', '/api/sync/ABC123')).status, 401);
  assert.equal((await call('GET', '/api/sync/ABC123', { secret: OTHER })).status, 403);
  const read = await call('GET', '/api/sync/ABC123', { secret: SECRET });
  assert.equal(read.headers.get('cache-control'), 'no-store');
  assert.deepEqual(await read.json().then((body) => [body.rev, body.data]), [1, data()]);
  assert.equal((await call('PUT', '/api/sync/ABC123', { secret: SECRET, body: { data: data({ pity: 2 }), baseRev: 1 } })).status, 200);
  const stale = await call('PUT', '/api/sync/ABC123', { secret: SECRET, body: { data: data({ pity: 9 }), baseRev: 1 } });
  assert.equal(stale.status, 409);
  const conflict = await stale.json();
  assert.equal(conflict.rev, 2);
  assert.equal(conflict.data.pity, 2, 'o 409 já traz o atual para juntar');
  assert.equal((await call('POST', '/api/sync/ABC123/rotate', { secret: SECRET, body: { secret: OTHER } })).status, 204);
  assert.equal((await call('GET', '/api/sync/ABC123', { secret: SECRET })).status, 403, 'segredo antigo deixa de valer');
  assert.equal((await call('GET', '/api/sync/ABC123', { secret: OTHER })).status, 200);
  assert.equal((await call('DELETE', '/api/sync/ABC123', { secret: OTHER })).status, 204);
  assert.equal((await call('GET', '/api/sync/ABC123', { secret: OTHER })).status, 404);
});

test('validação: chave 400, corpo 400/415, tamanho 413', async () => {
  const { app, call } = await boot({ maxBytes: 2048 });
  assert.equal((await call('GET', '/api/sync/abc123', { secret: SECRET })).status, 400);
  assert.equal((await call('GET', '/api/sync/ABC12', { secret: SECRET })).status, 400);
  assert.equal((await call('PUT', '/api/sync/ABC123', { secret: SECRET, body: '{nada' })).status, 400);
  assert.equal((await call('PUT', '/api/sync/ABC123', { secret: SECRET, body: { data: { v: 1, intruso: 1 }, baseRev: 0 } })).status, 400, 'só as seções do esquema');
  assert.equal((await call('PUT', '/api/sync/ABC123', { secret: SECRET, body: { data: { v: 99 }, baseRev: 0 } })).status, 400, 'esquema futuro');
  assert.equal((await call('PUT', '/api/sync/ABC123', { secret: 'curto', body: { data: data(), baseRev: 0 } })).status, 401);
  assert.equal((await call('PUT', '/api/sync/ABC123', { secret: SECRET, body: 'x', headers: { 'Content-Type': 'text/plain' } })).status, 415);
  const big = await call('PUT', '/api/sync/ABC123', { secret: SECRET, body: { data: data({ pvp: 'x'.repeat(4096) }), baseRev: 0 } });
  assert.equal(big.status, 413);
});

test('limites: 429 por IP, por falha de autenticação na chave e por reivindicação, com Retry-After', async () => {
  const { app, call } = await boot({ trustProxy: true, limits: { ip: [3, 60e3], key: [2, 60e3], claim: [1, 3600e3] } });
  const asIp = (ip, path, secret = SECRET) => call('GET', path, { secret, headers: { 'X-Real-IP': ip } });
  for (let index = 0; index < 3; index += 1) assert.equal((await asIp('1.1.1.1', '/api/sync/AAA111')).status, 404);
  const blocked = await asIp('1.1.1.1', '/api/sync/AAA111');
  assert.equal(blocked.status, 429);
  assert.ok(Number(blocked.headers.get('retry-after')) > 0);
  assert.equal((await asIp('2.2.2.2', '/api/sync/AAA111')).status, 404, 'outro IP segue livre');
  const claim = (key) => call('PUT', `/api/sync/${key}`, { secret: SECRET, body: { data: data(), baseRev: 0 }, headers: { 'X-Real-IP': '4.4.4.4' } });
  assert.equal((await claim('BBB222')).status, 201);
  assert.equal((await claim('CCC333')).status, 429, 'uma chave nova por hora por IP');
  assert.equal((await asIp('5.5.5.5', '/api/sync/BBB222', OTHER)).status, 403);
  assert.equal((await asIp('6.6.6.6', '/api/sync/BBB222', OTHER)).status, 403);
  assert.equal((await asIp('7.7.7.7', '/api/sync/BBB222', OTHER)).status, 429, 'a chave estourou (2 falhas de autenticação)');
  assert.equal((await asIp('8.8.8.8', '/api/sync/BBB222')).status, 200, 'o dono continua passando');
});

test('31 GETs sem segredo não bloqueiam o dono; chave inexistente sem segredo é 401 como a existente', async () => {
  const { call } = await boot();
  assert.equal((await call('PUT', '/api/sync/OWN001', { secret: SECRET, body: { data: data(), baseRev: 0 } })).status, 201);
  for (let index = 0; index < 31; index += 1) assert.ok([401, 429].includes((await call('GET', '/api/sync/OWN001')).status));
  assert.equal((await call('GET', '/api/sync/OWN001', { secret: SECRET })).status, 200);
  assert.equal((await call('GET', '/api/sync/NEW001')).status, 401, 'não revela que a chave não existe');
  assert.equal((await call('DELETE', '/api/sync/NEW001')).status, 401);
  assert.equal((await call('GET', '/api/sync/NEW001', { secret: SECRET })).status, 404);
});

test('chave com %xx (malformado ou não) é 400, nunca 500', async () => {
  const { call, admin } = await bootAdmin();
  for (const path of ['/api/sync/%E0%A4%A', '/api/sync/%41BC123', '/api/sync/ABC12%']) assert.equal((await call('GET', path, { secret: SECRET })).status, 400, path);
  assert.equal((await admin('/admin/usuario/%E0%A4%A')).status, 400);
});

test('sem proxy confiável, X-Real-IP é ignorado', async () => {
  const { app, call } = await boot({ limits: { ip: [2, 60e3] } });
  for (const ip of ['1.1.1.1', '2.2.2.2']) await call('GET', '/api/sync/AAA111', { secret: SECRET, headers: { 'X-Real-IP': ip } });
  assert.equal((await call('GET', '/api/sync/AAA111', { secret: SECRET, headers: { 'X-Real-IP': '9.9.9.9' } })).status, 429);
});

test('backup diário com VACUUM INTO e rotação de 7 arquivos', async () => {
  const backupDir = join(dir, 'backup');
  const { app, call } = await boot({ backupDir });
  await call('PUT', '/api/sync/ABC123', { secret: SECRET, body: { data: data(), baseRev: 0 } });
  for (let day = 1; day <= 9; day += 1) writeFileSync(join(backupDir, `sync-2020-01-0${day}.db`), '');
  const file = app.backup(new Date('2030-01-01T12:00:00Z'));
  const files = readdirSync(backupDir).sort();
  assert.equal(files.length, 7);
  assert.equal(files.at(-1), 'sync-2030-01-01.db');
  const { DatabaseSync } = await import('node:sqlite');
  const copy = new DatabaseSync(file, { readOnly: true });
  assert.equal(copy.prepare('SELECT COUNT(*) AS n FROM saves').get().n, 1);
  copy.close();
});

// ---- Acompanhamento de acessos e listener de estatísticas ----
const TOKEN = 'T'.repeat(40);
const DAY = 86400e3;

async function bootAdmin(options = {}) {
  let t = Date.parse('2026-10-24T15:00:00Z'); // 12h em Brasília
  const clock = { advance: (ms) => { t += ms; } };
  const { app, call } = await boot({ adminToken: TOKEN, adminPort: 0, now: () => t, ...options });
  const adminPort = await app.adminReady;
  const admin = (path, { token = TOKEN, method = 'GET' } = {}) => fetch(`http://127.0.0.1:${adminPort}${path}`, { method, headers: token ? { Authorization: `Bearer ${token}` } : {} });
  return { app, call, admin, clock };
}
const claim = (call, key, extra = {}) => call('PUT', `/api/sync/${key}`, { secret: SECRET, body: { data: data(extra), baseRev: 0 } });

test('acesso: conta no máximo 1 a cada 5 min, guarda dias ativos e nada pessoal', async () => {
  const ctl = await bootAdmin();
  await claim(ctl.call, 'ACC001'); // 1 acesso
  await ctl.call('GET', '/api/sync/ACC001', { secret: SECRET }); // dentro de 5 min: não conta
  ctl.clock.advance(6 * 60e3);
  await ctl.call('GET', '/api/sync/ACC001', { secret: SECRET }); // conta
  await ctl.call('GET', '/api/sync/ACC001', { secret: OTHER }); // 403: não registra
  ctl.clock.advance(DAY);
  await ctl.call('GET', '/api/sync/ACC001', { secret: SECRET }); // outro dia
  const row = ctl.app.db.prepare('SELECT * FROM acessos WHERE key = ?').get('ACC001');
  assert.equal(row.total, 3);
  assert.ok(row.ultimo > row.primeiro);
  assert.deepEqual(ctl.app.db.prepare('SELECT dia FROM dias_ativos ORDER BY dia').all().map((r) => r.dia), ['2026-10-24', '2026-10-25']);
  const cols = [...ctl.app.db.prepare('PRAGMA table_info(acessos)').all(), ...ctl.app.db.prepare('PRAGMA table_info(dias_ativos)').all()].map((c) => c.name).join(',');
  assert.ok(!/ip|agent|ua/i.test(cols.replace(/primeiro/g, '')), `colunas: ${cols}`);
});

test('DELETE apaga também os registros de acesso', async () => {
  const { app, call } = await bootAdmin();
  await claim(call, 'DEL001');
  assert.equal(app.db.prepare('SELECT COUNT(*) AS n FROM acessos').get().n, 1);
  assert.equal((await call('DELETE', '/api/sync/DEL001', { secret: SECRET })).status, 204);
  assert.equal(app.db.prepare('SELECT COUNT(*) AS n FROM acessos').get().n, 0);
  assert.equal(app.db.prepare('SELECT COUNT(*) AS n FROM dias_ativos').get().n, 0);
});

test('migração do esquema é idempotente (banco antigo só com saves)', async () => {
  const path = join(dir, 'antigo.db');
  const first = await boot({ dbPath: path });
  await claim(first.call, 'OLD001');
  await first.app.close();
  apps.splice(apps.indexOf(first.app), 1); // já fechado: o test.after não fecha de novo
  const again = await boot({ dbPath: path }); // reabre: CREATE IF NOT EXISTS não quebra nem apaga
  assert.equal(again.app.db.prepare('SELECT COUNT(*) AS n FROM saves').get().n, 1);
  assert.equal(again.app.db.prepare('SELECT COUNT(*) AS n FROM acessos').get().n, 1);
});

test('listener de estatísticas fica desligado sem ADMIN_TOKEN (ou com token curto)', async () => {
  for (const adminToken of ['', 'curto']) {
    const { app } = await boot({ adminToken, adminPort: 0 });
    assert.equal(await app.adminReady, null);
  }
});

test('estatísticas: 401 sem token, 403 com token errado, só GET, e /admin não existe na porta pública', async () => {
  const { call, admin } = await bootAdmin();
  assert.equal((await admin('/admin/resumo', { token: '' })).status, 401);
  assert.equal((await admin('/admin/resumo', { token: 'x'.repeat(40) })).status, 403);
  assert.equal((await admin('/admin/resumo', { token: TOKEN.slice(0, 39) })).status, 403);
  for (const method of ['POST', 'PUT', 'DELETE']) assert.equal((await admin('/admin/resumo', { method })).status, 405);
  assert.equal((await admin('/admin/nada')).status, 404);
  assert.equal((await call('GET', '/admin/resumo', { headers: { Authorization: `Bearer ${TOKEN}` } })).status, 404, 'a API pública não serve /admin');
  assert.equal((await call('GET', '/api/admin/resumo', { headers: { Authorization: `Bearer ${TOKEN}` } })).status, 404);
});

test('estatísticas: resumo e usuários com dados de exemplo', async () => {
  const { call, admin, clock } = await bootAdmin();
  const history = { '2026-10-22': 'win', '2026-10-23': 'win', '2026-10-24': 'win', '2026-10-10': 'loss', '2026-09-30': 'win' };
  await claim(call, 'AAA111', { history, collection: { 1: 2, 2: 1, 3: 1 }, decks: { list: [{ id: 'a' }, { id: 'b', updatedAt: 5 }] }, pvp: [{ date: '2026-10-01' }], boosters: { '2026-10-01': {}, '2026-10-02': {} }, recover: { '2026-10-05': 'x' } });
  clock.advance(DAY * 3);
  await claim(call, 'BBB222');
  clock.advance(DAY);
  await call('GET', '/api/sync/AAA111', { secret: SECRET });
  const resumo = await (await admin('/admin/resumo')).json();
  assert.equal(resumo.totalChaves, 2);
  assert.deepEqual([resumo.ativosHoje, resumo.ativos7d, resumo.ativos30d], [1, 2, 2]);
  assert.equal(resumo.ativosPorDia.length, 60);
  assert.equal(resumo.ativosPorDia.at(-1).dia, '2026-10-28');
  assert.equal(resumo.ativosPorDia.at(-1).ativos, 1);
  assert.equal(resumo.novasPorDia.find((d) => d.dia === '2026-10-27').novas, 1);
  const list = await (await admin('/admin/usuarios?ordem=acessos&dir=asc&limite=10')).json();
  assert.equal(list.total, 2);
  assert.deepEqual(list.usuarios.map((u) => u.key), ['BBB222', 'AAA111']);
  const a = list.usuarios[1];
  assert.equal(a.acessos, 2);
  assert.equal(a.diasAtivos, 2);
  assert.equal(a.rev, 1);
  assert.ok(a.bytes > 50);
  assert.deepEqual(a.progresso, { vitorias: 4, derrotas: 1, empates: 0, sequencia: 0, cartas: 3, decks: 2, decksEditados: 1, pvp: 1, pecasEnigma: 4, boosters: 2 });
  assert.equal((await (await admin('/admin/usuarios?busca=bbb')).json()).total, 1);
  assert.equal((await admin('/admin/usuarios?ordem=data;drop')).status, 400);
  assert.equal((await admin('/admin/usuarios?limite=1000')).status, 400);
  const detail = await (await admin('/admin/usuario/AAA111')).json();
  assert.deepEqual(detail.dias, ['2026-10-28', '2026-10-24']);
  assert.equal((await admin('/admin/usuario/ZZZ999')).status, 404);
});

// ---- Payload: 304 com If-None-Match, PUT com gzip (e teto do descomprimido) ----
test('GET com If-None-Match da rev atual: 304 sem corpo; rev velha ou sem cabeçalho: 200 com ETag', async () => {
  const { call } = await boot();
  await claim(call, 'ETG001');
  for (const tag of ['"1"', '1', 'W/"1"', '"7", "1"']) {
    const res = await call('GET', '/api/sync/ETG001', { secret: SECRET, headers: { 'If-None-Match': tag } });
    assert.equal(res.status, 304, tag);
    assert.equal(await res.text(), '');
    assert.equal(res.headers.get('etag'), '"1"');
  }
  const fresh = await call('GET', '/api/sync/ETG001', { secret: SECRET, headers: { 'If-None-Match': '"0"' } });
  assert.equal(fresh.status, 200);
  assert.equal(fresh.headers.get('etag'), '"1"');
  assert.equal((await fresh.json()).rev, 1);
  assert.equal((await call('GET', '/api/sync/ETG001', { secret: OTHER, headers: { 'If-None-Match': '"1"' } })).status, 403, 'o 304 também exige o segredo');
  assert.equal((await call('GET', '/api/sync/ETG001', { headers: { 'If-None-Match': '"1"' } })).status, 401);
});

test('PUT com Content-Encoding gzip: aceita, recusa gzip quebrado (400), bomba (413) e encoding desconhecido (415)', async () => {
  const { gzipSync } = await import('node:zlib');
  const { call } = await boot();
  const raw = (body, encoding) => call('PUT', '/api/sync/GZP001', { secret: SECRET, body, headers: { 'Content-Type': 'application/json', ...(encoding ? { 'Content-Encoding': encoding } : {}) } });
  const big = data({ pity: 3, recover: Object.fromEntries(Array.from({ length: 300 }, (_, i) => [`2026-0${1 + (i % 9)}-${String(1 + (i % 28)).padStart(2, '0')}`, `p${i}`])) });
  assert.equal((await raw(gzipSync(JSON.stringify({ data: big, baseRev: 0 })), 'gzip')).status, 201);
  const saved = await (await call('GET', '/api/sync/GZP001', { secret: SECRET })).json();
  assert.deepEqual(saved.data, big);
  assert.equal((await raw(JSON.stringify({ data: data({ pity: 4 }), baseRev: 1 }))).status, 200, 'sem gzip continua valendo');
  assert.equal((await raw(Buffer.from('não é gzip'), 'gzip')).status, 400);
  assert.equal((await raw(JSON.stringify({ data: data(), baseRev: 2 }), 'br')).status, 415);
  // 3 MiB de JSON viram poucos KB de gzip: passa no teto do corpo, mas não pode inflar além de 1 MiB.
  const bomb = gzipSync(`{"data":{"v":1,"settings":{"x":"${'a'.repeat(3 * 1024 * 1024)}"}},"baseRev":2}`);
  assert.ok(bomb.length < 64 * 1024);
  assert.equal((await raw(bomb, 'gzip')).status, 413);
  assert.equal((await (await call('GET', '/api/sync/GZP001', { secret: SECRET })).json()).rev, 2, 'nada gravado');
});

test('limpeza: apaga só rev 1 sem progresso e sem acesso há 90 dias; a chave volta no primeiro PUT', async () => {
  const { app, call, clock } = await bootAdmin();
  const starter = { v: 1, collection: { 10: 3 }, decks: { list: [{ id: 'd1', name: 'Deck inicial', main: [10], extra: [], updatedAt: 0 }] } };
  const put = (key, body, baseRev = 0) => call('PUT', `/api/sync/${key}`, { secret: SECRET, body: { data: body, baseRev } });
  assert.equal((await put('IDL001', starter)).status, 201); // abandonada: some
  assert.equal((await put('IDL002', { ...starter, history: { '2026-10-24': 'loss' } })).status, 201); // tem progresso: fica
  assert.equal((await put('IDL003', starter)).status, 201); // sem progresso, mas acessada há pouco: fica
  assert.equal((await put('IDL004', starter)).status, 201);
  assert.equal((await put('IDL004', starter, 1)).status, 200); // rev 2: regravada, fica
  clock.advance(91 * DAY);
  await call('GET', '/api/sync/IDL003', { secret: SECRET });
  assert.equal(app.sweepIdle(), 1);
  const keys = app.db.prepare('SELECT key FROM saves ORDER BY key').all().map((r) => r.key);
  assert.deepEqual(keys, ['IDL002', 'IDL003', 'IDL004']);
  for (const table of ['acessos', 'dias_ativos']) assert.equal(app.db.prepare(`SELECT COUNT(*) AS n FROM ${table} WHERE key = 'IDL001'`).get().n, 0, table);
  assert.equal((await call('GET', '/api/sync/IDL001', { secret: SECRET })).status, 404);
  assert.equal((await put('IDL001', { ...starter, history: { '2027-01-23': 'win' } })).status, 201, 'aparelho com a credencial antiga reivindica de novo');
  assert.equal(app.sweepIdle(), 0);
});

test('estatísticas: coortes (retenção D1/D7/D30, funil, histogramas) e desafios por dia', async () => {
  const { call, admin, clock } = await bootAdmin(); // 2026-10-24 (sábado) 12h em Brasília
  const put = (key, body) => call('PUT', `/api/sync/${key}`, { secret: SECRET, body: { data: { v: 1, ...body }, baseRev: 0 } });
  await put('COH001', { history: { '2026-10-23': 'win', '2026-10-24': 'win' }, boosters: { '2026-10-24~duelist': { cards: [] } }, decks: { list: [{ id: 'a', updatedAt: 9 }] }, pvp: [{ date: '2026-10-24', vs: 'ABC123' }] });
  await put('COH002', { history: { '2026-10-24': 'loss' } });
  await put('COH003', { collection: { 1: 1 } });
  clock.advance(DAY);
  await call('GET', '/api/sync/COH001', { secret: SECRET }); // D1 da COH001
  clock.advance(2 * DAY); // terça 27: semana nova
  await put('COH004', { history: { '2026-10-27': 'draw' } });
  clock.advance(5 * DAY);
  await call('GET', '/api/sync/COH002', { secret: SECRET }); // D8: não é D7
  const c = await (await admin('/admin/coortes')).json();
  assert.equal(c.totalChaves, 4);
  assert.deepEqual(c.coortes.map((w) => [w.semana, w.chaves]), [['2026-10-19', 3], ['2026-10-26', 1]]);
  assert.deepEqual(c.coortes[0].d1, { base: 3, ativos: 1, pct: 33.3 });
  assert.deepEqual(c.coortes[0].d7, { base: 3, ativos: 0, pct: 0 });
  assert.deepEqual(c.coortes[0].d30, { base: 0, ativos: 0, pct: null }, 'D30 ainda não chegou: fora da base');
  assert.deepEqual(c.coortes[1].d1, { base: 1, ativos: 0, pct: 0 });
  assert.deepEqual(c.funil.map((s) => [s.etapa, s.chaves, s.emSequencia]), [
    ['criouChave', 4, 4], ['primeiroDuelo', 3, 3], ['primeiraVitoria', 1, 1], ['abriuBooster', 1, 1], ['montouDeck', 1, 1], ['jogouPvp', 1, 1]]);
  assert.equal(c.histogramas.sequencia.find((b) => b.faixa === '0').chaves, 4, 'sem vitória hoje nem ontem (01/11): sequência 0');
  assert.equal(c.histogramas.diasAtivos.find((b) => b.faixa === '2').chaves, 2);
  assert.equal(c.histogramas.diasAtivos.find((b) => b.faixa === '1').chaves, 2);
  assert.equal(c.histogramas.diasAtivos.at(-1).faixa, '60+');
  assert.ok(!JSON.stringify(c).includes('COH00'), 'só agregados: nenhuma chave');

  const d = await (await admin('/admin/desafios?dias=14')).json();
  assert.equal(d.porDia.length, 14);
  assert.equal(d.porDia.at(-1).dia, '2026-11-01');
  assert.deepEqual(d.porDia.find((x) => x.dia === '2026-10-24'), { dia: '2026-10-24', jogadores: 2, win: 1, loss: 1, draw: 0, pctWin: 50, pctLoss: 50, pctDraw: 0 });
  assert.equal(d.porDia.find((x) => x.dia === '2026-10-27').draw, 1);
  assert.equal(d.porDia.find((x) => x.dia === '2026-10-30').pctWin, null);
  assert.equal((await (await admin('/admin/desafios')).json()).porDia.length, 60, 'padrão 60 dias');
  for (const bad of ['0', '366', 'abc', '1.5']) assert.equal((await admin(`/admin/desafios?dias=${bad}`)).status, 400, bad);
  assert.equal((await admin('/admin/coortes', { token: 'x'.repeat(40) })).status, 403);
  assert.equal((await admin('/admin/desafios', { method: 'POST' })).status, 405);
});
