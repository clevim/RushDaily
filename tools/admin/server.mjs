#!/usr/bin/env node
// Admin do RushDaily: acompanha o cache/dados, dispara tarefas de uma lista fechada, mostra cartas, o desafio do dia e os jogadores.
// Sem dependências. Toda a API exige o token. Veja LEIA-ME.md.
//   npm run admin            (porta padrão 4190; mude com ADMIN_PORT=4200 ou --porta 4200; escuta só em 127.0.0.1, token novo a cada início)
//   contêiner (tools/admin/Dockerfile): ADMIN_CONTAINER=1 escuta em 0.0.0.0 dentro do contêiner, com o token fixo ADMIN_PANEL_TOKEN do .env;
//   o compose publica a porta só em 127.0.0.1 do host.
import { spawn, spawnSync } from 'node:child_process';
import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import { createServer } from 'node:http';
import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const AQUI = dirname(fileURLToPath(import.meta.url));
const ROOT = join(AQUI, '..', '..');
const p = (...x) => join(ROOT, ...x);
const PUBLIC = join(AQUI, 'public');
const DADOS = p('tools/setup/cache/admin'); // já ignorado pelo git (tools/**/cache); no contêiner fica no volume de dados
mkdirSync(join(DADOS, 'logs'), { recursive: true });

// ---- bind, porta e token ----
const arg = (nome) => { const i = process.argv.indexOf(nome); return i > 0 ? process.argv[i + 1] : undefined; };
const CONTEINER = process.env.ADMIN_CONTAINER === '1';
const HOST = CONTEINER ? '0.0.0.0' : arg('--host') ?? process.env.ADMIN_HOST ?? '127.0.0.1';
if (HOST !== '127.0.0.1' && !CONTEINER) { console.error(`RECUSADO: o admin só escuta em 127.0.0.1 (pedido: ${HOST}). Para o celular, use túnel SSH (veja LEIA-ME.md).`); process.exit(1); }
const porta = (v) => { const n = Number(v); if (!Number.isInteger(n) || n < 1024 || n > 65535) { console.error('Porta inválida (1024 a 65535).'); process.exit(1); } return n; };
const PORTA = porta(arg('--porta') ?? process.env.ADMIN_PORT ?? 4190);
const PORTA_PUBLICA = porta(process.env.ADMIN_PUBLIC_PORT ?? PORTA); // porta do host (127.0.0.1:4190 pelo túnel SSH)
let TOKEN = randomBytes(24).toString('base64url');
if (CONTEINER) {
  TOKEN = process.env.ADMIN_PANEL_TOKEN ?? '';
  if (TOKEN.length < 32 || !/^[\x21-\x7e]+$/.test(TOKEN)) { console.error('RECUSADO: no contêiner o admin exige ADMIN_PANEL_TOKEN (32+ caracteres, sem espaços) no .env. Gere com: openssl rand -hex 32'); process.exit(1); }
}
const hash = (s) => createHash('sha256').update(String(s)).digest();
const tokenOk = (t) => typeof t === 'string' && timingSafeEqual(hash(t), hash(TOKEN)); // tempo constante

// ---- etapas do setup (a lista vem do próprio setup.mjs) ----
const temSetup = existsSync(p('tools/setup/setup.mjs'));
const lista = temSetup ? spawnSync('node', [p('tools/setup/setup.mjs'), '--lista'], { encoding: 'utf8' }) : { stdout: '' };
const ETAPAS = (lista.stdout || '').split('\n').filter(Boolean).map((l) => ({ nome: l.split(/\s+/)[0], desc: l.replace(/^\S+\s+/, '') }));
if (temSetup && !ETAPAS.length) console.error('Aviso: não consegui ler `setup.mjs --lista`; a lista de etapas fica vazia.');
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
const etapa = (v) => { if (!NOMES.includes(v)) throw new Error(`etapa: use uma de ${NOMES.join(', ') || '(nenhuma: setup ausente)'}`); return v; };
const CLASSICO = ['fetch', 'decks', 'build', 'art', 'puzzles'];
const RUSH = ['fetch', 'build'];
const MODOS_SIM_RUSH = ['todos', 'ia', 'aleatorio', 'diario', 'niveis'];
const IMP = (...r) => ({ cmd: 'python3', args: ['-I', 'tools/classic/import_cards.py', ...r] });
const cfgArquivo = () => { try { return JSON.parse(readFileSync(join(DADOS, 'config.json'), 'utf8')); } catch { return {}; } };
const config = () => { const c = cfgArquivo(); return { nos: Number(c.nos) || 10000, meta: Number(c.meta) || 35 }; }; // só o que pode ir ao navegador (o token do sync fica de fora)
// Estatísticas de acesso: o servidor de sync (listener ADMIN_TOKEN) é consultado AQUI; o token nunca vai ao navegador.
const syncAdmin = () => { const c = cfgArquivo(); return { url: (process.env.SYNC_ADMIN_URL || c.syncAdminUrl || 'http://127.0.0.1:4192').replace(/\/+$/, ''), token: process.env.SYNC_ADMIN_TOKEN || c.syncAdminToken || '' }; };

// requer: arquivos que a tarefa usa (relativos à raiz); py: precisa do python3. Sem eles a tarefa aparece desabilitada, com o motivo.
const TAREFAS = {
  setup: { titulo: 'Setup completo', grupo: 'Setup', desc: 'npm run setup: baixa/gera tudo que ainda falta (pula o que já existe).', params: ['temporadas', 'semRender'], requer: ['tools/setup/setup.mjs'],
    montar: (q) => ({ cmd: 'node', args: ['tools/setup/setup.mjs', '--temporadas', String(inteiro(q.temporadas, 'temporadas', 1, NUM_TEMPORADAS, 1)), ...(q.semRender ? ['--sem-render'] : [])] }) },
  'setup-etapa': { titulo: 'Setup de uma etapa', grupo: 'Setup', desc: 'setup --so <etapa>; com "refazer", usa --force só nessa etapa.', params: ['etapa', 'force', 'temporadas'], requer: ['tools/setup/setup.mjs'],
    montar: (q) => ({ cmd: 'node', args: ['tools/setup/setup.mjs', '--so', etapa(q.etapa), '--temporadas', String(inteiro(q.temporadas, 'temporadas', 1, NUM_TEMPORADAS, 1)), ...(q.force ? ['--force'] : [])] }) },
  classico: { titulo: 'Importar clássico', grupo: 'Clássico', desc: 'import_cards.py: fetch (baixa APIs), decks, build (gera temporadas), art (artes), puzzles.', params: ['comando', 'ate'], requer: ['tools/classic/import_cards.py'], py: true,
    montar: (q) => {
      if (!CLASSICO.includes(q.comando)) throw new Error(`comando: ${CLASSICO.join(', ')}`);
      return IMP(q.comando, ...(q.comando === 'build' ? ['--ate', String(inteiro(q.ate, 'ate', 1, NUM_TEMPORADAS, 1))] : []));
    } },
  'artes-hd': { titulo: 'Artes clássicas em alta resolução', grupo: 'Clássico', desc: 'import_cards.py art: baixa a arte nativa (até 640px). Com "refazer" troca as antigas de 320px; ids opcionais; limite opcional (0 = sem limite). Lento: ~2 pedidos/s.', params: ['ids', 'refazerArte', 'limiteArtes'], requer: ['tools/classic/import_cards.py'], py: true,
    montar: (q) => {
      const lista = ids(q.ids), limite = inteiro(q.limiteArtes, 'limite', 0, 5000, 0);
      return IMP('art', ...(lista.length ? ['--ids', lista.join(',')] : []), ...(limite ? ['--limite', String(limite)] : []), ...(q.refazerArte ? ['--hd'] : []));
    } },
  'puzzles-buscar': { titulo: 'Buscar puzzles', grupo: 'Clássico', desc: 'puzzles --buscar com teto de nós e meta; usa a configuração salva se vazio. Pesado.', params: ['nos', 'meta'], requer: ['tools/classic/import_cards.py'], py: true,
    montar: (q) => IMP('puzzles', '--buscar', '--nos', String(inteiro(q.nos, 'nos', 100, 1000000, config().nos)), '--meta', String(inteiro(q.meta, 'meta', 1, 200, config().meta))) },
  'render-classico': { titulo: 'Render das clássicas', grupo: 'Clássico', desc: 'render.mjs: desenha as cartas clássicas (todas as que faltam, ou só os ids dados).', params: ['force', 'ids'], requer: ['tools/classic/render/render.mjs'],
    montar: (q) => ({ cmd: 'node', args: ['tools/classic/render/render.mjs', ...(q.force ? ['--force'] : []), ...ids(q.ids)] }) },
  rush: { titulo: 'Importar Rush', grupo: 'Rush', desc: 'import_rush.py: fetch (baixa cards-rush.cdb do BabelCDB e os scripts Rush do CardScripts), build (gera src/data/rush/cards.json e copia os scripts).', params: ['comandoRush'], requer: ['tools/rush/import_rush.py'], py: true,
    montar: (q) => {
      if (!RUSH.includes(q.comandoRush)) throw new Error(`comando: ${RUSH.join(', ')}`);
      return { cmd: 'python3', args: ['-I', 'tools/rush/import_rush.py', q.comandoRush] };
    } },
  'artes-rush': { titulo: 'Artes Rush', grupo: 'Rush', desc: 'import_rush.py art: baixa do Yugipedia as artes das cartas Rush do motor (todas as que faltam, ou só os ids) -> src/assets/rush-art/.', params: ['force', 'ids'], requer: ['tools/rush/import_rush.py'], py: true,
    montar: (q) => ({ cmd: 'python3', args: ['-I', 'tools/rush/import_rush.py', 'art', ...(q.force ? ['--force'] : []), ...ids(q.ids)] }) },
  'montar-rush': { titulo: 'Montar cartas Rush', grupo: 'Rush', desc: 'tools/rush/render.mjs: desenha as cartas Rush do motor com moldura e arte (as que faltam, as com arte nova, ou só os ids) -> src/assets/rush-cards/.', params: ['force', 'ids'], requer: ['tools/rush/render.mjs'],
    montar: (q) => ({ cmd: 'node', args: ['tools/rush/render.mjs', ...(q.force ? ['--force'] : []), ...ids(q.ids)] }) },
  'simulacao-rush': { titulo: 'Simulação Rush', grupo: 'Verificação', desc: 'tools/rush/simulate.mjs N modo: IA x IA com decks gerados, bot aleatório com decks sorteados, N dias do desafio diário ou cada nível da IA contra a gulosa do clássico; conta erros de script e travamentos.', params: ['duelos', 'modoRush'], requer: ['tools/rush/simulate.mjs', 'src/vendor/ocgcore/index.js', 'src/data/rush/cards.json'],
    montar: (q) => {
      const modo = q.modoRush || 'todos';
      if (!MODOS_SIM_RUSH.includes(modo)) throw new Error(`modo: ${MODOS_SIM_RUSH.join(', ')}`);
      return { cmd: 'node', args: ['tools/rush/simulate.mjs', String(inteiro(q.duelos, 'duelos', 1, 5000, 200)), modo] };
    } },
  teste: { titulo: 'Testes', grupo: 'Verificação', desc: 'npm test (os testes do clássico exigem os dados do clássico).', params: [], requer: ['tests', 'package.json'], montar: () => ({ cmd: 'npm', args: ['test'] }) },
  simulacao: { titulo: 'Simulação clássica', grupo: 'Verificação', desc: 'simulate.mjs N T: duelos aleatórios do clássico para achar erros de script.', params: ['duelos', 'temporada'], requer: ['tools/classic/simulate.mjs', 'src/data/classic/seasons.json'],
    montar: (q) => ({ cmd: 'node', args: ['tools/classic/simulate.mjs', String(inteiro(q.duelos, 'duelos', 1, 5000, 100)), String(inteiro(q.temporada, 'temporada', 1, NUM_TEMPORADAS, 1))] }) },
};
let temPython = null;
function motivo(t) { // '' = disponível
  const falta = t.requer.find((r) => !existsSync(p(r)));
  if (falta) return `falta ${falta}${falta.startsWith('src/') ? ' (rode o setup)' : ''}`;
  if (t.py && (temPython ??= spawnSync('python3', ['--version']).status === 0) === false) return 'python3 não está instalado';
  return '';
}
const limpaParams = (t, q) => Object.fromEntries(t.params.filter((k) => Object.hasOwn(q, k) && ['string', 'number', 'boolean'].includes(typeof q[k])).map((k) => [k, typeof q[k] === 'string' ? q[k].slice(0, 400) : q[k]]));

// ---- inicialização dos dados no contêiner (serviço rushdaily-dados, tools/admin/conteiner.mjs) ----
const INI = join(DADOS, 'inicializacao.json');
function inicializacao() {
  let s; try { s = JSON.parse(readFileSync(INI, 'utf8')); } catch { return null; }
  const viva = s.estado === 'rodando' && Date.now() - (s.batida || 0) < 60000; // batida a cada 10 s
  let log = [];
  try { log = readFileSync(join(DADOS, 'inicializacao.log'), 'utf8').split('\n').filter(Boolean).slice(-200); } catch { /* sem log */ }
  let progresso = null;
  for (const l of log) { const m = l.match(/(\d+)\s*\/\s*(\d+)/); if (m && +m[2] > 0 && +m[1] <= +m[2]) progresso = { n: +m[1], m: +m[2] }; }
  return { ...s, estado: s.estado === 'rodando' && !viva ? 'interrompida' : s.estado, viva, log, progresso };
}

// ---- resumo legível do fim de uma tarefa (testes e simulações) ----
function resumir(tarefa, log) {
  if (tarefa === 'teste') {
    const n = (k) => { const l = log.findLast((x) => x.startsWith(`# ${k} `) || x.startsWith(`ℹ ${k} `)); return l ? Number(l.split(' ')[2]) : null; };
    const r = { tipo: 'testes', testes: n('tests'), ok: n('pass'), falhas: n('fail'), ignorados: n('skipped') };
    r.falhando = log.filter((l) => /^not ok \d+ - /.test(l.trim())).map((l) => l.trim().replace(/^not ok \d+ - /, '')).slice(0, 20);
    return r.testes === null ? null : r;
  }
  if (tarefa !== 'simulacao' && tarefa !== 'simulacao-rush') return null;
  const grupos = [];
  for (const l of log) {
    if (!/turnos: mediana|vence \d+%/.test(l) || /^\s*geral:/.test(l)) continue;
    let nome = l.split(/\s*(?:\d+ duelos\b|turnos:|vence\b)/)[0].replace(/[:|]\s*$/, '').trim() || 'Duelos';
    if (/^\d/.test(nome)) nome = 'Duelos';
    const m = (re) => l.match(re);
    const vit = m(/vitórias (\d+)\/(\d+) \(empates (\d+)\)/);
    grupos.push({ nome, duelos: Number(m(/(\d+) duelos/)?.[1] ?? 0) || null, mediana: Number(m(/mediana (\d+)/)?.[1] ?? NaN) || null, p90: Number(m(/p90 (\d+)/)?.[1] ?? NaN) || null,
      resultado: vit ? `${vit[1]} x ${vit[2]} (empates ${vit[3]})` : m(/jogador vence (\d+%)/) ? `jogador vence ${m(/jogador vence (\d+%)/)[1]}` : m(/vence (\d+%)/) ? `vence ${m(/vence (\d+%)/)[1]}` : '',
      travados: Number(m(/travados (\d+)/)?.[1] ?? 0) });
  }
  const erros = log.find((l) => l.startsWith('erros de script:'));
  const geral = log.find((l) => /^\s*geral:/.test(l))?.trim() ?? log.find((l) => /duelos( Rush)? em [\d.]+s/.test(l))?.trim() ?? '';
  const outros = log.filter((l) => /^(perguntas sem resposta|travamentos|cartas fora das zonas|decks gerados ilegais):/.test(l)).map((l) => l.split(':')[0]);
  return grupos.length ? { tipo: 'simulacao', grupos, geral, errosScript: erros ? !/nenhum\s*$/.test(erros) : null, alertas: outros } : null;
}

// ---- fila e execução ----
const HIST = join(DADOS, 'historico.json');
let historico = [];
try { historico = JSON.parse(readFileSync(HIST, 'utf8')); } catch { /* primeira vez */ }
const logDe = (id) => join(DADOS, 'logs', `${Number(id)}.log`);
function gravaHist() {
  historico = historico.slice(0, 30);
  writeFileSync(HIST, JSON.stringify(historico));
  const vivos = new Set(historico.map((h) => `${h.id}.log`));
  try { for (const n of readdirSync(join(DADOS, 'logs'))) if (!vivos.has(n)) rmSync(join(DADOS, 'logs', n), { force: true }); } catch { /* ok */ }
}
let seq = Date.now();
let atual = null; // { id, tarefa, titulo, linha, params, inicio, filho, log[], progresso, cancelada }
const fila = [];
const clientes = new Set();
const enviar = (obj) => { const s = `data: ${JSON.stringify(obj)}\n\n`; for (const r of clientes) r.write(s); };
const resumo = (j) => ({ id: j.id, tarefa: j.tarefa, titulo: j.titulo, linha: j.linha, inicio: j.inicio, progresso: j.progresso });
const estado = () => ({ tipo: 'estado', atual: atual && resumo(atual), fila: fila.map(resumo), historico: historico.slice(0, 30).map(({ log, ...h }) => h) });

function iniciar() {
  if (atual || !fila.length) return;
  const j = fila.shift();
  const { cmd, args } = j.cmd;
  atual = { ...j, inicio: Date.now(), log: [], progresso: null, cancelada: false };
  enviar(estado()); // antes das linhas: o navegador limpa o log ao ver uma tarefa nova
  const filho = spawn(cmd, args, { cwd: ROOT, detached: true, stdio: ['ignore', 'pipe', 'pipe'], env: { ...process.env, ADMIN_PANEL_TOKEN: '', SYNC_ADMIN_TOKEN: '', ADMIN_TOKEN: '', PYTHONUNBUFFERED: '1', NO_COLOR: '1' } });
  atual.filho = filho;
  const linha = (texto) => {
    const a = atual; if (!a) return;
    a.log.push(texto); if (a.log.length > 4000) a.log.splice(0, 1000); // só as últimas ~4000 linhas ficam na memória
    let m;
    if ((m = texto.match(/(\d+)\s*\/\s*(\d+)/)) && +m[2] > 0 && +m[1] <= +m[2]) a.progresso = { n: +m[1], m: +m[2] };
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
    const r = resumir(a.tarefa, a.log);
    try { writeFileSync(logDe(a.id), a.log.join('\n')); } catch { /* sem disco: fica só o final no histórico */ }
    historico.unshift({ id: a.id, tarefa: a.tarefa, titulo: a.titulo, linha: a.linha, params: a.params, inicio: a.inicio, duracaoMs: Date.now() - a.inicio, codigo, sinal, cancelada: a.cancelada, resumo: r, log: a.log.slice(-80) });
    gravaHist();
    cacheStatus.v = null; cacheDados.clear();
    enviar({ tipo: 'fim', id: a.id, titulo: a.titulo, codigo, cancelada: a.cancelada, resumo: r });
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

// ---- dados lidos do disco (somente leitura, lista fechada, com cache curto) ----
const cacheDados = new Map();
function dado(rel) {
  if (!/^src\/data\/(rush\/cards|classic\/(seasons|tokens|puzzles|s[1-9]))\.json$/.test(rel)) throw new Error('dado fora da lista');
  const c = cacheDados.get(rel);
  if (c && Date.now() - c.t < 30000) return c.v;
  let v = null; try { v = JSON.parse(readFileSync(p(rel), 'utf8')); } catch { /* falta */ }
  cacheDados.set(rel, { t: Date.now(), v });
  return v;
}
const temporadas = () => dado('src/data/classic/seasons.json') ?? [];
const classicas = () => temporadas().filter((s) => s.enabled).flatMap((s) => dado(`src/data/classic/s${s.season}.json`) ?? []);

// ---- status (somente leitura) ----
const arquivos = (dir, re) => { try { return readdirSync(dir).filter((n) => re.test(n)).length; } catch { return 0; } };
const mtime = (...x) => { try { return statSync(p(...x)).mtimeMs; } catch { return 0; } };
function tamanho(dir) { // bytes de uma árvore (sem seguir links)
  let t = 0;
  const anda = (d) => { let es; try { es = readdirSync(d, { withFileTypes: true }); } catch { return; } for (const e of es) { const f = join(d, e.name); if (e.isDirectory()) anda(f); else if (e.isFile()) { try { t += statSync(f).size; } catch { /* some */ } } } };
  try { if (statSync(dir).isFile()) return statSync(dir).size; } catch { return 0; }
  anda(dir); return t;
}

let cacheStatus = { t: 0, v: null };
function status() {
  if (cacheStatus.v && Date.now() - cacheStatus.t < 4000) return cacheStatus.v;
  const ex = (x) => existsSync(p(x));
  const ts = temporadas().filter((s) => s.enabled);
  const totalClassicas = ts.reduce((a, s) => a + s.count, 0);
  const artes = arquivos(p('src/assets/classic-art'), /\.webp$/);
  const cartasCl = arquivos(p('src/assets/classic-cards'), /\.webp$/);
  const puzzles = (dado('src/data/classic/puzzles.json') ?? []).length;
  const luas = arquivos(p('src/vendor/card-scripts/official'), /^c\d+\.lua$/);
  const clSm = arquivos(p('src/assets/classic-cards-sm'), /\.webp$/);
  const rushOcg = dado('src/data/rush/cards.json') ?? [];
  const luasRush = arquivos(p('src/vendor/card-scripts/rush'), /^c\d+\.lua$/);
  const rushPt = rushOcg.filter((c) => c.pt).length;
  const rushArte = arquivos(p('src/assets/rush-art'), /^\d+\.webp$/);
  const rushCartas = arquivos(p('src/assets/rush-cards'), /^\d+\.webp$/);
  const rushSm = arquivos(p('src/assets/rush-cards-sm'), /^\d+\.webp$/);
  const seasonsOk = ts.length > 0 && ts.every((s) => ex(`src/data/classic/s${s.season}.json`));
  const E = {
    three: { pronto: ex('src/vendor/three.module.js'), caminhos: ['src/vendor/three.module.js'] },
    qrcode: { pronto: ex('src/vendor/qrcode/qrcode.mjs') && ex('src/vendor/qrcode/LICENSE'), caminhos: ['src/vendor/qrcode'] },
    ocgcore: { pronto: ex('src/vendor/ocgcore/index.js') && ex('src/vendor/ocgcore/ocgcore.wasm') && ex('src/vendor/ocgcore/LICENSE.md'), caminhos: ['src/vendor/ocgcore'] },
    yugioh: { pronto: ex('src/vendor/yugioh-card/yugioh-card.js') && ex('src/vendor/yugioh-card/assets/yugioh/font/font-list.json') && ex('src/vendor/yugioh-card/assets/rush-duel/font/font-list.json'), caminhos: ['src/vendor/yugioh-card'] },
    classico: { pronto: seasonsOk && ex('src/data/classic/puzzles.json') && luas > 0 && artes >= totalClassicas && totalClassicas > 0, parcial: seasonsOk || artes > 0,
      contagem: `artes ${artes}/${totalClassicas} · puzzles validados ${puzzles} · scripts Lua ${luas} · temporadas ativas ${ts.length}`,
      caminhos: ['src/data/classic', 'src/assets/classic-art', 'src/vendor/card-scripts', 'tools/classic/cache'] },
    'rush-ocg': { pronto: rushOcg.length > 0 && luasRush > 0 && ex('src/vendor/card-scripts/rush/index.json') && ex('src/vendor/card-scripts/constant.lua'), parcial: rushOcg.length > 0 || luasRush > 0 || ex('tools/rush/cache/cards-rush.cdb'),
      contagem: `${rushOcg.length} cartas (${rushPt} em PT · ${rushOcg.filter((c) => c.legend).length} Lenda) · scripts Lua ${luasRush} · cache ${(tamanho(p('tools/rush/cache')) / 1048576).toFixed(1)} MB`,
      caminhos: ['src/data/rush', 'src/vendor/card-scripts/rush', 'tools/rush/cache'] },
    'rush-art': { pronto: rushOcg.length > 0 && rushArte >= rushOcg.length, parcial: rushArte > 0, contagem: `${rushArte}/${rushOcg.length} artes Rush (sem arte: quadro no tom do atributo)`, caminhos: ['src/assets/rush-art'] },
    'rush-cartas': { pronto: rushOcg.length > 0 && rushCartas >= rushOcg.length, parcial: rushCartas > 0, contagem: `${rushCartas}/${rushOcg.length} cartas Rush montadas (${rushArte} com arte) · miniaturas ${rushSm}`, caminhos: ['src/assets/rush-cards', 'src/assets/rush-cards-sm'] },
    'classico-render': { pronto: cartasCl > 0 && cartasCl >= artes, parcial: cartasCl > 0, contagem: `${cartasCl} cartas pré-desenhadas (${artes} artes)`, caminhos: ['src/assets/classic-cards'] },
    miniaturas: { pronto: cartasCl > 0 && clSm >= cartasCl, parcial: clSm > 0, contagem: `clássicas ${clSm}/${cartasCl}`, caminhos: ['src/assets/classic-cards-sm'] },
    enigma: { pronto: ex('src/assets/puzzle/puzzle.bin') && ex('src/assets/puzzle/puzzle.json'), caminhos: ['src/assets/puzzle', 'tools/setup/cache/enigma'] },
    'vendor-avisos': { pronto: ex('src/vendor/CHECKSUMS.txt'), caminhos: ['src/vendor/CHECKSUMS.txt'] },
  };
  const etapas = ETAPAS.map((e) => {
    const d = E[e.nome] ?? { pronto: false, caminhos: [] };
    return { nome: e.nome, desc: e.desc, pronto: !!d.pronto, parcial: !d.pronto && !!d.parcial, contagem: d.contagem ?? '', bytes: d.caminhos.reduce((a, c) => a + tamanho(p(c)), 0), geradoEm: Math.max(0, ...d.caminhos.map((c) => mtime(c))) || null };
  });
  const caches = [];
  try { for (const d of readdirSync(p('tools'), { withFileTypes: true })) if (d.isDirectory() && existsSync(p('tools', d.name, 'cache'))) caches.push({ nome: `tools/${d.name}/cache`, bytes: tamanho(p('tools', d.name, 'cache')) }); } catch { /* sem tools/ */ }
  const contagens = { rush: rushOcg.length, rushPt, scriptsRush: luasRush, rushArte, rushCartas, rushSm, classicas: totalClassicas, classicArte: artes, classicCartas: cartasCl, classicSm: clSm, scriptsClassicos: luas, puzzles, temporadas: ts.length };
  cacheStatus = { t: Date.now(), v: { tipo: 'status', etapas, caches, cacheTotal: caches.reduce((a, c) => a + c.bytes, 0), contagens, inicializacao: inicializacao() } };
  return cacheStatus.v;
}

// ---- cartas: busca por id/nome no Rush e no clássico, e as imagens de pastas fixas ----
const PASTAS = { 'rush-art': 'Arte Rush', 'rush-cards': 'Carta Rush montada', 'rush-cards-sm': 'Miniatura Rush', 'classic-art': 'Arte clássica', 'classic-cards': 'Carta clássica pré-desenhada', 'classic-cards-sm': 'Miniatura clássica' };
const semAcento = (s) => String(s ?? '').normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase();
const temImg = (pasta, id) => existsSync(p('src/assets', pasta, `${id}.webp`));
function buscarCartas(q) {
  const termo = semAcento(q).trim().slice(0, 60);
  if (termo.length < 2 && !/^\d+$/.test(termo)) return [];
  const casa = (c) => String(c.id) === termo || (/^\d{3,}$/.test(termo) ? String(c.id).includes(termo) : semAcento(c.name).includes(termo) || semAcento(c.nameEn).includes(termo));
  const peso = (c) => (String(c.id) === termo ? 0 : semAcento(c.name).startsWith(termo) ? 1 : 2);
  const rush = (dado('src/data/rush/cards.json') ?? []).filter(casa).map((c) => ({ fonte: 'rush', c }));
  const cl = classicas().filter(casa).map((c) => ({ fonte: 'classico', c }));
  return [...rush, ...cl].sort((a, b) => peso(a.c) - peso(b.c)).slice(0, 40).map(({ fonte, c }) => {
    const pre = fonte === 'rush' ? 'rush' : 'classic';
    return { fonte, id: c.id, name: c.name, nameEn: c.nameEn ?? '', type: c.type, atk: c.atk, def: c.def, level: c.level, race: c.race, attribute: c.attribute, legend: !!c.legend, pt: !!c.pt, desc: String(c.desc ?? '').slice(0, 1200),
      arte: temImg(`${pre}-art`, c.id), montada: temImg(`${pre}-cards`, c.id), mini: temImg(`${pre}-cards-sm`, c.id) };
  });
}

// ---- desafio do dia: o mesmo gerador do jogo (src/engine/daily-generator.mjs) sobre src/data/rush/cards.json ----
let gerador, geradorFalhou = 0; // módulo do jogo; se falhar (setup incompleto), tenta de novo depois de 30 s
const cacheDesafio = new Map();
let poolDoCache = null;
async function desafio(data, dias) {
  if (!gerador && Date.now() - geradorFalhou > 30000) {
    const u = pathToFileURL(p('src/engine/daily-generator.mjs')).href + (geradorFalhou ? `?r=${Date.now()}` : '');
    try { gerador = await import(u); } catch (e) { geradorFalhou = Date.now(); console.error(`desafio indisponível: ${e.message}`); }
  }
  if (!gerador) return { erro: 'O gerador do desafio (src/engine) ou o motor (src/vendor/ocgcore) não está disponível aqui. Rode o setup (etapa ocgcore).' };
  const pool = dado('src/data/rush/cards.json');
  if (!pool?.length) return { erro: 'Sem src/data/rush/cards.json: rode a etapa rush-ocg do setup.' };
  if (pool !== poolDoCache) { cacheDesafio.clear(); poolDoCache = pool; }
  const byId = new Map(pool.map((c) => [c.id, c]));
  const gera = (d, dif) => {
    const k = `${d}:${dif}`;
    if (!cacheDesafio.has(k)) { if (cacheDesafio.size > 200) cacheDesafio.clear(); cacheDesafio.set(k, gerador.generateDailyMatch({ date: d, difficulty: dif, pool })); }
    return cacheDesafio.get(k);
  };
  const cartas = {};
  const usa = (lista) => { for (const id of lista) if (!cartas[id]) { const c = byId.get(id); if (c) cartas[id] = { n: c.name, t: c.type, a: c.atk, d: c.def, l: c.level, lg: !!c.legend, at: c.attribute, r: c.race }; } return lista; };
  const difs = gerador.listDifficulties();
  const base = gera(data, difs[0].id);
  const lado = (s) => ({ label: s.label, lp: s.lp, power: s.power ?? gerador.deckPower(s.deck, byId), deck: { main: usa(s.deck.main), extra: usa(s.deck.extra) } });
  const dia = { data, jogador: lado(base.player), rivais: difs.map((d) => { const m = gera(data, d.id); return { id: d.id, nome: d.label, rating: d.rating, modifier: d.modifier, ai: m.enemy.ai, ...lado(m.enemy) }; }) };
  const proximos = [];
  for (let i = 1; i <= dias; i++) {
    const d = new Date(`${data}T12:00:00Z`); d.setUTCDate(d.getUTCDate() + i);
    const iso = d.toISOString().slice(0, 10);
    const m = gera(iso, 'duelist');
    proximos.push({ data: iso, jogador: m.player.label, rival: m.enemy.label });
  }
  return { dia, proximos, cartas };
}
const dataOk = (s) => /^\d{4}-\d{2}-\d{2}$/.test(s ?? '') && !Number.isNaN(Date.parse(`${s}T12:00:00Z`)) && Math.abs(Date.parse(`${s}T12:00:00Z`) - Date.now()) < 400 * 86400000;

// ---- HTTP ----
const json = (res, cod, obj) => { res.writeHead(cod, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store', 'x-content-type-options': 'nosniff' }); res.end(JSON.stringify(obj)); };
const lerCorpo = (req) => new Promise((ok, no) => { let b = ''; req.on('data', (d) => { b += d; if (b.length > 20000) { no(new Error('corpo grande')); req.destroy(); } }); req.on('end', () => { try { ok(b ? JSON.parse(b) : {}); } catch { no(new Error('JSON inválido')); } }); });
const PORTAS = [...new Set([PORTA, PORTA_PUBLICA])].join('|');
const hostOk = (h) => new RegExp(`^(127\\.0\\.0\\.1|localhost):(${PORTAS})$`).test(h ?? ''); // contra DNS rebinding
const originOk = (o) => !o || new RegExp(`^http://(127\\.0\\.0\\.1|localhost):(${PORTAS})$`).test(o);
const CSP = "default-src 'none'; script-src 'self'; style-src 'self' https://fonts.googleapis.com; font-src https://fonts.gstatic.com; connect-src 'self'; img-src 'self' data: blob:; base-uri 'none'; form-action 'none'; frame-ancestors 'none'";
// Lista fechada de arquivos servidos (nada de servir diretório).
const ESTATICOS = {
  '/': [join(PUBLIC, 'index.html'), 'text/html; charset=utf-8'],
  '/index.html': [join(PUBLIC, 'index.html'), 'text/html; charset=utf-8'],
  '/admin.css': [join(PUBLIC, 'admin.css'), 'text/css; charset=utf-8'],
  '/admin.js': [join(PUBLIC, 'admin.js'), 'text/javascript; charset=utf-8'],
  '/logo.png': [p('src/assets/logo-mark.png'), 'image/png'],
};
const cabecalhos = (tipo) => ({ 'content-type': tipo, 'cache-control': 'no-store', 'content-security-policy': CSP, 'x-content-type-options': 'nosniff', 'referrer-policy': 'no-referrer', 'x-frame-options': 'DENY' });

createServer(async (req, res) => {
  try {
    if (!hostOk(req.headers.host) || !originOk(req.headers.origin)) return json(res, 403, { erro: 'Host/Origin não permitido' });
    if (req.url.includes('..') || req.url.includes('%2e') || req.url.includes('%2E') || req.url.includes('\\')) return json(res, 400, { erro: 'caminho inválido' });
    const url = new URL(req.url, `http://127.0.0.1:${PORTA}`);
    const rota = url.pathname;
    if (req.method === 'GET' && Object.hasOwn(ESTATICOS, rota)) {
      const [arq, tipo] = ESTATICOS[rota];
      if (!existsSync(arq)) return json(res, 404, { erro: 'não encontrado' });
      res.writeHead(200, cabecalhos(tipo));
      return res.end(readFileSync(arq));
    }
    if (rota === '/favicon.ico') { res.writeHead(204); return res.end(); }
    const arquivo = /^\/arquivo\/([a-z-]+)\/(\d{1,10})\.(webp|png)$/.exec(rota);
    if (!rota.startsWith('/api/') && !arquivo) return json(res, 404, { erro: 'não encontrado' });
    if (!tokenOk(req.headers['x-admin-token'])) return json(res, 401, { erro: 'token ausente ou inválido' });

    if (arquivo) { // só imagens de pastas fixas de src/assets, nome = id numérico
      if (req.method !== 'GET' || !Object.hasOwn(PASTAS, arquivo[1])) return json(res, 404, { erro: 'não encontrado' });
      const f = p('src/assets', arquivo[1], `${arquivo[2]}.${arquivo[3]}`);
      if (!existsSync(f)) return json(res, 404, { erro: 'imagem não existe' });
      res.writeHead(200, { 'content-type': arquivo[3] === 'png' ? 'image/png' : 'image/webp', 'cache-control': 'private, max-age=300', 'x-content-type-options': 'nosniff' });
      return res.end(readFileSync(f));
    }
    if (req.method === 'GET' && rota === '/api/tarefas') {
      return json(res, 200, { etapas: ETAPAS, modo: { conteiner: CONTEINER, setup: temSetup, raiz: CONTEINER ? '/dados (volume)' : ROOT },
        tarefas: Object.fromEntries(Object.entries(TAREFAS).map(([k, t]) => [k, { titulo: t.titulo, grupo: t.grupo, desc: t.desc, params: t.params, indisponivel: motivo(t) }])) });
    }
    if (req.method === 'GET' && rota === '/api/status') return json(res, 200, status());
    if (req.method === 'GET' && rota === '/api/inicializacao') return json(res, 200, inicializacao() ?? { estado: 'nenhuma' });
    if (req.method === 'GET' && rota === '/api/config') {
      const versao = (f) => { try { return Number(readFileSync(p(f), 'utf8').match(/CACHE_VERSION = (\d+)/)?.[1]) || null; } catch { return null; } };
      const s = syncAdmin();
      return json(res, 200, { ...config(), temporadas: temporadas(), cacheVersion: versao('src/ui/classic-render.js'), cacheVersionRush: versao('src/ui/rush-render.js'), sync: { url: s.url, configurado: !!s.token }, conteiner: CONTEINER });
    }
    if (req.method === 'PUT' && rota === '/api/config') {
      const q = await lerCorpo(req);
      let nova;
      try { nova = { nos: inteiro(q.nos, 'nos', 100, 1000000), meta: inteiro(q.meta, 'meta', 1, 200) }; } catch (e) { return json(res, 400, { erro: e.message }); }
      writeFileSync(join(DADOS, 'config.json'), JSON.stringify({ ...cfgArquivo(), ...nova }), { mode: 0o600 }); // preserva o resto (token do sync)
      return json(res, 200, nova);
    }
    if (req.method === 'GET' && rota === '/api/carta') {
      const q = url.searchParams.get('q') ?? '';
      if (q.length > 60) return json(res, 400, { erro: 'busca longa demais' });
      return json(res, 200, { cartas: buscarCartas(q), rushDisponivel: !!dado('src/data/rush/cards.json'), classicoDisponivel: temporadas().length > 0 });
    }
    if (req.method === 'GET' && rota === '/api/desafio') {
      const data = url.searchParams.get('data');
      if (!dataOk(data)) return json(res, 400, { erro: 'data: AAAA-MM-DD (até 400 dias de hoje)' });
      let dias;
      try { dias = inteiro(url.searchParams.get('dias') ?? undefined, 'dias', 0, 14, 7); } catch (e) { return json(res, 400, { erro: e.message }); }
      return json(res, 200, await desafio(data, dias));
    }
    if (req.method === 'GET' && rota.startsWith('/api/jogadores/')) { // proxy só-leitura para /admin/* do servidor de sync
      const { url: base, token } = syncAdmin();
      if (!token) return json(res, 200, { configurado: false, conteiner: CONTEINER });
      const m = /^\/api\/jogadores\/(resumo|usuarios|usuario\/[A-Z0-9]{6})$/.exec(rota);
      if (!m) return json(res, 404, { erro: 'não encontrado' });
      const qs = new URLSearchParams(); // só parâmetros conhecidos
      for (const k of ['ordem', 'dir', 'limite', 'pagina', 'busca']) if (url.searchParams.has(k)) qs.set(k, url.searchParams.get(k).slice(0, 20));
      try {
        const r = await fetch(`${base}/admin/${m[1]}${qs.size ? `?${qs}` : ''}`, { headers: { authorization: `Bearer ${token}` }, signal: AbortSignal.timeout(5000), redirect: 'error' });
        const corpo = await r.json().catch(() => ({}));
        return json(res, r.ok ? 200 : 502, r.ok ? { configurado: true, ...corpo } : { configurado: true, erro: r.status === 401 || r.status === 403 ? 'O servidor de sync recusou o token (SYNC_ADMIN_TOKEN / ADMIN_TOKEN do .env).' : `O servidor de sync respondeu ${r.status}.` });
      } catch {
        return json(res, 502, { configurado: true, erro: CONTEINER ? `Não consegui falar com o servidor de sync em ${base}. O serviço rushdaily-sync está no ar e com ADMIN_TOKEN no .env?` : `Não consegui falar com o servidor de sync em ${base}. O túnel SSH (-L 4192) está aberto?` });
      }
    }
    if (req.method === 'GET' && rota === '/api/estado') return json(res, 200, estado());
    if (req.method === 'GET' && rota === '/api/historico') {
      const h = historico.find((x) => String(x.id) === url.searchParams.get('id'));
      if (!h) return json(res, 404, { erro: 'execução não encontrada' });
      let log = h.log, completo = false;
      try { log = readFileSync(logDe(h.id), 'utf8').split('\n'); completo = true; } catch { /* só o final */ }
      return json(res, 200, { ...h, log, completo });
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
      const t = typeof q.tarefa === 'string' && Object.hasOwn(TAREFAS, q.tarefa) ? TAREFAS[q.tarefa] : null;
      if (!t) return json(res, 400, { erro: 'tarefa desconhecida' });
      const falta = motivo(t);
      if (falta) return json(res, 400, { erro: `tarefa indisponível aqui: ${falta}` });
      const params = q.params && typeof q.params === 'object' && !Array.isArray(q.params) ? q.params : {};
      let cmd;
      try { cmd = t.montar(params); } catch (e) { return json(res, 400, { erro: e.message }); }
      if (inicializacao()?.viva) return json(res, 409, { erro: 'A inicialização dos dados (serviço rushdaily-dados) está rodando no volume; espere terminar.' });
      if (fila.length >= 10) return json(res, 429, { erro: 'fila cheia (10)' });
      const job = { id: ++seq, tarefa: q.tarefa, titulo: t.titulo, params: limpaParams(t, params), cmd, linha: [cmd.cmd, ...cmd.args].join(' ') };
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
}).listen(PORTA, HOST, () => {
  if (CONTEINER) console.log(`RushDaily admin no contêiner (porta ${PORTA}; o compose publica só em 127.0.0.1:${PORTA_PUBLICA} do host).\nNo seu computador: ssh -L ${PORTA_PUBLICA}:127.0.0.1:${PORTA_PUBLICA} homelab e abra http://127.0.0.1:${PORTA_PUBLICA}/?t=<ADMIN_PANEL_TOKEN do .env>`);
  else console.log(`RushDaily admin (somente local). Abra:\n\n  http://127.0.0.1:${PORTA}/?t=${TOKEN}\n\nO token vale só até parar o servidor. Ctrl+C encerra (e cancela a tarefa em andamento).`);
}).on('error', (e) => { console.error(`Não consegui escutar em ${HOST}:${PORTA}: ${e.message}`); process.exit(1); });

const sair = () => { if (atual) matar(atual.filho); setTimeout(() => process.exit(0), 300); };
process.on('SIGINT', sair); process.on('SIGTERM', sair);
