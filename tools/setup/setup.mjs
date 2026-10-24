#!/usr/bin/env node
// Script de início do RushDaily: baixa/gera tudo que não é código do projeto (dados, cartas, artes, bibliotecas, Enigma).
//   npm run setup                         # tudo; pula o que já existe
//   npm run setup -- --force              # refaz tudo
//   npm run setup -- --so rush            # só uma etapa (várias: --so three,rush)
//   npm run setup -- --temporadas 2       # libera as temporadas 1..2 do clássico (padrão 1)
//   npm run setup -- --sem-render         # não desenha as imagens das cartas (Rush e clássicas)
//   npm run setup -- --lista              # mostra as etapas
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { copyFileSync, existsSync, mkdirSync, readFileSync, readdirSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { aplicar } from './patch-ocgcore.mjs';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const p = (...partes) => join(ROOT, ...partes);
const LIBS = p('tools/setup/libs');
const CLASSIC = p('tools/classic');
const RENDER_CL = p('tools/classic/render');
const ENIGMA_CACHE = p('tools/setup/cache/enigma');
mkdirSync(p('src/vendor'), { recursive: true });
const SHA_YGO_CARD = '92462bbd2aa3aa0075ebcc9b633bdc05137fd7ac'; // mesmo commit de tools/card-render/render.py

// ---- argumentos ----
const args = process.argv.slice(2);
const tem = (nome) => args.includes(nome);
const valor = (nome) => (args.includes(nome) ? args[args.indexOf(nome) + 1] : undefined);
const force = tem('--force');
const semRender = tem('--sem-render');
const temporadas = Number(valor('--temporadas') ?? 1);
const so = valor('--so')?.split(',');
if (!Number.isInteger(temporadas) || temporadas < 1 || temporadas > 5) fim('--temporadas deve ser de 1 a 5.');

// ---- utilidades ----
function fim(msg) { console.error(`\nERRO: ${msg}`); process.exit(1); }
const log = (msg) => console.log(`   ${msg}`);
function rodar(cmd, cmdArgs, { cwd = ROOT, env = {}, ok = [0] } = {}) {
  console.log(`   $ ${[cmd, ...cmdArgs].join(' ').replaceAll(ROOT, '.')}`);
  const r = spawnSync(cmd, cmdArgs, { cwd, stdio: 'inherit', env: { ...process.env, ...env } });
  if (r.error || !ok.includes(r.status)) fim(`o comando falhou (${cmd} ${cmdArgs.slice(0, 2).join(' ')}...). Veja a mensagem acima e rode de novo: o setup retoma de onde parou.`);
}
const saida = (cmd, cmdArgs, env = {}) => spawnSync(cmd, cmdArgs, { encoding: 'utf8', env: { ...process.env, ...env } });
const py = (script, ...resto) => rodar('python3', [script, ...resto]);
// O importador clássico usa -I (modo isolado), como no README.
const classico = (...resto) => rodar('python3', ['-I', 'tools/classic/import_cards.py', ...resto]);
const rush = (...resto) => rodar('python3', ['-I', 'tools/rush/import_rush.py', ...resto]);
const existe = (...partes) => existsSync(p(...partes));
const arquivos = (dir, re) => (existsSync(dir) ? readdirSync(dir).filter((n) => re.test(n)) : []);

/** Clone sparse sem histórico, fixado em um commit. */
function baixarRepo(url, destino, commit, pastas) {
  if (pastas.every((pasta) => existsSync(join(destino, pasta)))) return;
  mkdirSync(destino, { recursive: true });
  const git = (...a) => rodar('git', ['-C', destino, ...a]);
  if (!existsSync(join(destino, '.git'))) { rodar('git', ['init', '-q', destino]); git('remote', 'add', 'origin', url); }
  git('sparse-checkout', 'set', ...pastas);
  git('fetch', '-q', '--depth', '1', '--filter=blob:none', 'origin', commit);
  git('checkout', '-q', '--force', 'FETCH_HEAD');
}

// ---- dependências ----
function dependencias() {
  const faltas = [];
  const exige = (nome, ok, dica) => { if (!ok) faltas.push(`${nome}: ${dica}`); };
  const versao = (cmd) => saida(cmd, ['--version']);
  const node = Number(process.versions.node.split('.')[0]);
  exige('Node.js 22+', node >= 22, `versão atual ${process.versions.node}. Instale o Node 22 ou mais novo (https://nodejs.org).`);
  exige('npm', versao('npm').status === 0, 'vem com o Node.js.');
  exige('python3', versao('python3').status === 0, 'pacman -S python | apt install python3');
  exige('Pillow', saida('python3', ['-c', 'import PIL']).status === 0, 'pacman -S python-pillow | apt install python3-pil | pip install Pillow');
  exige('numpy (Enigma)', saida('python3', ['-c', 'import numpy']).status === 0, 'pacman -S python-numpy | apt install python3-numpy | pip install numpy');
  exige('sqlite3 (módulo do Python)', saida('python3', ['-c', 'import sqlite3']).status === 0, 'o Python precisa vir com sqlite3 (apt install libsqlite3-dev e reinstale o Python, ou use o pacote da distribuição).');
  exige('git', versao('git').status === 0, 'pacman -S git | apt install git');
  exige('curl', versao('curl').status === 0, 'pacman -S curl | apt install curl');
  exige('ImageMagick (comando magick)', versao('magick').status === 0, 'pacman -S imagemagick | apt install imagemagick (versão 7, com o comando "magick")');
  if (faltas.length) fim(`faltam dependências:\n  - ${faltas.join('\n  - ')}`);
  log('dependências ok');
}

// ---- etapas ----
const ETAPAS = [
  {
    nome: 'three', desc: 'Three.js r170 (npm) -> src/vendor/three.module.js (MIT)',
    pronto: () => existe('src/vendor/three.module.js'),
    run() { npmLibs(); copyFileSync(join(LIBS, 'node_modules/three/build/three.module.js'), p('src/vendor/three.module.js')); },
  },
  {
    nome: 'qrcode', desc: 'qrcode-generator 2.0.4 (npm) -> src/vendor/qrcode/qrcode.mjs (MIT; QR do link de sincronização)',
    pronto: () => existe('src/vendor/qrcode/qrcode.mjs') && existe('src/vendor/qrcode/LICENSE'),
    run() {
      npmLibs();
      mkdirSync(p('src/vendor/qrcode'), { recursive: true });
      const fonte = join(LIBS, 'node_modules/qrcode-generator/dist/qrcode.mjs');
      copyFileSync(fonte, p('src/vendor/qrcode/qrcode.mjs'));
      // O pacote não traz arquivo LICENSE: a licença MIT está só no cabeçalho do código. Gravamos o texto ao lado.
      if (!/Licensed under the MIT license/.test(readFileSync(fonte, 'utf8').slice(0, 600))) throw new Error('qrcode-generator: cabeçalho MIT não encontrado (pacote mudou?)');
      writeFileSync(p('src/vendor/qrcode/LICENSE'), `MIT License (qrcode-generator 2.0.4, https://github.com/kazuhikoarase/qrcode-generator)\n\nCopyright (c) 2009 Kazuhiko Arase\n\nPermission is hereby granted, free of charge, to any person obtaining a copy of this software and associated documentation files (the "Software"), to deal in the Software without restriction, including without limitation the rights to use, copy, modify, merge, publish, distribute, sublicense, and/or sell copies of the Software, and to permit persons to whom the Software is furnished to do so, subject to the following conditions:\n\nThe above copyright notice and this permission notice shall be included in all copies or substantial portions of the Software.\n\nTHE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY, FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM, OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE SOFTWARE.\n\nThe word "QR Code" is a registered trademark of DENSO WAVE INCORPORATED.\n`);
    },
  },
  {
    nome: 'ocgcore', desc: 'ocgcore-wasm 0.1.6 (npm) + patch do parser -> src/vendor/ocgcore/ (MIT; núcleo AGPL-3.0)',
    pronto: () => existe('src/vendor/ocgcore/index.js') && existe('src/vendor/ocgcore/LICENSE.md') && existe('src/vendor/ocgcore/ocgcore.wasm'),
    run() {
      npmLibs();
      const pacote = join(LIBS, 'node_modules/ocgcore-wasm');
      const destino = p('src/vendor/ocgcore');
      rmSync(destino, { recursive: true, force: true });
      mkdirSync(destino, { recursive: true });
      for (const nome of arquivos(join(pacote, 'dist'), /\.js$/)) copyFileSync(join(pacote, 'dist', nome), join(destino, nome));
      const { codigo, log: feito } = aplicar(readFileSync(join(destino, 'index.js'), 'utf8'));
      writeFileSync(join(destino, 'index.js'), codigo);
      log(`patch: ${feito.join('; ')}`);
      // .wasm cru (938 KB; ~333 KB gzip, 259 KB brotli) para o navegador baixar sem o base64 de 1,28 MB; a arena passa os bytes em wasmBinary.
      // O .js com o base64 fica para o Node (testes e simulate.mjs). O build JSPI (1,2 MB) nunca é usado: sai.
      const embutido = arquivos(destino, /^ocgcore\.sync-.*\.js$/).map((nome) => readFileSync(join(destino, nome), 'utf8').match(/\bA\("([A-Za-z0-9+/=]{1000,})"\)/)).find(Boolean);
      if (!embutido) throw new Error('ocgcore: não achei o WASM embutido em ocgcore.sync-*.js (pacote mudou?)');
      writeFileSync(join(destino, 'ocgcore.wasm'), Buffer.from(embutido[1], 'base64'));
      for (const nome of arquivos(destino, /^ocgcore\.jspi-.*\.js$/)) rmSync(join(destino, nome));
      log('ocgcore.wasm gravado; build JSPI removido');
      writeFileSync(join(destino, 'LICENSE.md'), `${readFileSync(join(pacote, 'LICENSE.md'), 'utf8').trimEnd()}\n\nPatch local (RushDaily, tools/setup/patch-ocgcore.mjs): o parser de consulta (função Q em index.js) ganhou o campo TYPE\ne passa a pular campos desconhecidos (e.off+=o), senão duelQueryLocation desalinha. Também: COUNTERS com tipo e quantidade\nna ordem certa, mensagem ilegível descartada sem perder o lote de duelGetMessage e SORT_CARD/SORT_CHAIN sem o byte de tamanho.\nO núcleo (EDOPro/ygopro-core) é AGPL-3.0: o texto está em COPYING-AGPL-3.0 nesta pasta.\n`);
    },
  },
  {
    nome: 'yugioh', desc: 'yugioh-card (kooriookami, MIT): bundle e molduras reduzidas (clássica e Rush) -> src/vendor/yugioh-card/',
    // A moldura Rush (rush-duel) entrou depois: cache antigo sem ela refaz o bundle.
    pronto: () => existe('src/vendor/yugioh-card/yugioh-card.js') && existe('src/vendor/yugioh-card/assets/yugioh/font/font-list.json') && existe('src/vendor/yugioh-card/assets/rush-duel/font/font-list.json'),
    run() {
      baixarMolduras();
      npmRender();
      rodar('npm', ['run', 'bundle'], { cwd: RENDER_CL });
      const licenca = join(RENDER_CL, 'node_modules/yugioh-card/LICENSE');
      if (existsSync(licenca)) copyFileSync(licenca, p('src/vendor/yugioh-card/LICENSE'));
    },
  },
  {
    nome: 'rush', desc: 'Cartas Rush: Yugipedia/yaml-yugi (escolha e artes) -> src/data/cards.mjs',
    pronto: () => existe('src/data/cards.mjs'),
    run() { py('tools/card-render/import_pool.py', 'fetch'); py('tools/card-render/import_pool.py', 'build'); },
  },
  {
    nome: 'rush-render', desc: 'Desenha as frentes Rush em PT-BR (molduras e fontes do rush-hub) -> src/assets/cards/',
    render: true,
    pronto: () => false, // render.py já pula as cartas desenhadas
    run() { py('tools/card-render/render.py', ...(force ? ['--force'] : [])); },
  },
  {
    nome: 'classico', desc: 'Pool clássico: YGOPRODeck, BabelCDB, CardScripts, decks e puzzles -> src/data/classic, src/vendor/card-scripts, artes',
    pronto: () => false, // cada passo abaixo se pula sozinho
    run() {
      const cache = (nome) => existe('tools/classic/cache', nome);
      if (force || !cache('cards.cdb') || !cache('ygopro-pt.json') || !existe('tools/classic/cache/CardScripts/official')) classico('fetch');
      else log('fetch: cache já existe');
      if (force || !cache('decks.json')) classico('decks'); else log('decks: cache já existe');
      if (force || !existe('src/data/classic', `s${temporadas}.json`) || !existe('src/vendor/card-scripts/index.json') || !existe('src/vendor/card-scripts/official')) classico('build', '--ate', String(temporadas));
      else log(`build: temporadas 1..${temporadas} já geradas`);
      if (force || !existe('src/data/classic/puzzles.json')) classico('puzzles'); else log('puzzles: já gerados');
      classico('art'); // pula as artes já convertidas
    },
  },
  {
    nome: 'rush-ocg', desc: 'Rush Duel no motor do EDOPro: BabelCDB (cards-rush.cdb) e CardScripts (rush/) -> src/data/rush/cards.json, src/vendor/card-scripts/rush/',
    pronto: () => existe('src/data/rush/cards.json') && existe('src/vendor/card-scripts/rush/index.json') && existe('src/vendor/card-scripts/constant.lua'),
    run() {
      if (force || !existe('tools/rush/cache/cards-rush.cdb') || !existe('tools/rush/cache/CardScripts/rush')) rush('fetch');
      else log('fetch: cache já existe');
      rush('build');
    },
  },
  {
    nome: 'classico-render', desc: 'Desenha as cartas clássicas pré-desenhadas (miniaturas) -> src/assets/classic-cards/',
    render: true,
    pronto: () => false,
    run() {
      baixarMolduras();
      npmRender(true);
      rodar('node', ['tools/classic/render/render.mjs', ...(force ? ['--force'] : [])]);
    },
  },
  {
    nome: 'miniaturas', desc: 'Miniaturas webp das cartas (Rush 316 px, clássicas 140 px) -> src/assets/cards-sm, src/assets/classic-cards-sm',
    render: true,
    pronto: () => false, // thumbs.py pula as que já existem
    run() { py('tools/setup/thumbs.py', ...(force ? ['--force'] : [])); },
  },
  {
    nome: 'enigma', desc: 'Enigma do Milênio: STL do Printables 517699 (CC BY-NC-SA) -> src/assets/puzzle/',
    pronto: () => existe('src/assets/puzzle/puzzle.bin') && existe('src/assets/puzzle/puzzle.json'),
    async run() {
      await baixarEnigma();
      // fast-simplification (opcional) reduz a argola de 40k para ~5k triângulos; instalado só em cache/, sem mexer no Python do sistema.
      const pylibs = p('tools/setup/cache/pylibs');
      const env = { PYTHONPATH: pylibs };
      if (saida('python3', ['-c', 'import fast_simplification'], env).status !== 0) {
        spawnSync('python3', ['-m', 'pip', 'install', '-q', '--no-deps', '--target', pylibs, 'fast-simplification'], { stdio: 'inherit' });
        if (saida('python3', ['-c', 'import fast_simplification'], env).status !== 0) log('aviso: sem fast-simplification, a argola do Enigma fica mais pesada (~950 KB em vez de ~350 KB). Opcional: pip install fast-simplification');
      }
      rodar('python3', ['tools/puzzle/build_puzzle.py', ENIGMA_CACHE, 'src/assets/puzzle'], { env });
    },
  },
  {
    nome: 'vendor-avisos', desc: 'Textos de licença (Three.js, yugioh-card, qrcode-generator, AGPL do ocgcore/CardScripts) e src/vendor/CHECKSUMS.txt',
    pronto: () => false, // barato: sempre reescreve
    run() { avisosVendor(); },
  },
];

// ---- passos compartilhados ----
// Licenças ao lado de cada biblioteca e SHA-256 dos arquivos de src/vendor (confere se algo foi trocado).
function avisosVendor() {
  const copia = (de, para) => { if (existsSync(de)) { copyFileSync(de, p(para)); log(`licença: ${para}`); } else log(`aviso: ${de} não existe (rode a etapa correspondente)`); };
  copia(join(LIBS, 'node_modules/three/LICENSE'), 'src/vendor/LICENSE-three.txt');
  copia(join(RENDER_CL, 'node_modules/yugioh-card/LICENSE'), 'src/vendor/yugioh-card/LICENSE');
  copia(p('src/vendor/card-scripts/COPYING'), 'src/vendor/ocgcore/COPYING-AGPL-3.0'); // mesmo texto da AGPL-3.0
  const arquivos = [];
  const anda = (dir) => {
    for (const e of readdirSync(dir, { withFileTypes: true })) {
      const rel = join(dir, e.name);
      if (e.isDirectory()) { if (!['official', 'rush', 'assets'].includes(e.name)) anda(rel); } else if (e.name !== 'CHECKSUMS.txt') arquivos.push(rel);
    }
  };
  anda(p('src/vendor'));
  const sha = existsSync(p('tools/classic/CARDSCRIPTS_SHA')) ? readFileSync(p('tools/classic/CARDSCRIPTS_SHA'), 'utf8').trim() : '?';
  const linhas = arquivos.sort().map((f) => `${createHash('sha256').update(readFileSync(f)).digest('hex')}  ${f.slice(p('src/vendor').length + 1)}`);
  writeFileSync(p('src/vendor/CHECKSUMS.txt'), `# SHA-256 dos arquivos de src/vendor (sem card-scripts/official, card-scripts/rush e assets/). CardScripts no commit ${sha}.\n# Conferir: cd src/vendor && sha256sum -c --ignore-missing CHECKSUMS.txt\n${linhas.join('\n')}\n`);
  log(`CHECKSUMS.txt: ${linhas.length} arquivos`);
}
function npmLibs() {
  if (['three', 'ocgcore-wasm', 'qrcode-generator'].every((nome) => existsSync(join(LIBS, 'node_modules', nome)))) return;
  rodar('npm', ['install', '--no-audit', '--no-fund', '--ignore-scripts'], { cwd: LIBS });
}

let renderInstalado = false;
function npmRender(comSkia = false) {
  if (!existsSync(join(RENDER_CL, 'node_modules/esbuild'))) {
    rodar('npm', ['ci', '--no-audit', '--no-fund', '--ignore-scripts'], { cwd: RENDER_CL });
  }
  // O skia-canvas (desenho em Node) baixa um binário no script de instalação, que o --ignore-scripts pulou.
  if (comSkia && !renderInstalado) {
    const r = spawnSync('node', ['--input-type=module', '-e', "await import('skia-canvas')"], { cwd: RENDER_CL, encoding: 'utf8' });
    // O npm 11+ bloqueia scripts de instalação sem aprovação; rodamos o que o install do skia-canvas faria (baixa o binário).
    if (r.status !== 0) rodar(join(RENDER_CL, 'node_modules/.bin/node-pre-gyp'), ['install'], { cwd: join(RENDER_CL, 'node_modules/skia-canvas') });
  }
  renderInstalado = renderInstalado || comSkia;
}

function baixarMolduras() {
  // Só as pastas "yugioh" (clássica) e "rush-duel" (molduras e fontes) são usadas; o cache tem o formato que os render.mjs esperam.
  const repo = p('tools/classic/cache/yugioh-card');
  baixarRepo('https://github.com/kooriookami/yugioh-card', repo, SHA_YGO_CARD, ['src/assets/yugioh-card/yugioh', 'src/assets/yugioh-card/rush-duel']);
  const ponte = p('tools/classic/cache/yugioh-card-assets');
  if (!existsSync(ponte)) symlinkSync(join(repo, 'src/assets/yugioh-card'), ponte, 'dir');
}

async function baixarEnigma() {
  const api = 'https://api.printables.com/graphql/';
  const gql = async (query, variables) => {
    const r = await fetch(api, { method: 'POST', headers: { 'content-type': 'application/json', 'user-agent': 'RushDaily/0.2 (projeto pessoal, sem fins comerciais)' }, body: JSON.stringify({ query, variables }) });
    if (!r.ok) throw new Error(`Printables respondeu ${r.status}`);
    const corpo = await r.json();
    if (corpo.errors) throw new Error(`Printables: ${JSON.stringify(corpo.errors)}`);
    return corpo.data;
  };
  try {
    const lista = (await gql('query{ print(id:"517699"){ stls{ id name } } }')).print.stls;
    // As peças originais são "..._NN.stl" (as "_v2" vêm fora da posição de montagem e o build as ignora).
    const partes = lista.filter((f) => /_\d\d\.stl$/.test(f.name));
    if (partes.length !== 39) throw new Error(`esperava 39 peças, o Printables lista ${partes.length}`);
    mkdirSync(ENIGMA_CACHE, { recursive: true });
    let n = 0;
    for (const f of partes) {
      const destino = join(ENIGMA_CACHE, f.name);
      n += 1;
      if (existsSync(destino)) continue;
      const link = (await gql('mutation($id:ID!){ getDownloadLink(id:$id, printId:"517699", fileType:stl, source:model_detail){ ok output{ link } } }', { id: f.id })).getDownloadLink.output?.link;
      if (!link) throw new Error(`sem link de download para ${f.name}`);
      const r = await fetch(link);
      if (!r.ok) throw new Error(`download de ${f.name}: ${r.status}`);
      writeFileSync(destino, Buffer.from(await r.arrayBuffer()));
      if (process.stdout.isTTY) process.stdout.write(`\r   baixando peças do Enigma ${n}/${partes.length}`);
      else if (n % 10 === 0 || n === partes.length) log(`peças do Enigma ${n}/${partes.length}`);
      await new Promise((ok) => setTimeout(ok, 300)); // sem pressa: são 39 arquivos pequenos
    }
    if (process.stdout.isTTY) process.stdout.write('\n');
  } catch (erro) {
    fim(`não consegui baixar o Enigma do Printables (${erro.message}).\n  Alternativa manual: baixe os STL de https://www.printables.com/model/517699 para ${ENIGMA_CACHE} e rode: npm run setup -- --so enigma`);
  }
}

// ---- execução ----
if (tem('--lista')) {
  for (const e of ETAPAS) console.log(`${e.nome.padEnd(16)} ${e.desc}`);
  process.exit(0);
}
if (so) for (const nome of so) if (!ETAPAS.some((e) => e.nome === nome)) fim(`etapa desconhecida: ${nome}. Use --lista.`);

const inicio = Date.now();
console.log(`RushDaily: setup${force ? ' (--force)' : ''}, temporadas 1..${temporadas}${semRender ? ', sem render' : ''}\n`);
console.log('[0] dependências');
dependencias();

const resumo = [];
for (const [i, etapa] of ETAPAS.entries()) {
  if (so && !so.includes(etapa.nome)) continue;
  if (semRender && etapa.render) { resumo.push(`${etapa.nome}: ignorada (--sem-render)`); continue; }
  console.log(`\n[${i + 1}/${ETAPAS.length}] ${etapa.nome}: ${etapa.desc}`);
  if (!force && etapa.pronto()) { log('já pronto, pulando (use --force para refazer)'); resumo.push(`${etapa.nome}: já pronta`); continue; }
  const t = Date.now();
  await etapa.run();
  resumo.push(`${etapa.nome}: ok (${Math.round((Date.now() - t) / 1000)}s)`);
}
console.log(`\nResumo:\n  ${resumo.join('\n  ')}\n\nTempo total: ${Math.round((Date.now() - inicio) / 1000)}s. Próximo passo: npm test e npm run serve`);
