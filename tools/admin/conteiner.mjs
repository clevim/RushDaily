#!/usr/bin/env node
// Entrada da imagem rushdaily-admin (código + ferramentas do setup). O código fica imutável em /opt/rushdaily; os dados
// gerados (src/vendor, src/data, src/assets das cartas, caches das ferramentas) ficam no volume /dados, que vira a raiz
// de trabalho: a cada início o código da imagem é copiado para lá e o setup roda sem nenhum desvio de caminho.
//   dados    roda o setup e sai: só baixa/gera o que falta e refaz o que ficou desatualizado (o código que gera a etapa mudou
//            com a imagem nova; as impressões ficam em /dados/tools/setup/cache/estado.json, que a cópia do código não toca).
//            Serviço rushdaily-dados, a cada `docker compose up`. Parâmetros do .env: SETUP_TEMPORADAS (1 a 5),
//            SETUP_SEM_RENDER=1 e SETUP_PARALELO (etapas ao mesmo tempo, 1 a 8; padrão do setup: 4). Extras: --force e --so <etapas>.
//   verificar  copia o código e mostra o que o setup refaria (setup --verificar), sem baixar nem gerar nada.
//   painel   sobe o painel admin (tools/admin/server.mjs) sobre o volume. Serviço rushdaily-admin (profile admin).
import { spawn } from 'node:child_process';
import { appendFileSync, copyFileSync, existsSync, mkdirSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const CODIGO = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const RAIZ = process.env.RUSHDAILY_RAIZ || '/dados';
const DADOS = join(RAIZ, 'tools/setup/cache/admin'); // o mesmo lugar onde o painel guarda histórico e configuração
const INI = join(DADOS, 'inicializacao.json');
const LOG = join(DADOS, 'inicializacao.log');
const SEMENTES = new Set(['tools/classic/puzzle-solutions.json']); // o setup reescreve: junta em vez de sobrescrever
// Memória de tradução editada no painel: a entrada revisada no volume vence a automática da imagem (as revisadas que já
// foram para o repositório vêm iguais na imagem). Assim a edição no contêiner não se perde a cada subida.
const TRADUCAO = new Set(['tools/rush/traducao/nomes.json', 'tools/rush/traducao/frases.json']);
const juntaTraducao = (imagem, volume) => {
  const out = { ...imagem };
  for (const [en, e] of Object.entries(volume)) if (e?.origem === 'revisada' && (!out[en] || out[en].origem === 'automatica')) out[en] = e;
  return out;
};
const IGNORA = new Set(['node_modules', 'cache', '__pycache__', '.git']);
const fim = (msg) => { console.error(`ERRO: ${msg}`); process.exit(1); };

if (CODIGO === RAIZ) fim('RUSHDAILY_RAIZ não pode ser a pasta do código da imagem.');
try { mkdirSync(DADOS, { recursive: true }); } catch (e) {
  fim(`não consigo escrever em ${RAIZ} (${e.code}). O volume precisa ser do usuário 1000: docker compose run --rm --user root --entrypoint chown rushdaily-dados -R 1000:1000 /dados`);
}

// ---- copia o código da imagem para o volume (com trava: dados e painel podem subir juntos) ----
function arvore(dir, rel = '') {
  const lista = [];
  for (const e of readdirSync(join(dir, rel), { withFileTypes: true })) {
    if (IGNORA.has(e.name)) continue;
    const r = rel ? `${rel}/${e.name}` : e.name;
    if (e.isDirectory()) lista.push(...arvore(dir, r)); else if (e.isFile()) lista.push(r);
  }
  return lista;
}
const igual = (a, b) => { try { const x = statSync(a), y = statSync(b); return x.size === y.size && readFileSync(a).equals(readFileSync(b)); } catch { return false; } };
async function sincronizar() {
  const trava = join(RAIZ, '.rushdaily-trava');
  for (let i = 0; ; i++) {
    try { mkdirSync(trava); break; } catch (e) {
      if (e.code !== 'EEXIST') throw e;
      try { if (Date.now() - statSync(trava).mtimeMs > 600000) { rmSync(trava, { recursive: true, force: true }); continue; } } catch { continue; }
      if (i > 120) fim('a trava de cópia do código não saiu em 2 min (outro contêiner travado?). Apague /dados/.rushdaily-trava.');
      await new Promise((ok) => setTimeout(ok, 1000));
    }
  }
  try {
    const novos = arvore(CODIGO);
    const manifesto = join(RAIZ, '.rushdaily-codigo.json');
    let velhos = [];
    try { velhos = JSON.parse(readFileSync(manifesto, 'utf8')); } catch { /* primeira vez */ }
    const conjunto = new Set(novos);
    let removidos = 0, copiados = 0;
    for (const rel of velhos) { // arquivo de código que saiu do projeto: sai do volume também
      if (typeof rel !== 'string' || conjunto.has(rel) || rel.split('/').includes('..') || rel.startsWith('/')) continue;
      rmSync(join(RAIZ, ...rel.split('/')), { force: true }); removidos++;
    }
    for (const rel of novos) {
      const de = join(CODIGO, ...rel.split('/')), para = join(RAIZ, ...rel.split('/'));
      if (TRADUCAO.has(rel) && existsSync(para)) {
        try { writeFileSync(para, JSON.stringify(juntaTraducao(JSON.parse(readFileSync(de, 'utf8')), JSON.parse(readFileSync(para, 'utf8'))), null, 0)); } catch { copyFileSync(de, para); }
        continue;
      }
      if (SEMENTES.has(rel) && existsSync(para)) {
        try { writeFileSync(para, JSON.stringify({ ...JSON.parse(readFileSync(de, 'utf8')), ...JSON.parse(readFileSync(para, 'utf8')) })); } catch { copyFileSync(de, para); }
        continue;
      }
      if (igual(de, para)) continue;
      mkdirSync(dirname(para), { recursive: true });
      rmSync(para, { force: true }); // troca o arquivo (não escreve através de um link)
      copyFileSync(de, para); copiados++;
    }
    writeFileSync(manifesto, JSON.stringify(novos));
    console.log(`código da imagem em ${RAIZ}: ${copiados} arquivo(s) atualizado(s), ${removidos} removido(s)`);
  } finally { rmSync(trava, { recursive: true, force: true }); }
}

const estado = () => { try { return JSON.parse(readFileSync(INI, 'utf8')); } catch { return null; } };
const inicializando = () => { const s = estado(); return s?.estado === 'rodando' && Date.now() - (s.batida || 0) < 60000; };

// ---- dados: setup no volume ----
async function dados(extras) {
  const temporadas = Number(process.env.SETUP_TEMPORADAS || 1);
  if (!Number.isInteger(temporadas) || temporadas < 1 || temporadas > 5) fim(`SETUP_TEMPORADAS deve ser de 1 a 5 (veio "${process.env.SETUP_TEMPORADAS}").`);
  const args = ['tools/setup/setup.mjs', '--temporadas', String(temporadas)];
  if (/^(1|sim|true)$/i.test(process.env.SETUP_SEM_RENDER || '')) args.push('--sem-render');
  if (process.env.SETUP_PARALELO) {
    const n = Number(process.env.SETUP_PARALELO);
    if (!Number.isInteger(n) || n < 1 || n > 8) fim(`SETUP_PARALELO deve ser de 1 a 8 (veio "${process.env.SETUP_PARALELO}").`);
    args.push('--paralelo', String(n));
  }
  for (let i = 0; i < extras.length; i++) { // só o que faz sentido no serviço; nada vai para um shell
    if (extras[i] === '--force') args.push('--force');
    else if (extras[i] === '--so' && /^[a-z-]+(,[a-z-]+)*$/.test(extras[i + 1] ?? '')) args.push('--so', extras[++i]);
    else fim(`argumento não aceito: ${extras[i]} (use --force e/ou --so etapa1,etapa2)`);
  }
  if (inicializando()) fim('outra inicialização está rodando neste volume (batida há menos de 1 min).');
  await sincronizar();
  const inicio = Date.now();
  const grava = (extra) => writeFileSync(INI, JSON.stringify({ estado: 'rodando', inicio, batida: Date.now(), args: ['node', ...args], ...extra }));
  grava();
  writeFileSync(LOG, '');
  let bytes = 0;
  const linhas = [];
  const escreve = (texto) => {
    process.stdout.write(texto);
    for (const l of texto.split(/\r?\n|\r/)) if (l) linhas.push(l);
    if (linhas.length > 3000) linhas.splice(0, 1000);
    bytes += texto.length;
    if (bytes > 5e6) { writeFileSync(LOG, linhas.join('\n') + '\n'); bytes = 0; } else appendFileSync(LOG, texto.replace(/\r(?!\n)/g, '\n'));
  };
  console.log(`$ node ${args.join(' ')}  (em ${RAIZ})`);
  const filho = spawn('node', args, { cwd: RAIZ, stdio: ['ignore', 'pipe', 'pipe'], env: { ...process.env, PYTHONUNBUFFERED: '1', NO_COLOR: '1' } });
  filho.stdout.setEncoding('utf8').on('data', escreve);
  filho.stderr.setEncoding('utf8').on('data', escreve);
  const batida = setInterval(() => grava(), 10000);
  let parado = false;
  const parar = () => { parado = true; filho.kill('SIGTERM'); };
  process.on('SIGTERM', parar); process.on('SIGINT', parar);
  const codigo = await new Promise((ok) => { filho.on('close', (c) => ok(c ?? 1)); filho.on('error', (e) => { escreve(`ERRO ao iniciar: ${e.message}\n`); ok(1); }); });
  clearInterval(batida);
  grava({ estado: parado ? 'interrompida' : codigo === 0 ? 'ok' : 'erro', codigo, fim: Date.now() });
  console.log(codigo === 0 ? 'dados prontos.' : `o setup saiu com ${codigo}: rode de novo (docker compose up -d rushdaily-dados) que ele retoma de onde parou.`);
  process.exit(codigo);
}

// ---- verificar: o que a próxima subida do rushdaily-dados vai refazer ----
async function verificar() {
  if (inicializando()) fim('a inicialização dos dados está rodando neste volume; veja o log dela.');
  await sincronizar();
  const temporadas = process.env.SETUP_TEMPORADAS ? ['--temporadas', String(Number(process.env.SETUP_TEMPORADAS) || 1)] : [];
  const sem = /^(1|sim|true)$/i.test(process.env.SETUP_SEM_RENDER || '') ? ['--sem-render'] : [];
  const r = spawn('node', ['tools/setup/setup.mjs', '--verificar', ...temporadas, ...sem], { cwd: RAIZ, stdio: 'inherit' });
  r.on('close', (c) => process.exit(c ?? 1));
}

// ---- painel ----
async function painel() {
  if (inicializando()) console.log('inicialização dos dados em andamento: o código já foi copiado por ela.');
  else await sincronizar();
  process.env.ADMIN_CONTAINER = '1';
  process.chdir(RAIZ);
  await import(pathToFileURL(join(RAIZ, 'tools', 'admin', 'server.mjs')).href);
}

const [modo, ...extras] = process.argv.slice(2);
if (modo === 'dados') await dados(extras);
else if (modo === 'verificar') await verificar();
else if (modo === 'painel') await painel();
else fim(`uso: conteiner.mjs dados [--force] [--so etapas] | verificar | painel (veio "${modo ?? ''}")`);
