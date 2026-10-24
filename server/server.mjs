// Servidor de sincronização do RushDaily: Node 24 + SQLite embutido (node:sqlite), sem dependências.
// Uma linha por chave de jogador; quem reivindica a chave guarda só o hash do segredo. Desenho em docs/sync/README.md.
import { createServer } from 'node:http';
import { DatabaseSync } from 'node:sqlite';
import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';

import { existsSync, mkdirSync, readdirSync, rmSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { SCHEMA_VERSION, SECTIONS } from '../src/ui/sync-merge.js';

const KEY = /^[A-Z0-9]{6}$/;
const SECRET = /^[A-Za-z0-9_-]{22,128}$/; // base64url; 22 caracteres = 132 bits (o cliente gera 32 bytes = 43)
const ALLOWED = new Set(['v', ...SECTIONS]);

const DEFAULTS = {
  host: '127.0.0.1',
  port: 8787,
  dbPath: resolve(dirname(fileURLToPath(import.meta.url)), 'data/sync.db'),
  backupDir: null,
  backupKeep: 7,
  trustProxy: false, // true só atrás do nginx (que grava X-Real-IP a partir do CF-Connecting-IP)
  maxBytes: 1024 * 1024,
  maxKeys: 20000, // teto de chaves reivindicadas: disco não cresce sem limite
  limits: { ip: [60, 60e3], key: [30, 60e3], claim: [5, 3600e3] }, // [pedidos, janela em ms]
  log: (line) => console.log(line),
  now: () => Date.now(),
  tzMin: -180, // fuso dos "dias ativos" (Brasília, sem horário de verão)
  accessGapMs: 5 * 60e3, // no máximo 1 acesso contado por chave a cada 5 min
  adminToken: '', adminPort: 8788, adminHost: '127.0.0.1', // listener de estatísticas: só liga com adminToken (>= 32 caracteres)
};

const DAY_MS = 86400e3;
const ORDERS = { ultimo: 'a.ultimo', primeiro: 'a.primeiro', acessos: 'a.total', dias: 'dias', bytes: 'bytes', rev: 's.rev', criada: 's.created_at', key: 's.key' };

/** Resumo do progresso salvo (só contagens; o dado é validado na gravação, mas aqui tudo é defensivo). */
export function progressSummary(data, today) {
  const history = data?.history && typeof data.history === 'object' ? data.history : {};
  const count = (value) => (value && typeof value === 'object' ? Object.keys(value).length : 0);
  const results = Object.values(history);
  const month = today.slice(0, 7);
  const pieces = new Set([...Object.keys(history).filter((day) => history[day] === 'win'), ...Object.keys(data?.recover || {})].filter((day) => day.startsWith(month)));
  let streak = 0; // vitórias em dias seguidos até hoje (ou até ontem, se hoje ainda não jogou)
  for (let t = Date.parse(`${today}T00:00:00Z`); ; t -= DAY_MS) {
    const result = history[new Date(t).toISOString().slice(0, 10)];
    if (result === 'win') streak += 1; else if (!(streak === 0 && t === Date.parse(`${today}T00:00:00Z`))) break;
  }
  return {
    vitorias: results.filter((r) => r === 'win').length, derrotas: results.filter((r) => r === 'loss').length, sequencia: streak,
    cartas: count(data?.collection), decks: Array.isArray(data?.decks?.list) ? data.decks.list.length : 0,
    pvp: Array.isArray(data?.pvp) ? data.pvp.length : 0, pecasEnigma: pieces.size, boosters: count(data?.boosters),
  };
}

const hashOf = (salt, secret) => createHash('sha256').update(salt).update(secret).digest();

/** Janela fixa por identificador. Devolve 0 (pode) ou os segundos até liberar. */
function limiter([max, windowMs]) {
  const hits = new Map();
  return {
    take(id, now = Date.now()) {
      let entry = hits.get(id);
      if (!entry || entry.reset <= now) hits.set(id, entry = { count: 0, reset: now + windowMs });
      entry.count += 1;
      return entry.count <= max ? 0 : Math.ceil((entry.reset - now) / 1000);
    },
    sweep(now = Date.now()) { for (const [id, entry] of hits) if (entry.reset <= now) hits.delete(id); },
  };
}

class HttpError extends Error {
  constructor(status, message, extra = {}) { super(message); this.status = status; this.extra = extra; }
}

function readBody(req, maxBytes) {
  return new Promise((done, fail) => {
    if (Number(req.headers['content-length']) > maxBytes) { fail(new HttpError(413, 'Progresso grande demais.')); req.resume(); return; }
    const chunks = [];
    let size = 0;
    req.on('data', (chunk) => {
      size += chunk.length;
      // Passou do teto: para de guardar e só escoa o resto (destruir aqui impediria a resposta 413).
      if (size > maxBytes) { fail(new HttpError(413, 'Progresso grande demais.')); req.removeAllListeners('data'); req.resume(); return; }
      chunks.push(chunk);
    });
    req.on('end', () => {
      try { done(JSON.parse(Buffer.concat(chunks).toString('utf8'))); } catch { fail(new HttpError(400, 'JSON inválido.')); }
    });
    req.on('error', fail);
  });
}

function validData(data) {
  if (!data || typeof data !== 'object' || Array.isArray(data)) return false;
  if (!Number.isSafeInteger(data.v) || data.v < 1 || data.v > SCHEMA_VERSION) return false;
  return Object.keys(data).every((key) => ALLOWED.has(key));
}

export function startServer(options = {}) {
  const opts = { ...DEFAULTS, ...options, limits: { ...DEFAULTS.limits, ...options.limits } };
  if (opts.dbPath !== ':memory:') mkdirSync(dirname(opts.dbPath), { recursive: true });
  const db = new DatabaseSync(opts.dbPath);
  db.exec(`PRAGMA journal_mode = WAL; PRAGMA busy_timeout = 3000;
    CREATE TABLE IF NOT EXISTS saves (
      key TEXT PRIMARY KEY, salt BLOB NOT NULL, hash BLOB NOT NULL,
      data TEXT NOT NULL, rev INTEGER NOT NULL, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL
    ) STRICT;
    -- Acessos: só chave e datas. Nada de IP, User-Agent ou dado pessoal. Apagados junto com a chave (DELETE).
    CREATE TABLE IF NOT EXISTS acessos (
      key TEXT PRIMARY KEY, primeiro INTEGER NOT NULL, ultimo INTEGER NOT NULL, contado INTEGER NOT NULL, total INTEGER NOT NULL
    ) STRICT;
    CREATE TABLE IF NOT EXISTS dias_ativos (
      key TEXT NOT NULL, dia TEXT NOT NULL, PRIMARY KEY (key, dia)
    ) STRICT, WITHOUT ROWID;
    CREATE INDEX IF NOT EXISTS dias_ativos_dia ON dias_ativos (dia);`);
  const dayOf = (ms) => new Date(ms + opts.tzMin * 60e3).toISOString().slice(0, 10);
  const q = {
    get: db.prepare('SELECT salt, hash, data, rev, updated_at FROM saves WHERE key = ?'),
    count: db.prepare('SELECT COUNT(*) AS n FROM saves'),
    insert: db.prepare('INSERT INTO saves (key, salt, hash, data, rev, created_at, updated_at) VALUES (?, ?, ?, ?, 1, ?, ?)'),
    // Concorrência otimista também no SQL: só grava se a rev ainda é a que o cliente viu.
    update: db.prepare('UPDATE saves SET data = ?, rev = rev + 1, updated_at = ? WHERE key = ? AND rev = ?'),
    rotate: db.prepare('UPDATE saves SET salt = ?, hash = ? WHERE key = ?'),
    remove: db.prepare('DELETE FROM saves WHERE key = ?'),
    removeAccess: db.prepare('DELETE FROM acessos WHERE key = ?'),
    removeDays: db.prepare('DELETE FROM dias_ativos WHERE key = ?'),
    seen: db.prepare(`INSERT INTO acessos (key, primeiro, ultimo, contado, total) VALUES (?1, ?2, ?2, ?2, 1)
      ON CONFLICT (key) DO UPDATE SET ultimo = ?2,
        total = total + (?2 - contado >= ?3), contado = CASE WHEN ?2 - contado >= ?3 THEN ?2 ELSE contado END`),
    day: db.prepare('INSERT OR IGNORE INTO dias_ativos (key, dia) VALUES (?, ?)'),
  };
  /** Registra um acesso autenticado com sucesso (GET/PUT). */
  const touch = (key) => { const now = opts.now(); q.seen.run(key, now, opts.accessGapMs); q.day.run(key, dayOf(now)); };
  const limit = { ip: limiter(opts.limits.ip), key: limiter(opts.limits.key), claim: limiter(opts.limits.claim) };

  const bearer = (req) => {
    const match = /^Bearer ([A-Za-z0-9_-]{22,128})$/.exec(req.headers.authorization || '');
    if (!match) throw new HttpError(401, 'Falta o segredo de sincronização.');
    return match[1];
  };
  // Comparação em tempo constante (digests de 32 bytes).
  const authorize = (row, req) => {
    if (!timingSafeEqual(hashOf(row.salt, bearer(req)), row.hash)) throw new HttpError(403, 'Segredo não confere para esta chave.');
  };
  const rowOf = (key) => {
    const row = q.get.get(key);
    if (!row) throw new HttpError(404, 'Chave ainda não sincronizada.');
    return row;
  };
  const clientIp = (req) => {
    const real = opts.trustProxy && req.headers['x-real-ip'];
    return typeof real === 'string' && real.length <= 64 ? real : req.socket.remoteAddress || '?';
  };
  const wait = (seconds) => { if (seconds) throw new HttpError(429, 'Muitos pedidos. Tente de novo em instantes.', { retryAfter: seconds }); };

  async function handle(req, res) {
    const { pathname } = new URL(req.url, 'http://x');
    if (pathname === '/api/health') {
      if (req.method !== 'GET' && req.method !== 'HEAD') throw new HttpError(405, 'Método não permitido.');
      db.prepare('SELECT 1').get();
      return [200, { ok: true }];
    }
    const match = /^\/api\/sync\/([^/]+)(\/rotate)?$/.exec(pathname);
    if (!match) throw new HttpError(404, 'Não encontrado.');
    wait(limit.ip.take(clientIp(req)));
    const key = decodeURIComponent(match[1]);
    if (!KEY.test(key)) throw new HttpError(400, 'Chave inválida: 6 letras maiúsculas ou números.');
    wait(limit.key.take(key));
    const rotate = Boolean(match[2]);
    const route = `${req.method}${rotate ? ' rotate' : ''}`;
    if ((route === 'PUT' || route === 'POST rotate') && !/^application\/json\b/i.test(req.headers['content-type'] || '')) throw new HttpError(415, 'Envie application/json.');

    if (route === 'GET') {
      const row = rowOf(key);
      authorize(row, req);
      touch(key);
      return [200, { data: JSON.parse(row.data), rev: row.rev, updatedAt: row.updated_at }];
    }
    if (route === 'PUT') {
      const secret = bearer(req);
      const body = await readBody(req, opts.maxBytes);
      if (!body || typeof body !== 'object' || !Number.isSafeInteger(body.baseRev) || !validData(body.data)) throw new HttpError(400, 'Corpo esperado: { data: { v, ...seções }, baseRev }.');
      const text = JSON.stringify(body.data);
      const now = opts.now();
      const row = q.get.get(key);
      if (!row) {
        // Chave livre: o primeiro PUT (baseRev 0) reivindica guardando só o hash do segredo.
        if (body.baseRev !== 0) throw new HttpError(409, 'Chave sem progresso no servidor: envie baseRev 0.', { rev: 0 });
        wait(limit.claim.take(clientIp(req)));
        if (q.count.get().n >= opts.maxKeys) throw new HttpError(503, 'Servidor cheio: sincronização indisponível para chaves novas.');
        const salt = randomBytes(16);
        try { q.insert.run(key, salt, hashOf(salt, secret), text, now, now); } catch { throw new HttpError(409, 'A chave acabou de ser reivindicada por outro aparelho.', { rev: 1 }); }
        touch(key);
        return [201, { rev: 1, updatedAt: now }];
      }
      authorize(row, req);
      touch(key);
      if (body.baseRev !== row.rev || q.update.run(text, now, key, body.baseRev).changes !== 1) {
        // Mudou desde a última leitura: devolve o atual para o cliente juntar (mergeProgress) e reenviar.
        const fresh = q.get.get(key);
        throw new HttpError(409, 'O progresso mudou em outro aparelho.', { data: JSON.parse(fresh.data), rev: fresh.rev, updatedAt: fresh.updated_at });
      }
      return [200, { rev: row.rev + 1, updatedAt: now }];
    }
    if (route === 'POST rotate') {
      const row = rowOf(key);
      authorize(row, req);
      const body = await readBody(req, 1024);
      if (!SECRET.test(body?.secret || '')) throw new HttpError(400, 'Segredo novo inválido (base64url, 22 a 128 caracteres).');
      const salt = randomBytes(16);
      q.rotate.run(salt, hashOf(salt, body.secret), key);
      return [204, null];
    }
    if (route === 'DELETE') {
      const row = rowOf(key);
      authorize(row, req);
      q.remove.run(key);
      q.removeAccess.run(key); // o "apagar do servidor" leva também os registros de acesso
      q.removeDays.run(key);
      return [204, null];
    }
    throw new HttpError(405, 'Método não permitido.');
  }

  const server = createServer(async (req, res) => {
    const started = Date.now();
    let status = 500;
    let payload = { error: 'Erro interno.' };
    const headers = { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff' };
    try {
      [status, payload] = await handle(req, res);
    } catch (error) {
      if (error instanceof HttpError) {
        status = error.status;
        const { retryAfter, ...extra } = error.extra;
        if (retryAfter) headers['Retry-After'] = String(retryAfter);
        payload = { error: error.message, ...extra };
      } else opts.log(`erro: ${error?.message}`); // nunca o corpo nem cabeçalhos
    }
    if (status === 204) delete headers['Content-Type'];
    if (status === 413) headers.Connection = 'close';
    if (status === 405) headers.Allow = 'GET, PUT, POST, DELETE';
    res.writeHead(status, headers);
    res.end(status === 204 || req.method === 'HEAD' ? undefined : JSON.stringify(payload));
    // Log sem segredo nem corpo; a chave sai mascarada (só as 2 primeiras letras).
    opts.log(`${new Date().toISOString()} ${req.method} ${req.url.replace(/(\/api\/sync\/)([^/?]{0,2})[^/?]*/, '$1$2****').slice(0, 80)} ${status} ${Date.now() - started}ms`);
  });
  // ---- Estatísticas de acesso: listener separado, nunca atrás do nginx. Só GET, Bearer ADMIN_TOKEN em tempo constante.
  const adminOn = typeof opts.adminToken === 'string' && opts.adminToken.length >= 32;
  const tokenDigest = adminOn ? createHash('sha256').update(opts.adminToken).digest() : null;
  const row2user = (r, today) => ({
    key: r.key, primeiroAcesso: r.primeiro, ultimoAcesso: r.ultimo, acessos: r.total ?? 0, diasAtivos: r.dias, criadaEm: r.created_at, atualizadaEm: r.updated_at,
    bytes: r.bytes, rev: r.rev, progresso: progressSummary(JSON.parse(r.data), today),
  });
  const USER_SQL = `SELECT s.key, s.rev, s.data, s.created_at, s.updated_at, length(s.data) AS bytes, a.primeiro, a.ultimo, a.total,
      (SELECT COUNT(*) FROM dias_ativos d WHERE d.key = s.key) AS dias
    FROM saves s LEFT JOIN acessos a ON a.key = s.key`;
  function adminHandle(req) {
    const url = new URL(req.url, 'http://x');
    const bearerToken = /^Bearer (.+)$/.exec(req.headers.authorization || '')?.[1];
    if (!bearerToken) throw new HttpError(401, 'Falta o token de administração.');
    if (!timingSafeEqual(createHash('sha256').update(bearerToken).digest(), tokenDigest)) throw new HttpError(403, 'Token inválido.');
    if (req.method !== 'GET') throw new HttpError(405, 'Só GET.');
    const now = opts.now();
    const today = dayOf(now);
    const since = (days) => dayOf(now - (days - 1) * DAY_MS);
    const path = url.pathname;
    if (path === '/admin/resumo') {
      const active = (days) => db.prepare('SELECT COUNT(DISTINCT key) AS n FROM dias_ativos WHERE dia >= ?').get(since(days)).n;
      const perDay = new Map(db.prepare('SELECT dia, COUNT(*) AS n FROM dias_ativos WHERE dia >= ? GROUP BY dia').all(since(60)).map((r) => [r.dia, r.n]));
      const created = new Map(db.prepare("SELECT strftime('%Y-%m-%d', (created_at / 1000) + ?, 'unixepoch') AS dia, COUNT(*) AS n FROM saves GROUP BY dia").all(opts.tzMin * 60).map((r) => [r.dia, r.n]));
      const days = Array.from({ length: 60 }, (_, i) => dayOf(now - (59 - i) * DAY_MS));
      return {
        hoje: today, totalChaves: q.count.get().n, ativosHoje: active(1), ativos7d: active(7), ativos30d: active(30),
        ativosPorDia: days.map((dia) => ({ dia, ativos: perDay.get(dia) || 0 })), novasPorDia: days.map((dia) => ({ dia, novas: created.get(dia) || 0 })),
      };
    }
    if (path === '/admin/usuarios') {
      const get = (name) => url.searchParams.get(name);
      const order = Object.hasOwn(ORDERS, get('ordem') ?? 'ultimo') ? (get('ordem') ?? 'ultimo') : null;
      const limit = Number(get('limite') ?? 25), page = Number(get('pagina') ?? 1);
      if (!order || !Number.isInteger(limit) || limit < 1 || limit > 100 || !Number.isInteger(page) || page < 1) throw new HttpError(400, 'Parâmetros inválidos (ordem, limite 1..100, pagina >= 1).');
      const dir = get('dir') === 'asc' ? 'ASC' : 'DESC';
      const search = (get('busca') ?? '').toUpperCase().replace(/[^A-Z0-9]/g, '').slice(0, 6);
      const where = search ? "WHERE s.key LIKE ?" : ''; // busca já limitada a A-Z0-9
      const args = search ? [`%${search}%`] : [];
      const total = db.prepare(`SELECT COUNT(*) AS n FROM saves s ${where}`).get(...args).n;
      const rows = db.prepare(`${USER_SQL} ${where} ORDER BY ${ORDERS[order]} ${dir}, s.key LIMIT ? OFFSET ?`).all(...args, limit, (page - 1) * limit);
      return { total, pagina: page, limite: limit, ordem: order, dir: dir.toLowerCase(), usuarios: rows.map((r) => row2user(r, today)) };
    }
    const one = /^\/admin\/usuario\/([^/]+)$/.exec(path);
    if (one) {
      const key = decodeURIComponent(one[1]);
      if (!KEY.test(key)) throw new HttpError(400, 'Chave inválida.');
      const r = db.prepare(`${USER_SQL} WHERE s.key = ?`).get(key);
      if (!r) throw new HttpError(404, 'Chave não encontrada.');
      return { ...row2user(r, today), dias: db.prepare('SELECT dia FROM dias_ativos WHERE key = ? ORDER BY dia DESC').all(key).map((d) => d.dia) };
    }
    throw new HttpError(404, 'Não encontrado.');
  }
  const adminServer = adminOn ? createServer((req, res) => {
    let status = 200, payload;
    try { payload = adminHandle(req); } catch (error) {
      status = error instanceof HttpError ? error.status : 500;
      payload = { error: error instanceof HttpError ? error.message : 'Erro interno.' };
      if (status === 500) opts.log(`erro admin: ${error?.message}`);
    }
    res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff', ...(status === 405 ? { Allow: 'GET' } : {}) });
    res.end(JSON.stringify(payload));
  }) : null;
  if (adminServer) { adminServer.requestTimeout = 15e3; adminServer.headersTimeout = 10e3; }

  server.requestTimeout = 15e3;
  server.headersTimeout = 10e3;

  /** Cópia diária do banco (VACUUM INTO) com rotação: guarda os `backupKeep` mais novos. */
  function backup(now = new Date()) {
    if (!opts.backupDir) return null;
    mkdirSync(opts.backupDir, { recursive: true });
    const file = join(opts.backupDir, `sync-${now.toISOString().slice(0, 10)}.db`);
    if (!existsSync(file)) db.prepare('VACUUM INTO ?').run(file);
    const old = readdirSync(opts.backupDir).filter((name) => /^sync-\d{4}-\d{2}-\d{2}\.db$/.test(name)).sort().reverse().slice(opts.backupKeep);
    for (const name of old) rmSync(join(opts.backupDir, name));
    return file;
  }
  const timers = [
    setInterval(() => { for (const item of Object.values(limit)) item.sweep(); }, 60e3),
    setInterval(() => { try { backup(); } catch (error) { opts.log(`backup falhou: ${error.message}`); } }, 3600e3),
  ];
  for (const timer of timers) timer.unref();
  try { backup(); } catch (error) { opts.log(`backup falhou: ${error.message}`); }

  const ready = new Promise((done) => server.listen(opts.port, opts.host, () => done(server.address().port)));
  // ponytail: sem limite de tentativas no token; com >= 32 caracteres aleatórios e porta só em loopback, não vale o código.
  const adminReady = adminServer ? new Promise((done) => adminServer.listen(opts.adminPort, opts.adminHost, () => done(adminServer.address().port))) : Promise.resolve(null);
  const close = () => new Promise((done) => {
    timers.forEach(clearInterval);
    adminServer?.close(); adminServer?.closeAllConnections();
    server.close(() => { db.close(); done(); }); server.closeAllConnections();
  });
  return { server, ready, adminReady, close, backup, db };
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const env = process.env;
  const { ready, adminReady, close } = startServer({
    host: env.SYNC_HOST || DEFAULTS.host,
    port: Number(env.SYNC_PORT) || DEFAULTS.port,
    dbPath: env.SYNC_DB || DEFAULTS.dbPath,
    backupDir: env.SYNC_BACKUP_DIR || null,
    trustProxy: env.SYNC_TRUST_PROXY === '1',
    adminToken: env.ADMIN_TOKEN || '',
    adminPort: Number(env.ADMIN_PORT) || DEFAULTS.adminPort,
    adminHost: env.ADMIN_HOST || DEFAULTS.adminHost,
  });
  ready.then((port) => console.log(`Sincronização do RushDaily em http://${env.SYNC_HOST || DEFAULTS.host}:${port}/api/health`));
  adminReady.then((port) => console.log(port ? `Estatísticas de acesso em ${env.ADMIN_HOST || DEFAULTS.adminHost}:${port} (Bearer ADMIN_TOKEN)` : 'Estatísticas desligadas (defina ADMIN_TOKEN com 32+ caracteres para ligar).'));
  for (const signal of ['SIGINT', 'SIGTERM']) process.on(signal, () => close().then(() => process.exit(0)));
}
