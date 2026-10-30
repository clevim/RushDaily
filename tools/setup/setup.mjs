#!/usr/bin/env node
// Script de início do RushDaily: baixa/gera tudo que não é código do projeto (dados, cartas, artes, bibliotecas, Enigma).
//   npm run setup                         # tudo; pula o que já existe e refaz o que ficou desatualizado
//   npm run setup -- --force              # refaz tudo
//   npm run setup -- --so rush-ocg        # só uma etapa (várias: --so three,rush-ocg)
//   npm run setup -- --temporadas 2       # libera as temporadas 1..2 do clássico (padrão: as já liberadas, ou 1)
//   npm run setup -- --sem-render         # não desenha as imagens das cartas (Rush e clássicas)
//   npm run setup -- --paralelo 4         # até N etapas ao mesmo tempo (padrão 4); --sequencial = uma por vez, na ordem da lista
//   npm run setup -- --verificar [--json] # só mostra o que está pronto, desatualizado ou faltando (e por quê), sem rodar nada
//   npm run setup -- --lista              # mostra as etapas
//
// Regeração automática: cada etapa declara as fontes (arquivos do repositório que determinam a saída), uma versao (inteiro
// para forçar à mão), as opções que mudam a saída e as etapas de que depende. A impressão (sha256 disso tudo, com as
// impressões das dependências) de cada etapa concluída fica em tools/setup/cache/estado.json (fora do git; no contêiner,
// no volume de dados). Impressão diferente da gravada = etapa desatualizada: refaz só ela (com o "refazer" dela, mais
// barato que o --force) e, em cascata, o que depende dela. Sem registro mas já pronta (clone ou volume antigo): adota a
// impressão atual sem refazer nada.
import { spawn, spawnSync } from 'node:child_process';
import { AsyncLocalStorage } from 'node:async_hooks';
import { createHash } from 'node:crypto';
import { copyFileSync, existsSync, lstatSync, mkdirSync, readFileSync, readdirSync, renameSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { basename, dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { aplicar } from './patch-ocgcore.mjs';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const p = (...partes) => join(ROOT, ...partes);
const LIBS = p('tools/setup/libs');
const CLASSIC = p('tools/classic');
const RENDER_CL = p('tools/classic/render');
const ENIGMA_CACHE = p('tools/setup/cache/enigma');
const ESTADO = p('tools/setup/cache/estado.json'); // impressões das etapas concluídas (ignorado pelo git: tools/**/cache)
const SHA_YGO_CARD = '92462bbd2aa3aa0075ebcc9b633bdc05137fd7ac'; // molduras e fontes do yugioh-card (clássicas e Rush)
const CARDSCRIPTS_SHA = 'tools/classic/CARDSCRIPTS_SHA';

// ---- argumentos ----
const args = process.argv.slice(2);
const tem = (nome) => args.includes(nome);
const valor = (nome) => (args.includes(nome) ? args[args.indexOf(nome) + 1] : undefined);
const force = tem('--force');
const semRender = tem('--sem-render');
// Sem --temporadas, mantém as já liberadas (src/data/classic/seasons.json): rodar sem a opção não desliga temporadas.
function temporadasLiberadas() {
  try { return JSON.parse(readFileSync(p('src/data/classic/seasons.json'), 'utf8')).filter((s) => s.enabled).length || 1; } catch { return 1; }
}
const temporadas = Number(valor('--temporadas') ?? temporadasLiberadas());
const so = valor('--so')?.split(',');
const paralelo = tem('--sequencial') ? 1 : Number(valor('--paralelo') ?? 4);
if (!Number.isInteger(temporadas) || temporadas < 1 || temporadas > 5) fim('--temporadas deve ser de 1 a 5.');
if (!Number.isInteger(paralelo) || paralelo < 1 || paralelo > 16) fim('--paralelo deve ser de 1 a 16.');

// ---- utilidades ----
function fim(msg) { console.error(`\nERRO: ${msg}`); process.exit(1); }
// Cada etapa roda dentro de um contexto com o nome dela: as linhas (do setup e dos comandos) saem prefixadas, "[rush-ocg] ...".
const contexto = new AsyncLocalStorage();
const prefixo = () => { const nome = contexto.getStore()?.nome; return nome ? `[${nome}] ` : '   '; };
const log = (msg) => console.log(`${prefixo()}${msg}`);
const filhos = new Set(); // processos em andamento (encerrados juntos se o setup for interrompido)
/** Roda um comando sem shell, com a saída repassada linha a linha com o prefixo da etapa. Rejeita se a saída não estiver em ok. */
function rodar(cmd, cmdArgs, { cwd = ROOT, env = {}, ok = [0] } = {}) {
  const pre = prefixo();
  console.log(`${pre}$ ${[cmd, ...cmdArgs].join(' ').replaceAll(ROOT, '.')}`);
  return new Promise((resolve, reject) => {
    // PYTHONUNBUFFERED: sem ele o Python segura a saída num cano e o progresso (N/M) só aparece no fim.
    const filho = spawn(cmd, cmdArgs, { cwd, stdio: ['ignore', 'pipe', 'pipe'], env: { ...process.env, PYTHONUNBUFFERED: '1', ...env } });
    filhos.add(filho);
    for (const [fluxo, destino] of [[filho.stdout, process.stdout], [filho.stderr, process.stderr]]) {
      let resto = '';
      fluxo.setEncoding('utf8');
      // \r também quebra a linha: barras de progresso que se reescrevem viram linhas (o painel lê o N/M de cada uma).
      fluxo.on('data', (d) => { const partes = (resto + d).split(/\r?\n|\r/); resto = partes.pop(); for (const l of partes) if (l.trim()) destino.write(`${pre}${l}\n`); });
      fluxo.on('end', () => { if (resto.trim()) destino.write(`${pre}${resto}\n`); });
    }
    filho.on('error', (e) => { filhos.delete(filho); reject(new Error(`não consegui rodar ${cmd}: ${e.message}`)); });
    filho.on('close', (codigo, sinal) => {
      filhos.delete(filho);
      if (ok === true || ok.includes(codigo)) resolve(codigo);
      else reject(new Error(`o comando falhou (${cmd} ${cmdArgs.slice(0, 2).join(' ')}...: ${sinal ? `sinal ${sinal}` : `saída ${codigo}`})`));
    });
  });
}
const saida = (cmd, cmdArgs, env = {}) => spawnSync(cmd, cmdArgs, { encoding: 'utf8', env: { ...process.env, ...env } });
const py = (script, ...resto) => rodar('python3', [script, ...resto]);
// O importador clássico usa -I (modo isolado), como no README.
const classico = (...resto) => rodar('python3', ['-I', 'tools/classic/import_cards.py', ...resto]);
const rush = (...resto) => rodar('python3', ['-I', 'tools/rush/import_rush.py', ...resto]);
const existe = (...partes) => existsSync(p(...partes));
const arquivos = (dir, re) => (existsSync(dir) ? readdirSync(dir).filter((n) => re.test(n)) : []);

// Trava por nome: o que mexe no mesmo lugar (npm de tools/setup/libs, npm de tools/classic/render, clone das molduras,
// src/vendor/card-scripts) roda um de cada vez, mesmo com as etapas em paralelo.
const travas = new Map();
function trava(nome, fn) {
  const vez = (travas.get(nome) ?? Promise.resolve()).then(fn);
  travas.set(nome, vez.catch(() => {}));
  return vez;
}

/** Clone sparse sem histórico, fixado em um commit (trocou o commit: baixa de novo). */
async function baixarRepo(url, destino, commit, pastas) {
  const head = existsSync(join(destino, '.git')) ? saida('git', ['-C', destino, 'rev-parse', 'HEAD']).stdout?.trim() : '';
  if (head === commit && pastas.every((pasta) => existsSync(join(destino, pasta)))) return;
  mkdirSync(destino, { recursive: true });
  const git = (...a) => rodar('git', ['-C', destino, ...a]);
  if (!existsSync(join(destino, '.git'))) { await rodar('git', ['init', '-q', destino]); await git('remote', 'add', 'origin', url); }
  await git('sparse-checkout', 'set', ...pastas);
  await git('fetch', '-q', '--depth', '1', '--filter=blob:none', 'origin', commit);
  await git('checkout', '-q', '--force', 'FETCH_HEAD');
}

// ---- dependências ----
// O que cada etapa exige: com --so, só confere as das etapas pedidas (ex.: `--so ocgcore,rush-ocg` no workflow não pede ImageMagick nem Pillow).
const DEPS = {
  three: ['npm'], qrcode: ['npm'], ocgcore: ['npm'], yugioh: ['npm', 'git', 'magick'],
  classico: ['python3', 'pillow', 'sqlite3', 'git', 'curl'], 'rush-ocg': ['python3', 'sqlite3', 'git', 'curl'], 'rush-art': ['python3', 'pillow', 'curl'],
  'rush-cartas': ['npm', 'git'], 'classico-render': ['npm', 'git'], miniaturas: ['python3', 'pillow'], enigma: ['python3', 'numpy'], 'vendor-avisos': [],
};
function dependencias(etapas) {
  const faltas = [];
  const pede = new Set(etapas.flatMap((nome) => DEPS[nome] ?? Object.values(DEPS).flat()));
  const exige = (nome, chave, ok, dica) => { if (pede.has(chave) && !ok()) faltas.push(`${nome}: ${dica}`); };
  const versao = (cmd) => saida(cmd, ['--version']);
  const node = Number(process.versions.node.split('.')[0]);
  if (node < 22) faltas.push(`Node.js 22+: versão atual ${process.versions.node}. Instale o Node 22 ou mais novo (https://nodejs.org).`);
  exige('npm', 'npm', () => versao('npm').status === 0, 'vem com o Node.js.');
  exige('python3', 'python3', () => versao('python3').status === 0, 'pacman -S python | apt install python3');
  exige('Pillow', 'pillow', () => saida('python3', ['-c', 'import PIL']).status === 0, 'pacman -S python-pillow | apt install python3-pil | pip install Pillow');
  exige('numpy (Enigma)', 'numpy', () => saida('python3', ['-c', 'import numpy']).status === 0, 'pacman -S python-numpy | apt install python3-numpy | pip install numpy');
  exige('sqlite3 (módulo do Python)', 'sqlite3', () => saida('python3', ['-c', 'import sqlite3']).status === 0, 'o Python precisa vir com sqlite3 (apt install libsqlite3-dev e reinstale o Python, ou use o pacote da distribuição).');
  exige('git', 'git', () => versao('git').status === 0, 'pacman -S git | apt install git');
  exige('curl', 'curl', () => versao('curl').status === 0, 'pacman -S curl | apt install curl');
  exige('ImageMagick (comando magick)', 'magick', () => versao('magick').status === 0, 'pacman -S imagemagick | apt install imagemagick (versão 7, com o comando "magick")');
  if (faltas.length) fim(`faltam dependências:\n  - ${faltas.join('\n  - ')}`);
  log('dependências ok');
}

// ---- etapas ----
// Campos de cada etapa:
//   pronto()   pode pular a etapa inteira (false = sempre roda; os comandos dela pulam o que já existe)
//   gerado()   já tem saída (para o --verificar e para adotar a impressão sem registro); padrão: pronto()
//   fontes     arquivos do repositório que determinam a saída (mudou um = etapa desatualizada). Nunca liste um arquivo
//              que o próprio setup reescreve (ex.: tools/classic/puzzle-solutions.json), senão ela nunca fica em dia.
//   versao     inteiro: suba para forçar a regeração quando a mudança não está num arquivo listado
//   opcoes()   opções que mudam a saída (ex.: temporadas do clássico, commit fixado do yugioh-card)
//   depende    etapas cuja mudança obriga a refazer esta (entram na impressão) e que rodam antes dela
//   apos       etapas que só precisam rodar antes (não entram na impressão)
//   host       site com limite de pedidos: duas etapas do mesmo host nunca rodam juntas
//   refaz      o que o "refazer" (etapa desatualizada) faz, para o log e o --verificar
//   run(ctx)   ctx.refazer = desatualizada; ctx.mudou = fontes (caminhos) que mudaram desde o registro
const ETAPAS = [
  {
    nome: 'three', desc: 'Three.js r170 (npm) -> src/vendor/three.module.js (MIT)',
    fontes: ['tools/setup/libs/package.json', 'tools/setup/libs/package-lock.json'], versao: 1,
    refaz: 'copia de novo (npm install se o package-lock mudou)',
    pronto: () => existe('src/vendor/three.module.js'),
    async run({ mudou }) { await comLibs(mudou, () => copyFileSync(join(LIBS, 'node_modules/three/build/three.module.js'), p('src/vendor/three.module.js'))); },
  },
  {
    nome: 'qrcode', desc: 'qrcode-generator 2.0.4 (npm) -> src/vendor/qrcode/qrcode.mjs (MIT; QR do link de sincronização)',
    fontes: ['tools/setup/libs/package.json', 'tools/setup/libs/package-lock.json'], versao: 1,
    refaz: 'copia de novo (npm install se o package-lock mudou)',
    pronto: () => existe('src/vendor/qrcode/qrcode.mjs') && existe('src/vendor/qrcode/LICENSE'),
    async run({ mudou }) {
      await comLibs(mudou, () => {
        mkdirSync(p('src/vendor/qrcode'), { recursive: true });
        const fonte = join(LIBS, 'node_modules/qrcode-generator/dist/qrcode.mjs');
        copyFileSync(fonte, p('src/vendor/qrcode/qrcode.mjs'));
        // O pacote não traz arquivo LICENSE: a licença MIT está só no cabeçalho do código. Gravamos o texto ao lado.
        if (!/Licensed under the MIT license/.test(readFileSync(fonte, 'utf8').slice(0, 600))) throw new Error('qrcode-generator: cabeçalho MIT não encontrado (pacote mudou?)');
        writeFileSync(p('src/vendor/qrcode/LICENSE'), `MIT License (qrcode-generator 2.0.4, https://github.com/kazuhikoarase/qrcode-generator)\n\nCopyright (c) 2009 Kazuhiko Arase\n\nPermission is hereby granted, free of charge, to any person obtaining a copy of this software and associated documentation files (the "Software"), to deal in the Software without restriction, including without limitation the rights to use, copy, modify, merge, publish, distribute, sublicense, and/or sell copies of the Software, and to permit persons to whom the Software is furnished to do so, subject to the following conditions:\n\nThe above copyright notice and this permission notice shall be included in all copies or substantial portions of the Software.\n\nTHE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY, FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM, OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE SOFTWARE.\n\nThe word "QR Code" is a registered trademark of DENSO WAVE INCORPORATED.\n`);
      });
    },
  },
  {
    nome: 'ocgcore', desc: 'ocgcore-wasm 0.1.6 (npm) + patch do parser -> src/vendor/ocgcore/ (MIT; núcleo AGPL-3.0)',
    fontes: ['tools/setup/patch-ocgcore.mjs', 'tools/setup/libs/package.json', 'tools/setup/libs/package-lock.json'], versao: 1,
    refaz: 'copia e aplica o patch de novo (npm install se o package-lock mudou)',
    pronto: () => existe('src/vendor/ocgcore/index.js') && existe('src/vendor/ocgcore/LICENSE.md') && existe('src/vendor/ocgcore/ocgcore.wasm'),
    async run({ mudou }) {
      await comLibs(mudou, () => {
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
      });
    },
  },
  {
    nome: 'yugioh', desc: 'yugioh-card (kooriookami, MIT): bundle e molduras reduzidas (clássica e Rush) -> src/vendor/yugioh-card/',
    fontes: ['tools/classic/render/entry.mjs', 'tools/classic/render/bundle-assets.mjs', 'tools/classic/render/package.json', 'tools/classic/render/package-lock.json'], versao: 1,
    opcoes: () => ({ yugiohCard: SHA_YGO_CARD }),
    refaz: 'bundle e molduras de novo (clone das molduras só se o commit fixado mudou; npm ci só se o package-lock mudou)',
    cedo: true, // as cartas desenhadas esperam por ela
    // A moldura Rush (rush-duel) entrou depois: cache antigo sem ela refaz o bundle.
    pronto: () => existe('src/vendor/yugioh-card/yugioh-card.js') && existe('src/vendor/yugioh-card/assets/yugioh/font/font-list.json') && existe('src/vendor/yugioh-card/assets/rush-duel/font/font-list.json'),
    async run({ mudou }) {
      await baixarMolduras();
      await npmRender({ reinstalar: mudou.has('tools/classic/render/package-lock.json') });
      await rodar('npm', ['run', 'bundle'], { cwd: RENDER_CL });
      const licenca = join(RENDER_CL, 'node_modules/yugioh-card/LICENSE');
      if (existsSync(licenca)) copyFileSync(licenca, p('src/vendor/yugioh-card/LICENSE'));
    },
  },
  {
    nome: 'classico', desc: 'Pool clássico: YGOPRODeck, BabelCDB, CardScripts, decks e puzzles -> src/data/classic, src/vendor/card-scripts, artes',
    // Os rótulos das perguntas do motor saem da gramática do Rush (tools/rush/traducao.py + strings.json).
    fontes: ['tools/classic/import_cards.py', CARDSCRIPTS_SHA, 'tools/rush/traducao.py', 'tools/rush/traducao/strings.json'], versao: 1,
    opcoes: () => ({ temporadas }),
    host: 'ygoprodeck', cedo: true,
    refaz: 'build e puzzles (fetch só se o CARDSCRIPTS_SHA mudou; decks e artes já baixados ficam no cache)',
    pronto: () => false, // cada passo abaixo se pula sozinho
    gerado: () => existe('src/data/classic', `s${temporadas}.json`) && existe('src/data/classic/puzzles.json') && existe('src/vendor/card-scripts/index.json'),
    async run({ refazer, mudou }) {
      const cache = (nome) => existe('tools/classic/cache', nome);
      if (force || mudou.has(CARDSCRIPTS_SHA) || !cache('cards.cdb') || !cache('ygopro-pt.json') || !existe('tools/classic/cache/CardScripts/official')) await classico('fetch');
      else log('fetch: cache já existe');
      if (force || !cache('decks.json')) await classico('decks'); else log('decks: cache já existe');
      // build reescreve os .lua da raiz de src/vendor/card-scripts, que o rush-ocg também copia: um de cada vez.
      if (force || refazer || !existe('src/data/classic', `s${temporadas}.json`) || !existe('src/vendor/card-scripts/index.json') || !existe('src/vendor/card-scripts/official')) await trava('card-scripts', () => classico('build', '--ate', String(temporadas)));
      else log(`build: temporadas 1..${temporadas} já geradas`);
      if (force || refazer || !existe('src/data/classic/puzzles.json')) await classico('puzzles'); else log('puzzles: já gerados');
      await classico('art'); // pula as artes já convertidas
    },
  },
  {
    nome: 'rush-ocg', desc: 'Rush Duel no motor do EDOPro: BabelCDB (cards-rush.cdb) e CardScripts (rush/) -> src/data/rush/cards.json, src/vendor/card-scripts/rush/',
    fontes: ['tools/rush/import_rush.py', CARDSCRIPTS_SHA, 'tools/card-render/pt-br.json', 'tools/card-render/pool-en.json',
      // Memória de tradução (tools/rush/traducao.py): traduzir ou corrigir uma frase refaz o cards.json e as cartas montadas.
      'tools/rush/traducao.py', 'tools/rush/traducao/glossario.json', 'tools/rush/traducao/nomes.json', 'tools/rush/traducao/frases.json',
      'tools/rush/traducao/strings.json'], versao: 1,
    cedo: true, // as artes Rush (a etapa mais longa) esperam por ela
    refaz: 'build (fetch só se o CARDSCRIPTS_SHA mudou)',
    pronto: () => existe('src/data/rush/cards.json') && existe('src/vendor/card-scripts/rush/index.json') && existe('src/vendor/card-scripts/constant.lua'),
    async run({ mudou }) {
      if (force || mudou.has(CARDSCRIPTS_SHA) || !existe('tools/rush/cache/cards-rush.cdb') || !existe('tools/rush/cache/CardScripts/rush')) await rush('fetch');
      else log('fetch: cache já existe');
      await trava('card-scripts', () => rush('build'));
    },
  },
  {
    nome: 'rush-art', desc: 'Artes das cartas Rush do motor: yaml-yugi (nomes dos arquivos) e Yugipedia -> src/assets/rush-art/ (webp 400 px)',
    // Sem fontes de propósito: re-baixar ~3.200 artes a ~3/s leva quase 20 min. Só a versao (subida à mão) força o --force.
    fontes: [], versao: 1, apos: ['rush-ocg'], host: 'yugipedia',
    refaz: 'baixa todas as artes de novo (--force)',
    pronto: () => false, // o comando pula as artes que já existem
    gerado: () => existe('src/assets/rush-art/index.json'),
    async run({ refazer }) {
      // Sem o Yugipedia (fora do ar ou bloqueando) o jogo segue: as cartas saem com o quadro provisório; rode de novo depois.
      await rodar('python3', ['-I', 'tools/rush/import_rush.py', 'art', ...(force || refazer ? ['--force'] : [])], { ok: [0, 3] });
    },
  },
  {
    nome: 'rush-cartas', desc: 'Monta as cartas Rush do motor (moldura do yugioh-card + arte) -> src/assets/rush-cards/, rush-cards-sm/',
    fontes: ['tools/rush/render.mjs', 'src/ui/rush-card-data.js', 'src/data/classic/strings-pt.mjs', 'tools/classic/render/package-lock.json'], versao: 1,
    depende: ['rush-ocg', 'rush-art', 'yugioh'],
    refaz: 'desenha todas as cartas de novo (--force)',
    render: true,
    pronto: () => false, // render.mjs pula as prontas (refaz as que ganharam arte depois)
    gerado: () => existe('src/assets/rush-cards/index.json'),
    async run({ refazer }) {
      await baixarMolduras();
      await npmRender({ skia: true });
      await rodar('node', ['tools/rush/render.mjs', ...(force || refazer ? ['--force'] : [])]);
    },
  },
  {
    nome: 'classico-render', desc: 'Desenha as cartas clássicas pré-desenhadas (miniaturas) -> src/assets/classic-cards/',
    fontes: ['tools/classic/render/render.mjs', 'src/ui/classic-card-data.js', 'tools/classic/render/package-lock.json'], versao: 1,
    depende: ['classico', 'yugioh'],
    refaz: 'desenha todas as cartas de novo (--force)',
    render: true,
    pronto: () => false,
    gerado: () => arquivos(p('src/assets/classic-cards'), /\.webp$/).length > 0,
    async run({ refazer }) {
      await baixarMolduras();
      await npmRender({ skia: true });
      await rodar('node', ['tools/classic/render/render.mjs', ...(force || refazer ? ['--force'] : [])]);
    },
  },
  {
    nome: 'miniaturas', desc: 'Miniaturas webp das cartas clássicas (140 px) -> src/assets/classic-cards-sm (as Rush saem da rush-cartas)',
    fontes: ['tools/setup/thumbs.py'], versao: 1, depende: ['classico-render'],
    refaz: 'refaz todas as miniaturas (--force)',
    render: true,
    pronto: () => false, // thumbs.py pula as que já existem
    gerado: () => arquivos(p('src/assets/classic-cards-sm'), /\.webp$/).length > 0,
    async run({ refazer }) { await py('tools/setup/thumbs.py', ...(force || refazer ? ['--force'] : [])); },
  },
  {
    nome: 'enigma', desc: 'Enigma do Milênio: STL do Printables 517699 (CC BY-NC-SA) -> src/assets/puzzle/',
    fontes: ['tools/puzzle/build_puzzle.py'], versao: 1, host: 'printables',
    refaz: 'converte de novo (os STL já baixados ficam no cache)',
    pronto: () => existe('src/assets/puzzle/puzzle.bin') && existe('src/assets/puzzle/puzzle.json'),
    async run() {
      await baixarEnigma();
      // fast-simplification (opcional) reduz a argola de 40k para ~5k triângulos; instalado só em cache/, sem mexer no Python do sistema.
      const pylibs = p('tools/setup/cache/pylibs');
      const env = { PYTHONPATH: pylibs };
      if (saida('python3', ['-c', 'import fast_simplification'], env).status !== 0) {
        await rodar('python3', ['-m', 'pip', 'install', '-q', '--no-deps', '--target', pylibs, 'fast-simplification'], { ok: true });
        if (saida('python3', ['-c', 'import fast_simplification'], env).status !== 0) log('aviso: sem fast-simplification, a argola do Enigma fica mais pesada (~950 KB em vez de ~350 KB). Opcional: pip install fast-simplification');
      }
      await rodar('python3', ['tools/puzzle/build_puzzle.py', ENIGMA_CACHE, 'src/assets/puzzle'], { env });
    },
  },
  {
    nome: 'vendor-avisos', desc: 'Textos de licença (Three.js, yugioh-card, qrcode-generator, AGPL do ocgcore/CardScripts) e src/vendor/CHECKSUMS.txt',
    fontes: [], versao: 1, apos: ['three', 'qrcode', 'ocgcore', 'yugioh', 'classico', 'rush-ocg'],
    refaz: 'reescreve (roda sempre)',
    pronto: () => false, // barato: sempre reescreve
    gerado: () => existe('src/vendor/CHECKSUMS.txt'),
    async run() { avisosVendor(); },
  },
];
const POR_NOME = new Map(ETAPAS.map((e) => [e.nome, e]));

// ---- passos compartilhados ----
// Licenças ao lado de cada biblioteca e SHA-256 dos arquivos de src/vendor (confere se algo foi trocado).
function avisosVendor() {
  const copia = (de, para) => { if (existsSync(de)) { copyFileSync(de, p(para)); log(`licença: ${para}`); } else log(`aviso: ${de} não existe (rode a etapa correspondente)`); };
  copia(join(LIBS, 'node_modules/three/LICENSE'), 'src/vendor/LICENSE-three.txt');
  copia(join(RENDER_CL, 'node_modules/yugioh-card/LICENSE'), 'src/vendor/yugioh-card/LICENSE');
  copia(p('src/vendor/card-scripts/COPYING'), 'src/vendor/ocgcore/COPYING-AGPL-3.0'); // mesmo texto da AGPL-3.0
  const lista = [];
  const anda = (dir) => {
    for (const e of readdirSync(dir, { withFileTypes: true })) {
      const rel = join(dir, e.name);
      if (e.isDirectory()) { if (!['official', 'rush', 'assets'].includes(e.name)) anda(rel); } else if (e.name !== 'CHECKSUMS.txt') lista.push(rel);
    }
  };
  anda(p('src/vendor'));
  const sha = existe(CARDSCRIPTS_SHA) ? readFileSync(p(CARDSCRIPTS_SHA), 'utf8').trim() : '?';
  const linhas = lista.sort().map((f) => `${createHash('sha256').update(readFileSync(f)).digest('hex')}  ${f.slice(p('src/vendor').length + 1)}`);
  writeFileSync(p('src/vendor/CHECKSUMS.txt'), `# SHA-256 dos arquivos de src/vendor (sem card-scripts/official, card-scripts/rush e assets/). CardScripts no commit ${sha}.\n# Conferir: cd src/vendor && sha256sum -c --ignore-missing CHECKSUMS.txt\n${linhas.join('\n')}\n`);
  log(`CHECKSUMS.txt: ${linhas.length} arquivos`);
}

// npm de tools/setup/libs (three, qrcode e ocgcore): instala uma vez (de novo se o package-lock mudou) e copia dentro da trava,
// para uma etapa não ler o node_modules enquanto outra o reinstala.
let libsReinstaladas = false;
function comLibs(mudou, copiar) {
  return trava('npm-libs', async () => {
    const falta = !['three', 'ocgcore-wasm', 'qrcode-generator'].every((nome) => existsSync(join(LIBS, 'node_modules', nome)));
    const reinstalar = !libsReinstaladas && (mudou.has('tools/setup/libs/package-lock.json') || mudou.has('tools/setup/libs/package.json'));
    if (falta || reinstalar) { await rodar('npm', ['install', '--no-audit', '--no-fund', '--ignore-scripts'], { cwd: LIBS }); libsReinstaladas = true; }
    await copiar();
  });
}

// npm de tools/classic/render (yugioh-card, skia-canvas, esbuild): yugioh, rush-cartas e classico-render.
let renderReinstalado = false, skiaPronto = false;
function npmRender({ skia = false, reinstalar = false } = {}) {
  return trava('npm-render', async () => {
    if (!existsSync(join(RENDER_CL, 'node_modules/esbuild')) || (reinstalar && !renderReinstalado)) {
      await rodar('npm', ['ci', '--no-audit', '--no-fund', '--ignore-scripts'], { cwd: RENDER_CL });
      renderReinstalado = true; skiaPronto = false;
    }
    // O skia-canvas (desenho em Node) baixa um binário no script de instalação, que o --ignore-scripts pulou.
    if (skia && !skiaPronto) {
      const r = spawnSync('node', ['--input-type=module', '-e', "await import('skia-canvas')"], { cwd: RENDER_CL, encoding: 'utf8' });
      // O npm 11+ bloqueia scripts de instalação sem aprovação; rodamos o que o install do skia-canvas faria (baixa o binário).
      if (r.status !== 0) await rodar(join(RENDER_CL, 'node_modules/.bin/node-pre-gyp'), ['install'], { cwd: join(RENDER_CL, 'node_modules/skia-canvas') });
      skiaPronto = true;
    }
  });
}

function baixarMolduras() {
  return trava('molduras', async () => {
    // Só as pastas "yugioh" (clássica) e "rush-duel" (molduras e fontes) são usadas; o cache tem o formato que os render.mjs esperam.
    const repo = p('tools/classic/cache/yugioh-card');
    await baixarRepo('https://github.com/kooriookami/yugioh-card', repo, SHA_YGO_CARD, ['src/assets/yugioh-card/yugioh', 'src/assets/yugioh-card/rush-duel']);
    const ponte = p('tools/classic/cache/yugioh-card-assets');
    // Pasta real de uma versão antiga do setup (sem rush-duel) não serve: vira o link.
    if (existsSync(ponte) && !lstatSync(ponte).isSymbolicLink()) rmSync(ponte, { recursive: true, force: true });
    if (!existsSync(ponte)) symlinkSync(join(repo, 'src/assets/yugioh-card'), ponte, 'dir');
  });
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
    const faltam = partes.filter((f) => !existsSync(join(ENIGMA_CACHE, f.name)));
    let n = partes.length - faltam.length;
    // 3 downloads ao mesmo tempo, cada um com uma pausa curta: são 39 arquivos pequenos, sem pressa com o Printables.
    const baixa = async () => {
      for (let f = faltam.shift(); f; f = faltam.shift()) {
        const link = (await gql('mutation($id:ID!){ getDownloadLink(id:$id, printId:"517699", fileType:stl, source:model_detail){ ok output{ link } } }', { id: f.id })).getDownloadLink.output?.link;
        if (!link) throw new Error(`sem link de download para ${f.name}`);
        const r = await fetch(link);
        if (!r.ok) throw new Error(`download de ${f.name}: ${r.status}`);
        const destino = join(ENIGMA_CACHE, f.name);
        writeFileSync(`${destino}.tmp`, Buffer.from(await r.arrayBuffer()));
        renameSync(`${destino}.tmp`, destino);
        n += 1;
        if (n % 10 === 0 || n === partes.length) log(`peças do Enigma ${n}/${partes.length}`);
        await new Promise((ok) => setTimeout(ok, 300));
      }
    };
    await Promise.all([baixa(), baixa(), baixa()]);
  } catch (erro) {
    throw new Error(`não consegui baixar o Enigma do Printables (${erro.message}).\n  Alternativa manual: baixe os STL de https://www.printables.com/model/517699 para ${ENIGMA_CACHE} e rode: npm run setup -- --so enigma`);
  }
}

// ---- impressões e estado ----
let estado = { versao: 1, etapas: {} };
try { const lido = JSON.parse(readFileSync(ESTADO, 'utf8')); if (lido?.etapas) estado = lido; } catch { /* primeira vez: sem registro */ }
const sha256 = (dado) => createHash('sha256').update(dado).digest('hex');
const hashes = new Map(); // os arquivos de fonte não mudam durante a execução
const hashFonte = (rel) => {
  if (!hashes.has(rel)) hashes.set(rel, existe(rel) ? sha256(readFileSync(p(rel))).slice(0, 16) : 'ausente');
  return hashes.get(rel);
};
/**
 * Impressão de uma etapa: fontes + versao + opções + impressões das dependências.
 * projetar=false (ao rodar): a dependência entra com a impressão gravada (o que os dados dela de fato refletem), então
 * esta etapa só fica desatualizada depois que a dependência foi refeita. projetar=true (--verificar): com a impressão
 * atual, como ficará depois de rodar tudo.
 */
function impressao(etapa, projetar) {
  const fontes = Object.fromEntries((etapa.fontes ?? []).map((f) => [f, hashFonte(f)]));
  const versao = etapa.versao ?? 1;
  const opcoes = etapa.opcoes?.() ?? {};
  const deps = Object.fromEntries((etapa.depende ?? []).map((d) => [d, (!projetar && estado.etapas[d]?.impressao) || impressao(POR_NOME.get(d), projetar).impressao]));
  return { impressao: sha256(JSON.stringify({ fontes, versao, opcoes, deps })).slice(0, 16), fontes, versao, opcoes, deps };
}
const curto = (f) => (/package(-lock)?\.json$/.test(f) ? f : basename(f));
/** Por que a impressão mudou (lista legível) e quais fontes mudaram. */
function diferencas(atual, reg) {
  const motivos = [], mudou = new Set();
  for (const [f, h] of Object.entries(atual.fontes)) if (reg.fontes?.[f] !== h) { mudou.add(f); motivos.push(reg.fontes && !(f in reg.fontes) ? `${curto(f)} passou a ser fonte` : h === 'ausente' ? `${curto(f)} sumiu` : `${curto(f)} mudou`); }
  if ((reg.versao ?? 1) !== atual.versao) motivos.push(`versao ${reg.versao ?? 1} -> ${atual.versao}`);
  for (const [k, v] of Object.entries(atual.opcoes)) if (JSON.stringify(reg.opcoes?.[k]) !== JSON.stringify(v)) motivos.push(`${k}: ${reg.opcoes?.[k] ?? '?'} -> ${v}`);
  for (const [d, imp] of Object.entries(atual.deps)) if (reg.deps?.[d] !== imp) motivos.push(`${d} mudou`);
  if (!motivos.length) motivos.push('impressão mudou');
  return { motivos, mudou };
}
function registrar(etapa, atual) {
  estado.etapas[etapa.nome] = { ...atual, em: new Date().toISOString() };
  mkdirSync(dirname(ESTADO), { recursive: true });
  writeFileSync(`${ESTADO}.tmp`, `${JSON.stringify(estado, null, 1)}\n`);
  renameSync(`${ESTADO}.tmp`, ESTADO); // troca atômica: uma interrupção não deixa o estado pela metade
}
/** O que fazer com a etapa agora: pular, adotar (sem registro, já pronta), rodar, refazer (desatualizada) ou force. */
function decidir(etapa) {
  const atual = impressao(etapa, false);
  const reg = estado.etapas[etapa.nome];
  if (force) return { acao: 'force', atual, mudou: new Set() };
  if (!reg) return { acao: etapa.pronto() ? 'adotar' : 'rodar', atual, mudou: new Set() };
  if (reg.impressao !== atual.impressao) return { acao: 'refazer', atual, ...diferencas(atual, reg) };
  return { acao: etapa.pronto() ? 'pular' : 'rodar', atual, mudou: new Set() };
}
/** --verificar: situação de cada etapa sem rodar nada. */
function verificar(etapa) {
  const atual = impressao(etapa, true);
  const reg = estado.etapas[etapa.nome];
  const gerado = (etapa.gerado ?? etapa.pronto)();
  const sempre = !etapa.pronto(); // etapas que sempre rodam e só completam o que falta
  const base = { nome: etapa.nome, desc: etapa.desc, impressao: atual.impressao, registrada: reg?.impressao ?? null, registradaEm: reg?.em ?? null, refaz: etapa.refaz, motivos: [] };
  if (!gerado) return { ...base, estado: 'faltando', acao: 'rodar', motivos: reg && reg.impressao !== atual.impressao ? diferencas(atual, reg).motivos : [] };
  if (!reg) return { ...base, estado: 'sem-registro', acao: sempre ? 'completar' : 'adotar', motivos: ['sem registro anterior: adota a impressão atual sem refazer'] };
  if (reg.impressao !== atual.impressao) return { ...base, estado: 'desatualizada', acao: 'refazer', motivos: diferencas(atual, reg).motivos };
  return { ...base, estado: 'pronta', acao: sempre ? 'completar' : 'nada' };
}

// ---- execução ----
if (tem('--lista')) {
  for (const e of ETAPAS) console.log(`${e.nome.padEnd(16)} ${e.desc}`);
  process.exit(0);
}
if (so) for (const nome of so) if (!POR_NOME.has(nome)) fim(`etapa desconhecida: ${nome}. Use --lista.`);
const pedidas = ETAPAS.filter((e) => !so || so.includes(e.nome));
const selecionadas = pedidas.filter((e) => !(semRender && e.render));

if (tem('--verificar')) {
  const lista = selecionadas.map(verificar);
  if (tem('--json')) { console.log(JSON.stringify({ estadoArquivo: ESTADO.slice(ROOT.length + 1), temporadas, etapas: lista })); process.exit(0); }
  const rotulo = { pronta: 'pronta', 'sem-registro': 'pronta (sem registro)', desatualizada: 'DESATUALIZADA', faltando: 'faltando' };
  const faz = { nada: 'nada a fazer', completar: 'roda e só completa o que falta', adotar: 'adota a impressão, sem refazer', rodar: 'roda', refazer: 'refaz' };
  console.log(`RushDaily: verificação do setup (temporadas 1..${temporadas}; estado em ${ESTADO.slice(ROOT.length + 1)})\n`);
  for (const v of lista) {
    console.log(`${v.nome.padEnd(16)} ${rotulo[v.estado].padEnd(22)} ${faz[v.acao]}${v.acao === 'refazer' ? `: ${v.refaz}` : ''}`);
    if (v.motivos.length && v.estado !== 'sem-registro') console.log(`${''.padEnd(16)} motivo: ${v.motivos.join(', ')}`);
  }
  const velhas = lista.filter((v) => v.estado === 'desatualizada').length, faltam = lista.filter((v) => v.estado === 'faltando').length;
  console.log(`\n${velhas} desatualizada(s), ${faltam} faltando.${velhas || faltam ? ' Rode npm run setup para pôr em dia.' : ''}`);
  process.exit(0);
}

mkdirSync(p('src/vendor'), { recursive: true });
const inicio = Date.now();
console.log(`RushDaily: setup${force ? ' (--force)' : ''}, temporadas 1..${temporadas}${semRender ? ', sem render' : ''}, ${paralelo === 1 ? 'uma etapa por vez' : `até ${paralelo} etapas em paralelo`}\n`);
console.log('[0] dependências');
dependencias(selecionadas.map((e) => e.nome));

// Interrompido (Ctrl+C, docker stop): encerra os comandos em andamento junto.
for (const sinal of ['SIGINT', 'SIGTERM']) process.on(sinal, () => { for (const f of filhos) f.kill('SIGTERM'); console.error(`\ninterrompido (${sinal}): rode de novo, o setup retoma de onde parou.`); process.exit(130); });

const resumo = new Map(); // nome -> texto
for (const e of pedidas) if (!selecionadas.includes(e)) resumo.set(e.nome, 'ignorada (--sem-render)');

async function rodarEtapa(etapa) {
  return contexto.run({ nome: etapa.nome }, async () => {
    const d = decidir(etapa);
    if (d.acao === 'pular') { log('já pronta, pulando (use --force para refazer)'); resumo.set(etapa.nome, 'já pronta'); return; }
    if (d.acao === 'adotar') {
      registrar(etapa, d.atual);
      log('já pronta; sem registro anterior: adotada a impressão atual (nada refeito)');
      resumo.set(etapa.nome, 'já pronta (impressão adotada)');
      return;
    }
    if (d.acao === 'refazer') log(`${d.motivos.join(', ')}: refazendo (${etapa.refaz})`);
    log(`começa: ${etapa.desc}`);
    const t = Date.now();
    await etapa.run({ refazer: d.acao === 'refazer', mudou: d.mudou });
    registrar(etapa, d.atual);
    const s = Math.round((Date.now() - t) / 1000);
    log(`ok (${s}s)`);
    resumo.set(etapa.nome, `${d.acao === 'refazer' ? 'refeita' : 'ok'} (${s}s)`);
  });
}

/**
 * Agenda as etapas: cada uma espera as de "depende" e "apos" (só as que estão nesta execução), no máximo `paralelo`
 * ao mesmo tempo e nunca duas do mesmo host. Falhou uma: as que dependem dela não rodam; as independentes terminam.
 */
async function agendar(etapas) {
  const nomes = new Set(etapas.map((e) => e.nome));
  // Em paralelo, as longas (e as que destravam outras) saem primeiro; em sequência, a ordem da lista, como sempre foi.
  const pendentes = paralelo === 1 ? [...etapas] : [...etapas].sort((a, b) => Number(!!b.cedo) - Number(!!a.cedo));
  const situacao = new Map(); // nome -> 'ok' | 'falhou' | 'bloqueada'
  const rodando = new Set(), hosts = new Set();
  const falhas = [];
  const total = etapas.length;
  await new Promise((tudo) => {
    const puxa = () => {
      for (let mudou = true; mudou;) {
        mudou = false;
        for (const e of [...pendentes]) {
          const quebrada = (e.depende ?? []).find((d) => nomes.has(d) && ['falhou', 'bloqueada'].includes(situacao.get(d)));
          if (quebrada) {
            pendentes.splice(pendentes.indexOf(e), 1);
            situacao.set(e.nome, 'bloqueada');
            resumo.set(e.nome, `não rodou (depende de ${quebrada}, que não terminou)`);
            console.log(`[${e.nome}] não roda: depende de ${quebrada}, que não terminou`);
            mudou = true;
            continue;
          }
          if (![...(e.depende ?? []), ...(e.apos ?? [])].every((d) => !nomes.has(d) || situacao.has(d))) continue;
          if (rodando.size >= paralelo) break;
          if (e.host && hosts.has(e.host)) continue;
          pendentes.splice(pendentes.indexOf(e), 1);
          rodando.add(e.nome);
          if (e.host) hosts.add(e.host);
          rodarEtapa(e).then(() => situacao.set(e.nome, 'ok'), (erro) => {
            situacao.set(e.nome, 'falhou');
            falhas.push({ nome: e.nome, erro: erro.message });
            resumo.set(e.nome, `FALHOU: ${erro.message.split('\n')[0]}`);
            console.error(`[${e.nome}] ERRO: ${erro.message}`);
          }).finally(() => {
            rodando.delete(e.nome);
            if (e.host) hosts.delete(e.host);
            console.log(`[setup] ${situacao.size}/${total} etapas concluídas${rodando.size ? ` (rodando: ${[...rodando].join(', ')})` : ''}`);
            puxa();
          });
        }
      }
      if (!pendentes.length && !rodando.size) tudo();
    };
    puxa();
  });
  return falhas;
}

const falhas = await agendar(selecionadas);
console.log(`\nResumo:\n  ${pedidas.map((e) => `${e.nome}: ${resumo.get(e.nome) ?? '?'}`).join('\n  ')}\n\nTempo total: ${Math.round((Date.now() - inicio) / 1000)}s.`);
if (falhas.length) {
  const bloqueadas = pedidas.filter((e) => resumo.get(e.nome)?.startsWith('não rodou')).map((e) => e.nome);
  fim(`falhou: ${falhas.map((f) => f.nome).join(', ')}${bloqueadas.length ? `; não rodaram (dependem delas): ${bloqueadas.join(', ')}` : ''}.\n  Veja as mensagens acima e rode de novo: o setup retoma de onde parou.`);
}
console.log('Próximo passo: npm test e npm run serve');
