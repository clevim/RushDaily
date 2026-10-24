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
    body: body === undefined ? undefined : typeof body === 'string' ? body : JSON.stringify(body),
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

test('limites: 429 por IP, por chave e por reivindicação, com Retry-After', async () => {
  const { app, call } = await boot({ trustProxy: true, limits: { ip: [3, 60e3], key: [4, 60e3], claim: [1, 3600e3] } });
  const asIp = (ip, path) => call('GET', path, { secret: SECRET, headers: { 'X-Real-IP': ip } });
  for (let index = 0; index < 3; index += 1) assert.equal((await asIp('1.1.1.1', '/api/sync/AAA111')).status, 404);
  const blocked = await asIp('1.1.1.1', '/api/sync/AAA111');
  assert.equal(blocked.status, 429);
  assert.ok(Number(blocked.headers.get('retry-after')) > 0);
  assert.equal((await asIp('2.2.2.2', '/api/sync/AAA111')).status, 404, 'outro IP segue livre');
  assert.equal((await asIp('3.3.3.3', '/api/sync/AAA111')).status, 429, 'a chave estourou (4 pedidos)');
  const claim = (key) => call('PUT', `/api/sync/${key}`, { secret: SECRET, body: { data: data(), baseRev: 0 }, headers: { 'X-Real-IP': '4.4.4.4' } });
  assert.equal((await claim('BBB222')).status, 201);
  assert.equal((await claim('CCC333')).status, 429, 'uma chave nova por hora por IP');
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
  await claim(call, 'AAA111', { history, collection: { 1: 2, 2: 1, 3: 1 }, decks: { list: [{ id: 'a' }, { id: 'b' }] }, pvp: [{ date: '2026-10-01' }], boosters: { '2026-10-01': {}, '2026-10-02': {} }, recover: { '2026-10-05': 'x' } });
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
  assert.deepEqual(a.progresso, { vitorias: 4, derrotas: 1, sequencia: 0, cartas: 3, decks: 2, pvp: 1, pecasEnigma: 4, boosters: 2 });
  assert.equal((await (await admin('/admin/usuarios?busca=bbb')).json()).total, 1);
  assert.equal((await admin('/admin/usuarios?ordem=data;drop')).status, 400);
  assert.equal((await admin('/admin/usuarios?limite=1000')).status, 400);
  const detail = await (await admin('/admin/usuario/AAA111')).json();
  assert.deepEqual(detail.dias, ['2026-10-28', '2026-10-24']);
  assert.equal((await admin('/admin/usuario/ZZZ999')).status, 404);
});
