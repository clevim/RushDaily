#!/usr/bin/env node
// Admin local do RushDaily: acompanha o cache/dados e dispara tarefas de uma lista fechada.
// Sem dependências. Escuta SÓ em 127.0.0.1; toda a API exige o token impresso ao subir. Veja LEIA-ME.md.
//   npm run admin            (porta padrão 4190; mude com ADMIN_PORT=4200 ou --porta 4200)
import { spawn, spawnSync } from 'node:child_process';
import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import { createServer } from 'node:http';
import { existsSync, mkdirSync, readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const p = (...x) => join(ROOT, ...x);
const PUBLIC = join(dirname(fileURLToPath(import.meta.url)), 'public');
const DADOS = p('tools/setup/cache/admin'); // já ignorado pelo git (tools/**/cache)
mkdirSync(DADOS, { recursive: true });

// ---- bind e porta: somente loopback ----
const arg = (nome) => { const i = process.argv.indexOf(nome); return i > 0 ? process.argv[i + 1] : undefined; };
const HOST = arg('--host') ?? process.env.ADMIN_HOST ?? '127.0.0.1';
if (HOST !== '127.0.0.1') { console.error(`RECUSADO: o admin só escuta em 127.0.0.1 (pedido: ${HOST}). Para o celular, use túnel SSH (veja LEIA-ME.md).`); process.exit(1); }
const PORTA = Number(arg('--porta') ?? process.env.ADMIN_PORT ?? 4190);
if (!Number.isInteger(PORTA) || PORTA < 1024 || PORTA > 65535) { console.error('Porta inválida (1024 a 65535).'); process.exit(1); }
const TOKEN = randomBytes(24).toString('base64url');
const hash = (s) => createHash('sha256').update(String(s)).digest();
const tokenOk = (t) => typeof t === 'string' && timingSafeEqual(hash(t), hash(TOKEN)); // tempo constante

// ---- etapas do setup (a lista vem do próprio setup.mjs) ----
const lista = spawnSync('node', [p('tools/setup/setup.mjs'), '--lista'], { encoding: 'utf8' });
const ETAPAS = (lista.stdout || '').split('\n').filter(Boolean).map((l) => ({ nome: l.split(/\s+/)[0], desc: l.replace(/^\S+\s+/, '') }));
if (!ETAPAS.length) { console.error('Não consegui ler `setup.mjs --lista`.'); process.exit(1); }
const NOMES = ETAPAS.map((e) => e.nome);
const NUM_TEMPORADAS = 5;

// ---- tarefas (lista fechada; comando e argumentos em array, sem shell) ----
const inteiro = (v, nome, min, max, padrao) => {
  const n = v === undefined || v === '' ? padrao : Number(v);
  if (!Number.isInteger(n) || n < min || n > max) throw new Error(`${nome}: inteiro de ${min} a ${max}`);
  return n;
};
const ids = (v) => {
  const lst = String(v ?? '').split(/[\s,]+/).filter(Boolean);
  if (lst.length > 100 || lst.some((x) => !/^\d{1,10}$/.test(x))) throw new Error('ids: até 100 números separados por vírgula/espaço');
  return lst;
};
const etapa = (v) => { if (!NOMES.includes(v)) throw new Error(`etapa: use uma de ${NOMES.join(', ')}`); return v; };
const CLASSICO = ['fetch', 'decks', 'build', 'art', 'puzzles'];
const IMP = (...r) => ({ cmd: 'python3', args: ['-I', 'tools/classic/import_cards.py', ...r] });
const cfgArquivo = () => { try { return JSON.parse(readFileSync(join(DADOS, 'config.json'), 'utf8')); } catch { return {}; } };
const config = () => { const c = cfgArquivo(); return { nos: Number(c.nos) || 10000, meta: Number(c.meta) || 35 }; }; // só o que pode ir ao navegador (o token do sync fica de fora)
// Estatísticas de acesso: o servidor de sync (listener ADMIN_TOKEN) é consultado AQUI; o token nunca vai ao navegador.
const syncAdmin = () => { const c = cfgArquivo(); return { url: (process.env.SYNC_ADMIN_URL || c.syncAdminUrl || 'http://127.0.0.1:4192').replace(/\/+$/, ''), token: process.env.SYNC_ADMIN_TOKEN || c.syncAdminToken || '' }; };

const TAREFAS = {
  setup: { titulo: 'Setup completo', desc: 'npm run setup: baixa/gera tudo que ainda falta (pula o que já existe).', params: ['temporadas', 'semRender'],
    montar: (q) => ({ cmd: 'node', args: ['tools/setup/setup.mjs', '--temporadas', String(inteiro(q.temporadas, 'temporadas', 1, NUM_TEMPORADAS, 1)), ...(q.semRender ? ['--sem-render'] : [])] }) },
  'setup-etapa': { titulo: 'Setup de uma etapa', desc: 'setup --so <etapa>; com "refazer", usa --force só nessa etapa.', params: ['etapa', 'force', 'temporadas'],
    montar: (q) => ({ cmd: 'node', args: ['tools/setup/setup.mjs', '--so', etapa(q.etapa), '--temporadas', String(inteiro(q.temporadas, 'temporadas', 1, NUM_TEMPORADAS, 1)), ...(q.force ? ['--force'] : [])] }) },
  classico: { titulo: 'Importar clássico', desc: 'import_cards.py: fetch (baixa APIs), decks, build (gera temporadas), art (artes), puzzles.', params: ['comando', 'ate'],
    montar: (q) => {
      if (!CLASSICO.includes(q.comando)) throw new Error(`comando: ${CLASSICO.join(', ')}`);
      return IMP(q.comando, ...(q.comando === 'build' ? ['--ate', String(inteiro(q.ate, 'ate', 1, NUM_TEMPORADAS, 1))] : []));
    } },
  'puzzles-buscar': { titulo: 'Buscar puzzles (busca de soluções)', desc: 'puzzles --buscar com teto de nós e meta; usa a configuração salva se vazio. Pesado.', params: ['nos', 'meta'],
    montar: (q) => IMP('puzzles', '--buscar', '--nos', String(inteiro(q.nos, 'nos', 100, 1000000, config().nos)), '--meta', String(inteiro(q.meta, 'meta', 1, 200, config().meta))) },
  'render-classico': { titulo: 'Render das clássicas', desc: 'render.mjs: desenha as cartas clássicas (todas as que faltam, ou só os ids dados).', params: ['force', 'ids'],
    montar: (q) => ({ cmd: 'node', args: ['tools/classic/render/render.mjs', ...(q.force ? ['--force'] : []), ...ids(q.ids)] }) },
  'render-rush': { titulo: 'Render das Rush', desc: 'render.py: desenha as cartas Rush em PT-BR (todas que faltam, ou só os ids).', params: ['force', 'ids'],
    montar: (q) => ({ cmd: 'python3', args: ['tools/card-render/render.py', ...(q.force ? ['--force'] : []), ...ids(q.ids)] }) },
  teste: { titulo: 'Testes', desc: 'npm test', params: [], montar: () => ({ cmd: 'npm', args: ['test'] }) },
  simulacao: { titulo: 'Simulação de duelos', desc: 'simulate.mjs N T: duelos aleatórios para achar erros de script.', params: ['duelos', 'temporada'],
    montar: (q) => ({ cmd: 'node', args: ['tools/classic/simulate.mjs', String(inteiro(q.duelos, 'duelos', 1, 5000, 100)), String(inteiro(q.temporada, 'temporada', 1, NUM_TEMPORADAS, 1))] }) },
};

// ---- fila e execução ----
const HIST = join(DADOS, 'historico.json');
let historico = [];
try { historico = JSON.parse(readFileSync(HIST, 'utf8')); } catch { /* primeira vez */ }
const gravaHist = () => writeFileSync(HIST, JSON.stringify(historico.slice(0, 30)));
let seq = Date.now();
let atual = null; // { id, tarefa, titulo, linha, inicio, filho, log[], progresso, cancelada }
const fila = [];
const clientes = new Set();
const enviar = (obj) => { const s = `data: ${JSON.stringify(obj)}\n\n`; for (const r of clientes) r.write(s); };
const resumo = (j) => ({ id: j.id, tarefa: j.tarefa, titulo: j.titulo, linha: j.linha, inicio: j.inicio, progresso: j.progresso });
const estado = () => ({ tipo: 'estado', atual: atual && resumo(atual), fila: fila.map(resumo), historico: historico.slice(0, 30).map(({ log, ...h }) => h) });

function iniciar() {
  if (atual || !fila.length) return;
  const j = fila.shift();
  const { cmd, args } = j.cmd;
  atual = { ...j, inicio: Date.now(), log: [], progresso: null, cancelada: false, rushTotal: 0, rushFeitas: 0 };
  const filho = spawn(cmd, args, { cwd: ROOT, detached: true, stdio: ['ignore', 'pipe', 'pipe'], env: { ...process.env, PYTHONUNBUFFERED: '1', NO_COLOR: '1' } });
  atual.filho = filho;
  const linha = (texto) => {
    const a = atual; if (!a) return;
    a.log.push(texto); if (a.log.length > 4000) a.log.splice(0, 1000); // ponytail: só as últimas ~4000 linhas ficam na memória
    let m;
    if ((m = texto.match(/(\d+)\s*\/\s*(\d+)/)) && +m[2] > 0 && +m[1] <= +m[2]) a.progresso = { n: +m[1], m: +m[2] };
    else if ((m = texto.match(/^(\d+) cartas para renderizar/))) { a.rushTotal = +m[1]; a.progresso = { n: 0, m: a.rushTotal }; }
    else if (a.rushTotal && /^(ok|scan) \d+/.test(texto)) a.progresso = { n: ++a.rushFeitas, m: a.rushTotal };
    enviar({ tipo: 'linha', texto, progresso: a.progresso });
  };
  linha(`$ ${[cmd, ...args].join(' ')}`);
  for (const fluxo of [filho.stdout, filho.stderr]) {
    let resto = '';
    fluxo.setEncoding('utf8');
    fluxo.on('data', (d) => { const partes = (resto + d).split(/\r?\n|\r/); resto = partes.pop(); partes.forEach((l) => l && linha(l)); });
    fluxo.on('end', () => resto && linha(resto));
  }
  const fim = (codigo, sinal) => {
    if (!atual || atual.filho !== filho) return;
    const a = atual; atual = null;
    historico.unshift({ id: a.id, tarefa: a.tarefa, titulo: a.titulo, linha: a.linha, inicio: a.inicio, duracaoMs: Date.now() - a.inicio, codigo, sinal, cancelada: a.cancelada, log: a.log.slice(-80) });
    gravaHist();
    enviar({ tipo: 'fim', id: a.id, codigo, cancelada: a.cancelada });
    enviar(estado());
    iniciar();
  };
  filho.on('error', (e) => { linha(`ERRO ao iniciar: ${e.message}`); fim(-1, null); });
  filho.on('close', fim);
  enviar(estado());
}
function matar(filho) {
  try { process.kill(-filho.pid, 'SIGTERM'); } catch { /* já morreu */ }
  setTimeout(() => { try { process.kill(-filho.pid, 'SIGKILL'); } catch { /* ok */ } }, 3000).unref();
}

// ---- status (somente leitura) ----
const arquivos = (dir, re) => { try { return readdirSync(dir).filter((n) => re.test(n)).length; } catch { return 0; } };
const mtime = (...x) => { try { return statSync(p(...x)).mtimeMs; } catch { return 0; } };
function tamanho(dir) { // bytes de uma árvore (sem seguir links)
  let t = 0;
  const anda = (d) => { let es; try { es = readdirSync(d, { withFileTypes: true }); } catch { return; } for (const e of es) { const f = join(d, e.name); if (e.isDirectory()) anda(f); else if (e.isFile()) { try { t += statSync(f).size; } catch { /* some */ } } } };
  try { if (statSync(dir).isFile()) return statSync(dir).size; } catch { return 0; }
  anda(dir); return t;
}
const jsonDe = (...x) => { try { return JSON.parse(readFileSync(p(...x), 'utf8')); } catch { return null; } };
const temporadas = () => jsonDe('src/data/classic/seasons.json') ?? [];
async function poolRush() { try { return (await import(`${pathToFileURL(p('src/data/cards.mjs')).href}?t=${Date.now()}`)).CARD_POOL.length; } catch { return 0; } }

let cacheStatus = { t: 0, v: null };
async function status() {
  if (cacheStatus.v && Date.now() - cacheStatus.t < 4000) return cacheStatus.v;
  const ex = (x) => existsSync(p(x));
  const ts = temporadas().filter((s) => s.enabled);
  const totalClassicas = ts.reduce((a, s) => a + s.count, 0);
  const artes = arquivos(p('src/assets/classic-art'), /\.webp$/);
  const cartasCl = arquivos(p('src/assets/classic-cards'), /\.webp$/);
  const puzzles = (jsonDe('src/data/classic/puzzles.json') ?? []).length;
  const luas = arquivos(p('src/vendor/card-scripts/official'), /^c\d+\.lua$/);
  const rushTotal = await poolRush();
  const rushImg = arquivos(p('src/assets/cards'), /^\d+\.webp$/);
  const rushSm = arquivos(p('src/assets/cards-sm'), /\.webp$/);
  const clSm = arquivos(p('src/assets/classic-cards-sm'), /\.webp$/);
  const seasonsOk = ts.length > 0 && ts.every((s) => ex(`src/data/classic/s${s.season}.json`));
  const E = {
    three: { pronto: ex('src/vendor/three.module.js'), caminhos: ['src/vendor/three.module.js'] },
    qrcode: { pronto: ex('src/vendor/qrcode/qrcode.mjs') && ex('src/vendor/qrcode/LICENSE'), caminhos: ['src/vendor/qrcode'] },
    ocgcore: { pronto: ex('src/vendor/ocgcore/index.js') && ex('src/vendor/ocgcore/ocgcore.wasm') && ex('src/vendor/ocgcore/LICENSE.md'), caminhos: ['src/vendor/ocgcore'] },
    yugioh: { pronto: ex('src/vendor/yugioh-card/yugioh-card.js') && ex('src/vendor/yugioh-card/assets/yugioh/font/font-list.json'), caminhos: ['src/vendor/yugioh-card'] },
    rush: { pronto: ex('src/data/cards.mjs'), contagem: `${rushTotal} cartas Rush no pool`, caminhos: ['src/data/cards.mjs'] },
    'rush-render': { pronto: rushTotal > 0 && rushImg >= rushTotal, parcial: rushImg > 0, contagem: `${rushImg}/${rushTotal} cartas Rush desenhadas`, caminhos: ['src/assets/cards'] },
    classico: { pronto: seasonsOk && ex('src/data/classic/puzzles.json') && luas > 0 && artes >= totalClassicas && totalClassicas > 0, parcial: seasonsOk || artes > 0,
      contagem: `artes ${artes}/${totalClassicas} · puzzles validados ${puzzles} · scripts Lua ${luas} · temporadas ativas ${ts.length}`,
      caminhos: ['src/data/classic', 'src/assets/classic-art', 'src/vendor/card-scripts', 'tools/classic/cache'] },
    'classico-render': { pronto: cartasCl > 0 && cartasCl >= artes, parcial: cartasCl > 0, contagem: `${cartasCl} cartas pré-desenhadas (${artes} artes)`, caminhos: ['src/assets/classic-cards'] },
    miniaturas: { pronto: rushSm > 0 && rushSm >= rushImg && clSm >= cartasCl, parcial: rushSm > 0 || clSm > 0, contagem: `Rush ${rushSm}/${rushImg} · clássicas ${clSm}/${cartasCl}`, caminhos: ['src/assets/cards-sm', 'src/assets/classic-cards-sm'] },
    enigma: { pronto: ex('src/assets/puzzle/puzzle.bin') && ex('src/assets/puzzle/puzzle.json'), caminhos: ['src/assets/puzzle', 'tools/setup/cache/enigma'] },
    'vendor-avisos': { pronto: ex('src/vendor/CHECKSUMS.txt'), caminhos: ['src/vendor/CHECKSUMS.txt'] },
  };
  const etapas = ETAPAS.map((e) => {
    const d = E[e.nome] ?? { pronto: false, caminhos: [] };
    return { nome: e.nome, desc: e.desc, pronto: !!d.pronto, parcial: !d.pronto && !!d.parcial, contagem: d.contagem ?? '', bytes: d.caminhos.reduce((a, c) => a + tamanho(p(c)), 0), geradoEm: Math.max(0, ...d.caminhos.map((c) => mtime(c))) || null };
  });
  const caches = [];
  for (const d of readdirSync(p('tools'), { withFileTypes: true })) if (d.isDirectory() && existsSync(p('tools', d.name, 'cache'))) caches.push({ nome: `tools/${d.name}/cache`, bytes: tamanho(p('tools', d.name, 'cache')) });
  cacheStatus = { t: Date.now(), v: { tipo: 'status', etapas, caches, cacheTotal: caches.reduce((a, c) => a + c.bytes, 0) } };
  return cacheStatus.v;
}

// ---- HTTP ----
const json = (res, cod, obj) => { res.writeHead(cod, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' }); res.end(JSON.stringify(obj)); };
const lerCorpo = (req) => new Promise((ok, no) => { let b = ''; req.on('data', (d) => { b += d; if (b.length > 20000) { no(new Error('corpo grande')); req.destroy(); } }); req.on('end', () => { try { ok(b ? JSON.parse(b) : {}); } catch { no(new Error('JSON inválido')); } }); });
const hostOk = (h) => new RegExp(`^(127\\.0\\.0\\.1|localhost):${PORTA}$`).test(h ?? ''); // contra DNS rebinding
const originOk = (o) => !o || o === `http://127.0.0.1:${PORTA}` || o === `http://localhost:${PORTA}`;
const CSP = "default-src 'none'; script-src 'self' 'unsafe-inline'; style-src 'self' 'unsafe-inline'; connect-src 'self'; img-src 'self' data:; base-uri 'none'; form-action 'none'; frame-ancestors 'none'";

createServer(async (req, res) => {
  try {
    if (!hostOk(req.headers.host) || !originOk(req.headers.origin)) return json(res, 403, { erro: 'Host/Origin não permitido' });
    const url = new URL(req.url, `http://127.0.0.1:${PORTA}`);
    const rota = url.pathname;
    if (req.method === 'GET' && (rota === '/' || rota === '/index.html')) { // única coisa servida de arquivo: public/index.html
      res.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store', 'content-security-policy': CSP, 'x-content-type-options': 'nosniff', 'referrer-policy': 'no-referrer' });
      return res.end(readFileSync(join(PUBLIC, 'index.html')));
    }
    if (rota === '/favicon.ico') { res.writeHead(204); return res.end(); }
    if (!rota.startsWith('/api/')) return json(res, 404, { erro: 'não encontrado' });
    if (!tokenOk(req.headers['x-admin-token'])) return json(res, 401, { erro: 'token ausente ou inválido' });

    if (req.method === 'GET' && rota === '/api/tarefas') return json(res, 200, { etapas: ETAPAS, tarefas: Object.fromEntries(Object.entries(TAREFAS).map(([k, t]) => [k, { titulo: t.titulo, desc: t.desc, params: t.params }])) });
    if (req.method === 'GET' && rota === '/api/status') return json(res, 200, await status());
    if (req.method === 'GET' && rota === '/api/config') {
      const versao = readFileSync(p('src/ui/classic-render.js'), 'utf8').match(/CACHE_VERSION = (\d+)/)?.[1] ?? '?';
      return json(res, 200, { ...config(), temporadas: temporadas(), cacheVersion: Number(versao) || versao });
    }
    if (req.method === 'PUT' && rota === '/api/config') {
      const q = await lerCorpo(req);
      const nova = { nos: inteiro(q.nos, 'nos', 100, 1000000), meta: inteiro(q.meta, 'meta', 1, 200) };
      writeFileSync(join(DADOS, 'config.json'), JSON.stringify({ ...cfgArquivo(), ...nova }), { mode: 0o600 }); // preserva o resto (token do sync)
      return json(res, 200, nova);
    }
    if (req.method === 'GET' && rota.startsWith('/api/jogadores/')) { // proxy só-leitura para /admin/* do servidor de sync
      const { url: base, token } = syncAdmin();
      if (!token) return json(res, 200, { configurado: false });
      const m = /^\/api\/jogadores\/(resumo|usuarios|usuario\/[A-Z0-9]{6})$/.exec(rota);
      if (!m) return json(res, 404, { erro: 'não encontrado' });
      const qs = new URLSearchParams(); // só parâmetros conhecidos
      for (const k of ['ordem', 'dir', 'limite', 'pagina', 'busca']) if (url.searchParams.has(k)) qs.set(k, url.searchParams.get(k).slice(0, 20));
      try {
        const r = await fetch(`${base}/admin/${m[1]}${qs.size ? `?${qs}` : ''}`, { headers: { authorization: `Bearer ${token}` }, signal: AbortSignal.timeout(5000), redirect: 'error' });
        const corpo = await r.json().catch(() => ({}));
        return json(res, r.ok ? 200 : 502, r.ok ? { configurado: true, ...corpo } : { configurado: true, erro: r.status === 401 || r.status === 403 ? 'O servidor de sync recusou o token (SYNC_ADMIN_TOKEN).' : `O servidor de sync respondeu ${r.status}.` });
      } catch { return json(res, 502, { configurado: true, erro: `Não consegui falar com o servidor de sync em ${base}. O túnel SSH (-L 4192) está aberto?` }); }
    }
    if (req.method === 'GET' && rota === '/api/estado') return json(res, 200, estado());
    if (req.method === 'GET' && rota === '/api/historico') {
      const h = historico.find((x) => String(x.id) === url.searchParams.get('id'));
      return h ? json(res, 200, h) : json(res, 404, { erro: 'execução não encontrada' });
    }
    if (req.method === 'GET' && rota === '/api/eventos') { // SSE (o cliente usa fetch para poder mandar o cabeçalho do token)
      res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-store', connection: 'keep-alive' });
      res.write(`data: ${JSON.stringify(estado())}\n\ndata: ${JSON.stringify({ tipo: 'log', linhas: atual?.log.slice(-1500) ?? [], progresso: atual?.progresso ?? null })}\n\n`);
      clientes.add(res);
      const bat = setInterval(() => res.write(': ping\n\n'), 20000);
      req.on('close', () => { clearInterval(bat); clientes.delete(res); });
      return;
    }
    if (req.method === 'POST' && rota === '/api/executar') {
      const q = await lerCorpo(req);
      const t = Object.hasOwn(TAREFAS, q.tarefa) ? TAREFAS[q.tarefa] : null;
      if (!t) return json(res, 400, { erro: 'tarefa desconhecida' });
      let cmd;
      try { cmd = t.montar(q.params ?? {}); } catch (e) { return json(res, 400, { erro: e.message }); }
      if (fila.length >= 10) return json(res, 429, { erro: 'fila cheia (10)' });
      const job = { id: ++seq, tarefa: q.tarefa, titulo: t.titulo, cmd, linha: [cmd.cmd, ...cmd.args].join(' ') };
      fila.push(job);
      iniciar(); enviar(estado());
      return json(res, 202, { id: job.id });
    }
    if (req.method === 'POST' && rota === '/api/cancelar') {
      const q = await lerCorpo(req);
      if (atual && String(atual.id) === String(q.id)) { atual.cancelada = true; matar(atual.filho); return json(res, 200, { ok: true }); }
      const i = fila.findIndex((j) => String(j.id) === String(q.id));
      if (i < 0) return json(res, 404, { erro: 'não está em execução nem na fila' });
      fila.splice(i, 1); enviar(estado());
      return json(res, 200, { ok: true });
    }
    return json(res, 404, { erro: 'não encontrado' });
  } catch (e) { return json(res, 500, { erro: e.message }); }
}).listen(PORTA, '127.0.0.1', () => {
  console.log(`RushDaily admin (somente local). Abra:\n\n  http://127.0.0.1:${PORTA}/?t=${TOKEN}\n\nO token vale só até parar o servidor. Ctrl+C encerra (e cancela a tarefa em andamento).`);
}).on('error', (e) => { console.error(`Não consegui escutar em 127.0.0.1:${PORTA}: ${e.message}`); process.exit(1); });

const sair = () => { if (atual) matar(atual.filho); setTimeout(() => process.exit(0), 300); };
process.on('SIGINT', sair); process.on('SIGTERM', sair);
