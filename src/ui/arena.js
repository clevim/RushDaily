// Arena clássica: o motor do EDOPro pergunta, a arena responde (gestos, diálogos ou a IA do rival).
// O duelo é determinístico: salvar a lista de respostas basta para retomar a partida (e para o replay por link).
// Modos: PvP (?vs=), treino, puzzle "vença neste turno" (?dia=AAAA-MM-DD ou ?puzzle=id) e replay (#r=código, só leitura).
import createCore, { OcgLocation as L, OcgMessageType as M, OcgPosition as P, OcgResponseType as R } from '../vendor/ocgcore/index.js';
import { FORMATS, TYPE, createDuel } from '../engine/ocg.mjs';
import { decide } from '../engine/ocg-ai.mjs';
import { buildDeck, seeded } from '../engine/classic-deck.mjs';
import { ATTRIBUTES, RACES, describe } from '../data/classic/strings-pt.mjs';
import { cardBack, cardFace, cardStats } from './classic-card.js';
import { PVP_FORMAT, decodeDeck, deckById, ensureStarter, loadDeckHints, loadSeasonPool, readCollection, readDecks, validDeck } from './classic-store.js';
import { classicCardUrl, paintCards, warmCards } from './classic-render.js';
import { armConfirm, battleForecast, createPacer, disarmConfirm, escape, getPlayerKey, longDate, monthName, monthOf, puzzleFor, readJson, recoverDay, reducedMotion, today, toast, writeJson } from './common.js';
import { decodeReplay, encodeReplay } from './share.js';
import { answerCommon, chainSkipper, createAsk, soleChoice } from './ocg-ask.js';
import { POS_TITLE, RIVAL_TURN, TRAP_SET_WHY, addMenuCorner, bindCardGestures, bindSurrender, confirmSurrender, monsterWhyNot, openDuelMenu, runTips, tapText, turnChipTitle, whereLabel } from './card-gestures.js';
import { queueSync, syncNow } from './sync.js';
import { duelScene } from './scene.js';

const params = new URLSearchParams(location.search);
const playerKey = getPlayerKey();
syncNow(); // só progresso: a partida em andamento (rushdaily-*game:*) não sincroniza
const date = today();
const motion = !reducedMotion();
const $ = (selector) => document.querySelector(selector);
let speed = 1; // replay: 1x, 2x, 4x
const pacer = createPacer(playerKey, motion); // velocidade 1x/2x e "pular" (toque na mesa)
const wait = (ms) => pacer.wait(ms / speed); // speed: só o replay (até 4x)
const GOLD = 0xf5b21a;
const RED = 0xe0303f;
const hashOf = (text) => { let value = 2166136261; for (const char of text) { value ^= char.charCodeAt(0); value = Math.imul(value, 16777619); } return (value >>> 0).toString(36); };

async function loadJson(url) { return (await fetch(url)).json(); }

/* ---------- Decks: PvP (?vs=código) ou treino ---------- */

const vsCode = params.get('vs');
const decksLink = `screens.html?screen=deck${vsCode ? `&vs=${encodeURIComponent(vsCode)}` : ''}`;
/** Para o carregamento da página com uma mensagem e um link. */
// Resultado e avisos só fecham pelos botões (Esc deixava o tapete parado sem saída).
$('#result').addEventListener('cancel', (event) => event.preventDefault());
async function halt(title, copy, href, label) {
  $('#result-kicker').textContent = 'Arena clássica';
  $('#result-title').textContent = title;
  $('#result-copy').textContent = copy;
  $('#result .result-actions').innerHTML = `<a class="btn" href="${href}">${label}</a>`;
  $('#result').showModal();
  await new Promise(() => {});
}

// Replay: o código vem no # (não vai ao servidor) e é entrada não confiável: decodeReplay valida tudo.
const replayCode = location.hash.startsWith('#r=') ? location.hash.slice(3) : '';
const replay = replayCode ? await decodeReplay(replayCode) : null;
if (replayCode && !replay) await halt('Replay inválido', 'Este link de replay está quebrado, cortado ou foi alterado.', 'index.html', 'Ir para o início');
const puzzleDay = replay ? null : params.get('dia');
const isPuzzle = replay ? replay.kind === 'puzzle' : params.has('puzzle') || params.has('dia');
const FORMAT = isPuzzle ? FORMATS.puzzle : PVP_FORMAT;
const toDeck = (deck) => ({ main: [...deck.main], extra: [...(deck.extra || [])] });

let cards;
let pool = [];
let puzzle = null;
let myDeck = null;
let rival = null;
let decks = [];
let duelSeed;
let saveKey = null;
let saved = null;
let round = 0;
let ME = 0;
let label = 'Treino';
if (isPuzzle) {
  // Puzzle: só o JSON dos puzzles (e as fichas); o pool da temporada não é baixado.
  const [list, tokens] = await Promise.all([loadJson('src/data/classic/puzzles.json'), loadJson('src/data/classic/tokens.json')]);
  if (puzzleDay !== null && !/^\d{4}-\d{2}-\d{2}$/.test(puzzleDay)) await halt('Dia inválido', 'Este link não traz uma data que eu entenda.', 'screens.html?screen=puzzle', 'Ver o Enigma');
  // O dia manda: o puzzle de cada data é o mesmo para todos.
  const id = replay?.puzzle || (puzzleDay ? puzzleFor(puzzleDay, list.map((item) => item.id)) : params.get('puzzle'));
  puzzle = list.find((item) => item.id === id);
  if (!puzzle) await halt('Puzzle não encontrado', 'Não achei este puzzle. Abra pelo calendário do Enigma.', 'screens.html?screen=puzzle', 'Ver o Enigma');
  if (!replay && params.get('puzzle') !== puzzle.id) { params.set('puzzle', puzzle.id); history.replaceState(null, '', `?${params}`); }
  cards = new Map([...tokens, ...puzzle.cards].map((card) => [card.id, card]));
  label = puzzle.title;
  duelSeed = `puzzle:${puzzle.id}`;
  if (!replay) {
    saveKey = `rushdaily-classic-game:${playerKey}:puzzle-${puzzle.id}:${puzzleDay || 'livre'}`;
    saved = readJson(saveKey, null);
  }
} else {
  ({ cards, pool } = await loadSeasonPool());
  if (replay) {
    // Replay de duelo: os dois decks precisam existir na temporada atual.
    if (!replay.decks.every((deck) => validDeck(deck, cards).ok)) await halt('Replay de outra temporada', 'As cartas deste replay não estão no pool atual.', 'index.html', 'Ir para o início');
    decks = replay.decks;
    ME = replay.me;
    label = replay.label || 'Treino';
    duelSeed = replay.seed;
  } else {
    await ensureStarter(playerKey);
    myDeck = deckById(playerKey, params.get('deck'));
    rival = vsCode ? decodeDeck(vsCode) : null;
    if (vsCode && !rival) await halt('Link de desafio inválido', 'Não consegui ler o deck do rival neste link. Peça outro a quem desafiou você.', 'screens.html?screen=deck', 'Ir para os decks');
    if (rival && !validDeck(rival, cards).ok) await halt('Deck do rival inválido', `O deck deste link não segue as regras da temporada: ${validDeck(rival, cards).problems[0]}`, 'screens.html?screen=deck', 'Ir para os decks');
    // Desafio de amigo com mais de um deck: pergunta qual usar (só antes de começar; a partida salva segue com o dela).
    const choices = readDecks(playerKey).list.filter((deck) => validDeck(deck, cards, readCollection(playerKey)).ok);
    if (rival && !params.has('deck') && choices.length > 1 && !readJson(`rushdaily-classic-game:${playerKey}:vs-${hashOf(vsCode)}:${date}`, null)) {
      const pick = (deck) => { const query = new URLSearchParams(location.search); query.set('deck', deck.id); return `arena.html?${query}`; };
      $('#result-kicker').textContent = `Desafio de ${rival.key}`;
      $('#result-title').textContent = 'Escolha seu deck';
      $('#result-copy').textContent = 'Qual deck você leva para este duelo?';
      $('#result .result-actions').innerHTML = choices.map((deck) => `<a class="btn ${deck.id === readDecks(playerKey).active ? '' : 'ghost'}" href="${pick(deck)}">${escape(deck.name)}</a>`).join('');
      $('#result').showModal();
      await new Promise(() => {});
    }
    // Deck do jogador inválido: volta aos decks dizendo o motivo.
    const myCheck = myDeck ? validDeck(myDeck, cards, readCollection(playerKey)) : { ok: false, problems: ['monte um deck primeiro.'] };
    if (!myCheck.ok) {
      location.replace(`${decksLink}${myDeck ? `&deck=${myDeck.id}` : ''}&problem=${encodeURIComponent(myCheck.problems[0])}`);
      await new Promise(() => {});
    }
    const mode = rival ? `vs-${hashOf(vsCode)}` : 'treino';
    const foeDeck = rival || buildDeck({ seed: `${date}:treino:${hashOf(myDeck.main.join('.'))}`, pool, ...await loadDeckHints(), format: FORMAT });
    const signature = hashOf(`${myDeck.main.join('.')}/${myDeck.extra.join('.')}`);
    saveKey = `rushdaily-classic-game:${playerKey}:${mode}:${date}`;
    saved = readJson(saveKey, null);
    round = saved?.round || 0;
    duelSeed = `${date}:${mode}:${signature}:${round}`;
    // Quem começa: sorteio pela seed. O motor sempre abre com o time 0, então o jogador vira o time 1 quando perde.
    ME = seeded(duelSeed)() < 0.5 ? 0 : 1;
    decks = (ME === 0 ? [myDeck, foeDeck] : [foeDeck, myDeck]).map(toDeck);
    label = rival ? rival.key : 'Treino';
  }
}
// Saves de duelos de mais de 30 dias saem (a chave termina na data): senão o localStorage só cresce, uma chave por jogador/modo/dia.
try {
  const cutoff = new Date(Date.now() - 30 * 864e5).toISOString().slice(0, 10);
  for (const key of Object.keys(localStorage)) {
    const day = key.startsWith('rushdaily-classic-game:') ? key.match(/:(\d{4}-\d{2}-\d{2})$/)?.[1] : null;
    if (day && day < cutoff) localStorage.removeItem(key);
  }
} catch { /* sem armazenamento: nada a limpar */ }
const cardOf = (code) => cards.get(code) || { id: code, name: `Carta ${code}`, type: 0, desc: '', level: 0 };
const FOE = 1 - ME;
document.querySelector('#foe-plate .who').innerHTML = rival ? `Deck de <span class="who-key">${escape(rival.key)}</span>` : isPuzzle ? 'Rival do puzzle' : replay ? (replay.label && replay.label !== 'Treino' ? `Deck de <span class="who-key">${escape(replay.label)}</span>` : 'Treino') : vsCode ? 'Desafio' : 'Treino';
document.body.classList.toggle('puzzle-mode', isPuzzle);
document.body.classList.toggle('replay-mode', Boolean(replay));
const scene = duelScene($('#mat'), { reduced: !motion });

// O motor lê scripts de forma síncrona: baixa antes tudo o que os dois decks usam.
const scripts = new Map([['official/c0.lua', null], ['proc_unofficial.lua', null]]); // o motor pede os dois, mas não existem
// Fichas não têm script: marcadas como vazias para o motor não buscar (e dar 404) no meio do duelo.
for (const card of cards.values()) if (card.type & TYPE.TOKEN) scripts.set(`official/c${card.id}.lua`, null);
// O motor (WASM cru, 938 KB) baixa e compila enquanto os scripts Lua chegam; o .js com o base64 (1,28 MB) fica só como reserva.
const corePromise = fetch('src/vendor/ocgcore/ocgcore.wasm')
  .then((response) => { if (!response.ok) throw new Error(`ocgcore.wasm: ${response.status}`); return response.arrayBuffer(); })
  .then((wasmBinary) => createCore({ sync: true, wasmBinary }))
  .catch(() => createCore({ sync: true }));
const rootScripts = await loadJson('src/vendor/card-scripts/index.json');
// Monstros Normais não têm script: ficam marcados como vazios para o motor não pedir de novo.
const deckIds = puzzle ? puzzle.cards.map((card) => card.id) : [...new Set(decks.flatMap((deck) => [...deck.main, ...deck.extra]))];
const hasScript = (id) => !(cardOf(id).type & TYPE.NORMAL) || cardOf(id).type & TYPE.PENDULUM;
// Arte alternativa (ex.: Mago Negro 46986420) pede o script do código principal (alias): marca os dois.
for (const id of deckIds) if (!hasScript(id)) for (const code of [id, cardOf(id).alias]) if (code) scripts.set(`official/c${code}.lua`, null);
const wanted = [...rootScripts, ...deckIds.filter(hasScript).map((id) => `official/c${id}.lua`)];
await Promise.all(wanted.map(async (name) => {
  const response = await fetch(`src/vendor/card-scripts/${name}`);
  scripts.set(name, response.ok ? await response.text() : null);
}));
function readScript(name) {
  if (!scripts.has(name)) { // raro: script citado por outro (fichas, cópias). XHR síncrono como reserva.
    const request = new XMLHttpRequest();
    request.open('GET', `src/vendor/card-scripts/${name}`, false);
    request.send();
    scripts.set(name, request.status === 200 ? request.responseText : null);
  }
  return scripts.get(name);
}

const lib = await corePromise;
let duel;
let responses = [];
let view = null;
const aiMemory = {};

// Deck embaralhado pela seed (FORMATS.classico.shuffle): partidas gravadas sem o marcador `shuffled` e replays v1
// são de antes do embaralhamento e só se repetem com a ordem antiga. Revanche e recomeço já embaralham.
const shuffledDuel = replay ? replay.v >= 2 : !(saved?.responses?.length && !saved.shuffled);
const mark = shuffledDuel ? { shuffled: true } : {};

function start() {
  duel?.destroy();
  duel = createDuel(lib, { seed: duelSeed, format: FORMAT, decks, shuffle: Boolean(FORMAT.shuffle) && shuffledDuel, puzzle: puzzle && { name: `${puzzle.id}.lua`, script: puzzle.script }, cards, readScript, onError: (text) => console.warn('[motor]', text) });
}

/* ---------- Desenho ---------- */

const locKey = (controller, location, sequence) => `${controller}:${location}:${sequence}`;
const isFaceDown = (card) => card.position & (P.FACEDOWN_ATTACK | P.FACEDOWN_DEFENSE);
const isDefense = (card) => card.position & (P.FACEUP_DEFENSE | P.FACEDOWN_DEFENSE);

const at = (row, col) => `style="grid-area:${row}/${col}"`;
// As cartas vão num grupo próprio (display: contents) para o celular poder pôr os botões do turno dentro da grade.
$('#field').insertAdjacentHTML('afterbegin', '<div id="zones" class="zones-grid"></div>');

const lastDef = new Map(), lastDown = new Map();
function slot(controller, location, sequence, card, place, extraClass = '') {
  const key = locKey(controller, location, sequence);
  const spell = location === L.SZONE;
  const base = `zone ${spell ? 'szone' : 'mzone'} ${extraClass} ${controller === ME ? 'mine' : 'theirs'}`;
  if (!card) return `<div class="${base} empty" data-loc="${key}" ${place}></div>`;
  const data = cardOf(card.code);
  const hidden = isFaceDown(card) && controller !== ME;
  const classes = [base, 'filled'];
  if (location === L.MZONE && isDefense(card)) classes.push('defense');
  if (isFaceDown(card)) classes.push('facedown');
  if (location === L.MZONE) {
    const def = Boolean(isDefense(card)), was = lastDef.get(key);
    lastDef.set(key, def);
    if (was !== undefined && was !== def) classes.push('spin'); // giro de 90° ao trocar de posição
    const down = Boolean(isFaceDown(card)), wasDown = lastDown.get(key);
    lastDown.set(key, down);
    if (wasDown !== undefined && wasDown !== down) classes.push('flip'); // vira (ou baixa) a carta
    if (controller === ME && actionsFor(key).some((item) => item.action === 2)) classes.push('can-pos'); // ainda pode mudar de posição
    if (controller === ME && actionsFor(key).some((item) => item.action === 'attack')) classes.push('ready'); // Batalha: pode atacar
  }
  if (actionsFor(key).some((item) => item.action === 5)) classes.push('can-act'); // efeito ativável agora (vem do prompt do motor; vale carta do rival, ex.: Magia de Campo que os dois usam)
  const label = hidden ? (spell ? 'Carta baixada do rival' : 'Monstro virado do rival') : `${data.name}${isFaceDown(card) ? ', virada' : ''}`;
  const materials = card.overlayCards?.length ? `<span class="xyz-mats">${card.overlayCards.length}</span>` : '';
  return `<div class="${classes.join(' ')}" data-loc="${key}" ${place}${classes.includes('can-pos') ? ` title="${POS_TITLE}"` : ''}>
    <button class="card face" type="button" data-loc="${key}" data-gesture aria-label="${escape(label)}">${isFaceDown(card) ? cardBack() : cardFace(data, { live: card })}</button>${materials}</div>`;
}

const PILE_LOCATION = { deck: L.DECK, extra: L.EXTRA, grave: L.GRAVE, banished: L.REMOVED };
/** Cartas desta pilha com ação na pergunta atual (efeito do Cemitério/banidas, Invocação do Adicional ou do Deck). */
function pileActions(controller, kind) {
  const prompt = current?.prompt;
  const lists = prompt?.type === M.SELECT_IDLECMD ? [prompt.summons, prompt.special_summons, prompt.activates] : prompt?.type === M.SELECT_BATTLECMD ? [prompt.chains] : [];
  return lists.flat().filter((loc) => loc.controller === controller && loc.location === PILE_LOCATION[kind]);
}
function pile(controller, kind, count, top, place) {
  const labels = { deck: 'Deck', extra: 'Adicional', grave: 'Cemitério' };
  const short = { deck: 'Deck', extra: 'Adic.', grave: 'Cem.' };
  const face = kind === 'grave' ? (top ? cardFace(cardOf(top.code)) : '') : count ? cardBack() : '';
  return `<button class="pile ${kind} ${controller === ME ? 'mine' : 'theirs'} ${pileActions(controller, kind).length ? 'can-act' : ''}" type="button" data-pile="${controller}:${kind}" ${place} aria-label="${labels[kind]}: ${count} cartas${kind === 'deck' && controller === ME ? '. Segure para desistir' : ''}">${face}<span class="pile-name" data-short="${short[kind]}">${labels[kind]}</span><span class="pile-count">${count}</span></button>`;
}

/**
 * Tapete oficial em 7 colunas x 5 linhas. Você embaixo; o rival espelhado em cima.
 *   1: Deck/Adic. do rival + magias   2: Cemitério + monstros + Campo do rival
 *   3: Zonas de Monstro Extra (colunas 3 e 5)
 *   4: seu Campo + monstros + Cemitério   5: seu Adicional + magias + Deck
 */
function renderField() {
  const cells = [];
  for (const controller of [FOE, ME]) {
    const side = view[controller];
    const mine = controller === ME;
    const monsterRow = mine ? 4 : 2;
    const spellRow = mine ? 5 : 1;
    const column = (seq) => (mine ? seq + 2 : 6 - seq);
    for (let seq = 0; seq < 5; seq += 1) {
      cells.push(slot(controller, L.MZONE, seq, side.monsters[seq], at(monsterRow, column(seq))));
      cells.push(slot(controller, L.SZONE, seq, side.spells[seq], at(spellRow, column(seq))));
    }
    cells.push(slot(controller, L.SZONE, 5, side.spells[5], at(monsterRow, mine ? 1 : 7), 'fzone'));
    const grave = side.grave.filter(Boolean);
    cells.push(pile(controller, 'grave', grave.length, grave.at(-1), at(monsterRow, mine ? 7 : 1)));
    cells.push(pile(controller, 'extra', side.extra.filter(Boolean).length, null, at(spellRow, mine ? 1 : 7)));
    cells.push(pile(controller, 'deck', side.deck, null, at(spellRow, mine ? 7 : 1)));
    const id = mine ? 'me' : 'foe';
    const lp = Math.max(0, side.lp | 0); // o motor manda PV sem sinal: abaixo de zero vira 4 bilhões
    tweenLp($(`#${id}-lp`), shownLp[id], lp);
    shownLp[id] = lp;
    $(`#${id}-bar`).style.width = `${Math.min(100, (lp / FORMAT.lp) * 100)}%`;
    const banished = side.banished.filter(Boolean).length;
    $(`#${id}-banished`).hidden = !banished;
    $(`#${id}-banished`).textContent = `Banidas: ${banished}`;
    $(`#${id}-banished`).classList.toggle('can-act', pileActions(controller, 'banished').length > 0);
  }
  // Zonas de Monstro Extra: a 5 (esquerda) e a 6 (direita) de quem olha; as do rival vêm espelhadas.
  for (const [col, mineSeq, theirSeq] of [[3, 5, 6], [5, 6, 5]]) {
    const mineCard = view[ME].monsters[mineSeq];
    const theirCard = view[FOE].monsters[theirSeq];
    cells.push(theirCard && !mineCard
      ? slot(FOE, L.MZONE, theirSeq, theirCard, at(3, col), 'emz-zone')
      : slot(ME, L.MZONE, mineSeq, mineCard, at(3, col), 'emz-zone'));
  }
  $('#zones').innerHTML = cells.join('');
}

function renderHand() {
  const hand = view[ME].hand.filter(Boolean);
  $('#hand').style.setProperty('--n', hand.length);
  $('#hand').innerHTML = hand.map((card, index) => {
    const key = locKey(ME, L.HAND, card.sequence);
    const pose = { set: Boolean(poses.get(key)?.set) };
    const playable = actionsFor(key).length > 0;
    const canAct = actionsFor(key).some((item) => item.action === 5);
    return `<button class="card hand-card ${playable ? 'playable' : ''} ${canAct ? 'can-act' : ''} ${pose.set ? 'facedown set-pose' : ''}" style="--i:${index}" type="button" data-loc="${key}" data-gesture aria-label="${escape(cardOf(card.code).name)}${pose.set ? ', para baixar' : ''}">${pose.set ? cardBack() : cardFace(cardOf(card.code))}${cardOf(card.code).type & TYPE.MONSTER && !pose.set ? `<span class="hand-stats" aria-hidden="true">${cardOf(card.code).atk}</span>` : ''}</button>`; // ATK no topo: no celular a mão só mostra o topo
  }).join('');
  const foeHand = view[FOE].hand.filter(Boolean).length;
  $('#foe-hand').innerHTML = `<span class="fan">${cardBack().repeat(Math.min(foeHand, 7))}</span><b>${foeHand}</b>`;
  $('#foe-hand').setAttribute('aria-label', `Mão do rival: ${foeHand} cartas`);
}

/** Acende a fase atual na barra (fases do ocgcore: 1 compra, 2 apoio, 4 principal 1, 8–0x80 batalha, 0x100 principal 2, 0x200 final). */
let phaseNow = 0; // a fase dos eventos já narrados (duel.state.phase já está no fim do lote)
function setPhase(phase, active) {
  phaseNow = phase;
  const name = !phase ? '' : phase === 1 ? 'draw' : phase === 2 ? 'standby' : phase === 4 ? 'main' : phase < 0x100 ? 'battle' : phase === 0x100 ? 'main2' : 'end';
  $('#phases').dataset.owner = active === ME ? 'player' : 'enemy';
  for (const node of document.querySelectorAll('#phases li')) node.toggleAttribute('aria-current', node.dataset.phase === name);
}

function render() {
  view = duel.snapshot();
  renderField();
  renderHand();
  if (!replay) $('#player-key').textContent = playerKey;
  const { turn, active } = duel.state;
  const whose = replay ? (active === ME ? 'quem gravou' : 'rival') : active === ME ? 'sua vez' : 'vez do rival';
  $('#turn-chip').innerHTML = isPuzzle ? `<b>${replay ? 'Replay · ' : ''}Vença neste turno</b> ${whose}`
    : replay ? `<b>Replay · Turno ${Math.max(1, turn)}</b> ${whose}` : `<b>Turno ${Math.max(1, turn)}${FORMAT.turnLimit ? `/${FORMAT.turnLimit}` : ''}</b> ${whose}`;
  $('#turn-chip').dataset.owner = active === ME ? 'player' : 'enemy';
  $('#turn-chip').title = isPuzzle ? '' : turnChipTitle(FORMAT.turnLimit);
  setPhase(phaseNow, active);
  gestures?.mark();
  paintCards(document.body);
}

/* ---------- Efeitos visuais e registro ---------- */

// A pergunta de resposta diz o que acabou de acontecer (a última linha do registro).
const lastPlay = () => { const text = $('#log span')?.textContent; return text ? `Agora: ${escape(text)}` : ''; };
let historyTurn = 0;
function log(message, story = true) {
  const node = $('#log');
  node.innerHTML = `<span>${escape(message)}</span>${[...node.children].slice(0, 2).map((child) => child.outerHTML).join('')}`;
  if (!story || !duel) return; // só o topo (a narração já marca a virada do turno)
  // Narração (coluna da direita no PC), como na arena Rush: as últimas jogadas, com o turno marcado na virada.
  const list = $('#history');
  const turn = Math.max(1, duel.state.turn);
  if (turn !== historyTurn) list.insertAdjacentHTML('beforeend', `<li class="turn-mark">Turno ${turn} · ${duel.state.active === ME ? 'você' : 'rival'}</li>`);
  historyTurn = turn;
  list.insertAdjacentHTML('beforeend', `<li class="${duel.state.active === ME ? 'mine' : 'theirs'}">${escape(message)}</li>`);
  while (list.children.length > 16) list.firstElementChild.remove();
}
function center(node) { const rect = node.getBoundingClientRect(); return { x: rect.left + rect.width / 2, y: rect.top + rect.height / 2 }; }
// PV contando até o novo valor (o número flutuante fica ao lado da placa, não em cima).
const shownLp = {};
function tweenLp(node, from, to) {
  if (from === undefined || from === to || !motion) { node.textContent = to.toLocaleString('pt-BR'); return; }
  const start = performance.now();
  const step = (now) => {
    const t = Math.min(1, (now - start) / (750 / pacer.speed));
    node.textContent = Math.round(from + (to - from) * (1 - (1 - t) ** 3)).toLocaleString('pt-BR');
    if (t < 1) requestAnimationFrame(step);
  };
  requestAnimationFrame(step);
}
function floatText(text, node, kind) {
  if (!node) return;
  // Sobre a borda da placa voltada para a mesa (não em cima do valor): o PV segue legível e conta o número.
  const seat = node.closest('.seat') || node;
  const rect = seat.getBoundingClientRect();
  const { x } = center(node);
  const down = seat.classList.contains('foe') || rect.top < innerHeight / 2; // placa do rival: o número desce para a mesa
  const label = document.createElement('div');
  label.className = `float ${kind}`;
  label.textContent = text;
  Object.assign(label.style, { left: `${x}px`, top: `${down ? rect.bottom + 18 : rect.top - 18}px` });
  label.style.setProperty('--dy', down ? '60px' : '-60px');
  document.body.append(label);
  setTimeout(() => label.remove(), 1400 / pacer.speed);
}
async function banner(text, owner) {
  scene.setTurn(owner);
  const node = $('#banner');
  node.querySelector('span').textContent = text;
  node.dataset.owner = owner;
  node.classList.remove('run');
  void node.offsetWidth;
  node.classList.add('run');
  // A vez do rival não segura a mesa: a faixa termina de passar enquanto ele joga (se ele só passar, a sua vem logo).
  if (await wait(owner === 'enemy' ? 450 : 700)) node.classList.remove('run');
}
async function cast(code, controller) {
  const node = $('#cast');
  const data = cardOf(code);
  node.dataset.owner = controller === ME ? 'player' : 'enemy';
  node.innerHTML = `<div class="card">${cardFace(data)}</div><p>${controller === ME ? 'Você ativou' : 'O rival ativou'} ${escape(data.name)}</p>`;
  paintCards(node);
  // Espera o desenho (até 600 ms); sem ele mostra o nome em destaque, nunca o verso.
  const img = node.querySelector('img[data-classic-id]');
  if (img) {
    const url = await Promise.race([classicCardUrl(data).catch(() => null), new Promise((resolve) => setTimeout(resolve, motion ? 600 : 0))]);
    if (url) img.src = url; else node.querySelector('.card').innerHTML = `<span class="cast-name">${escape(data.name)}</span>`;
  }
  node.classList.add('show');
  await wait(controller === ME ? 450 : 900); // a sua ativação você já sabe: destaque curto
  const { x, y } = center(node);
  scene.pulse(x, y, controller === ME ? GOLD : RED, 10, 220);
  node.classList.remove('show');
}

// Linha do dano no registro; no dano de batalha que volta para quem atacou, diz o porquê.
let fightBy = null;
function damageLine(event) {
  const backfire = fightBy !== null && event.player === fightBy;
  fightBy = null;
  const line = `${event.player === ME ? 'Você levou' : 'O rival levou'} ${event.amount.toLocaleString('pt-BR')} de dano`;
  return backfire ? `${line}: o monstro atacado era mais forte que o atacante.` : `${line}.`;
}
const who = (player) => (player === ME ? 'Você' : 'O rival');
const plateOf = (player) => (player === ME ? $('#me-lp') : $('#foe-lp'));

/** Narra os eventos de um lote; devolve depois das animações. */
async function play(events, quick) {
  for (const event of events) {
    switch (event.type) {
      case M.NEW_TURN:
        setPhase(1, event.player); // a vez começa na Compra (não fica no Final do turno anterior)
        if (!quick) {
          log(`Turno ${Math.max(1, duel.state.turn)}: ${event.player === ME ? 'sua vez' : 'vez do rival'}.`, false); // não fica a última jogada do turno anterior
          render(); await banner(event.player === ME ? 'Sua vez' : 'Vez do rival', event.player === ME ? 'player' : 'enemy');
        }
        break;
      case M.NEW_PHASE: setPhase(event.phase, duel.state.active); fightBy = null; break;
      case M.SUMMONING: log(`${who(event.controller)} invocou ${cardOf(event.code).name}.`); break;
      case M.SPSUMMONING: log(`${who(event.controller)} invocou por Especial ${cardOf(event.code).name}.`); break;
      case M.FLIPSUMMONING: log(`${who(event.controller)} desvirou ${cardOf(event.code).name}.`); break;
      case M.SET: log(`${who(event.controller)} baixou uma carta.`); break;
      case M.CHAINING:
        log(`${who(event.controller)} ativou ${cardOf(event.code).name}.`);
        if (!quick) { render(); await cast(event.code, event.controller); }
        break;
      case M.ATTACK: {
        const attacker = view?.[event.card.controller]?.monsters[event.card.sequence];
        log(`${who(event.card.controller)} atacou${event.target ? '' : ' direto'}${attacker ? ` com ${cardOf(attacker.code).name}` : ''}.`);
        fightBy = event.target ? event.card.controller : null; // dano no próprio atacante: o alvo era mais forte
        if (!quick) await wait(250);
        break;
      }
      case M.DAMAGE: case M.PAY_LPCOST:
        if (!quick) { floatText(`−${event.amount}`, plateOf(event.player), 'damage'); scene.shake(Math.min(1, event.amount / 2500)); }
        if (event.type === M.DAMAGE) log(damageLine(event));
        break;
      case M.RECOVER: if (!quick) floatText(`+${event.amount}`, plateOf(event.player), 'heal'); break;
      default:
    }
  }
}

/* ---------- O que dá para fazer agora (pergunta aberta) ---------- */

let current = null; // { prompt, resolve }
let gestures = null; // card-gestures.js (ligado no fim do arquivo)
const poses = new Map(); // carta da mão -> { set }
const defaultPose = (card) => ({ set: Boolean(card.type & TYPE.TRAP) });
// O que o gesto já decidiu: alvo do ataque arrastado, tributo solto em cima e zona onde a carta caiu.
const plan = { target: null, tributes: null, zone: null };
const chainSkip = chainSkipper(); // "Não responder mais": vale para as cartas já oferecidas nesta fase (ocg-ask.js)

const IDLE_LABELS = { 0: 'Invocar por Normal', 1: 'Invocar por Especial', 2: 'Mudar posição', 3: 'Baixar em defesa (virado)', 4: 'Baixar', 5: 'Ativar' };
const sameLoc = (loc, key) => locKey(loc.controller, loc.location, loc.sequence) === key;

/** Ações possíveis para uma carta na pergunta atual: [{ label, response }]. */
function actionsFor(key) {
  const prompt = current?.prompt;
  if (!prompt) return [];
  const out = [];
  if (prompt.type === M.SELECT_IDLECMD) {
    const lists = [[0, prompt.summons], [1, prompt.special_summons], [2, prompt.pos_changes], [3, prompt.monster_sets], [4, prompt.spell_sets], [5, prompt.activates]];
    for (const [action, list] of lists) {
      list.forEach((loc, index) => {
        if (!sameLoc(loc, key)) return;
        const label = action === 5 ? describeActivate(loc) : action === 2 ? positionLabel(loc) : IDLE_LABELS[action];
        out.push({ action, label, response: { type: R.SELECT_IDLECMD, action, index } });
      });
    }
  } else if (prompt.type === M.SELECT_BATTLECMD) {
    prompt.attacks.forEach((loc, index) => { if (sameLoc(loc, key)) out.push({ action: 'attack', label: 'Atacar', response: { type: R.SELECT_BATTLECMD, action: 1, index } }); });
    prompt.chains.forEach((loc, index) => { if (sameLoc(loc, key)) out.push({ action: 5, label: describeActivate(loc), response: { type: R.SELECT_BATTLECMD, action: 0, index } }); });
  }
  return out;
}
function describeActivate(loc) {
  const text = describe(loc.description, cards, [cardOf(loc.code).name]);
  return !text || text === 'Ativar' || text.startsWith('Efeito') ? 'Ativar' : `Ativar: ${text}`;
}
function positionLabel(loc) {
  const card = view?.[loc.controller]?.monsters[loc.sequence];
  if (!card) return 'Mudar posição';
  if (isFaceDown(card)) return 'Invocar por Virada';
  return isDefense(card) ? 'Mudar para Ataque' : 'Mudar para Defesa';
}

function respond(response) {
  if (!current) return;
  const { resolve } = current;
  current = null;
  poses.clear(); // a mão reordena: a pose escolhida não vale para a carta que ocupar o lugar
  gestures.reset();
  resolve(response);
}

/* ---------- Alvos de arrastar ---------- */

/** Previsão do combate no alvo aceso (common.js). */
const forecast = (attacker, target) => battleForecast(attacker.attack, target && { hidden: isFaceDown(target), defense: isDefense(target), attack: target.attack, def: target.defense });

function dropTargets(key) {
  const prompt = current?.prompt;
  if (!prompt) return [];
  const [controller, location] = key.split(':').map(Number);
  if (controller !== ME) return [];
  if (prompt.type === M.SELECT_BATTLECMD && location === L.MZONE) {
    const attack = actionsFor(key).find((item) => item.action === 'attack');
    if (!attack) return [];
    const loc = prompt.attacks[attack.response.index];
    const attacker = view[ME].monsters[Number(key.split(':')[2])];
    const targets = view[FOE].monsters.map((card, seq) => (card ? { node: `[data-loc="${locKey(FOE, L.MZONE, seq)}"]`, target: { controller: FOE, sequence: seq }, response: attack.response, forecast: attacker && forecast(attacker, card) } : null)).filter(Boolean);
    if (loc.can_direct) targets.push({ node: '#foe-plate', target: null, response: attack.response, forecast: attacker && forecast(attacker, null) });
    return targets;
  }
  if (prompt.type !== M.SELECT_IDLECMD || location !== L.HAND) return [];
  const card = cardOf(view[ME].hand.find((item) => item?.sequence === Number(key.split(':')[2]))?.code);
  const pose = poses.get(key) || defaultPose(card);
  const actions = actionsFor(key);
  const isMonster = card.type & TYPE.MONSTER;
  const pick = isMonster
    ? actions.find((item) => item.action === (pose.set ? 3 : 0)) || actions.find((item) => item.action === 1)
    : actions.find((item) => item.action === (pose.set ? 4 : 5)) || actions.find((item) => item.action === 4);
  if (!pick) return [];
  const zones = [];
  if (isMonster) {
    view[ME].monsters.slice(0, 5).forEach((slotCard, seq) => {
      const node = `[data-loc="${locKey(ME, L.MZONE, seq)}"]`;
      if (!slotCard) zones.push({ node, zone: { location: L.MZONE, sequence: seq }, response: pick.response });
      else if ((card.level & 0xff) >= 5 && pick.action !== 1) zones.push({ node, tribute: seq, response: pick.response }); // solta em cima = tributo
    });
  } else if (card.type & 0x80000) {
    zones.push({ node: `[data-loc="${locKey(ME, L.SZONE, 5)}"]`, zone: { location: L.SZONE, sequence: 5 }, response: pick.response });
  } else {
    view[ME].spells.slice(0, 5).forEach((slotCard, seq) => { if (!slotCard) zones.push({ node: `[data-loc="${locKey(ME, L.SZONE, seq)}"]`, zone: { location: L.SZONE, sequence: seq }, response: pick.response }); });
  }
  return zones;
}

/* ---------- Gestos ---------- */

function bindGestures() {
  return bindCardGestures({
    live: () => Boolean(current),
    actions: actionsFor,
    targets: dropTargets,
    pick(item) { plan.target = null; plan.zone = null; respond(item.response); },
    drop(target) {
      plan.target = target.target === undefined ? plan.target : target.target;
      plan.zone = target.zone || null;
      if (target.tribute !== undefined) plan.tributes = [target.tribute];
      respond(target.response);
    },
    describe: describeCard,
    whyNot,
    paint: paintCards,
    doubleTap: onDoubleTap,
    dragHint: (key) => ((cardOf(cardAt(key)?.code).level & 0xff) >= 5 && key.split(':')[1] === String(L.HAND) ? 'Solte numa zona livre ou em cima do monstro que vai virar tributo.' : null),
  });
}

function togglePose(key) {
  const card = cardOf(view[ME].hand.find((item) => item?.sequence === Number(key.split(':')[2]))?.code);
  const pose = poses.get(key) || defaultPose(card);
  poses.set(key, { set: !pose.set });
  renderHand();
}
function onDoubleTap(key) {
  const [controller, location] = key.split(':').map(Number);
  if (controller !== ME || !current) return;
  if (location === L.HAND) { togglePose(key); return; }
  const change = actionsFor(key).find((item) => item.action === 2);
  if (change) respond(change.response);
}

/* ---------- Zoom com ações ---------- */

function cardAt(key) {
  const [controller, location, sequence] = key.split(':').map(Number);
  const side = view[controller];
  const list = { [L.HAND]: side.hand, [L.MZONE]: side.monsters, [L.SZONE]: side.spells, [L.GRAVE]: side.grave, [L.REMOVED]: side.banished, [L.EXTRA]: side.extra }[location];
  return list?.find((item) => item?.sequence === sequence) || list?.[sequence];
}

/** Por que uma carta sua está sem ação agora (leitura sem botões): explica a regra ao novato. */
function whyNot(key) {
  const [controller, location] = key.split(':').map(Number);
  if (controller !== ME || ![L.HAND, L.MZONE, L.SZONE].includes(location)) return null;
  const prompt = current?.prompt;
  if (!prompt) return duel.state.active === FOE ? RIVAL_TURN : null;
  const battle = prompt.type === M.SELECT_BATTLECMD;
  const live = cardAt(key);
  const card = cardOf(live?.code);
  // Campo: o mesmo texto do Rush (card-gestures.js), a partir do que o motor marcou neste turno.
  const { marks } = duel.state;
  if (location === L.SZONE) return live && isFaceDown(live) && card.type & TYPE.TRAP && marks.set.has(key) ? TRAP_SET_WHY : null;
  if (location === L.MZONE) {
    return monsterWhyNot({ battle, canBattle: Boolean(prompt.to_bp), firstTurn: duel.state.turn === 1, summoned: marks.summoned.has(key), set: marks.set.has(key),
      moved: marks.moved.has(key), attacked: marks.attacked.has(key), attackPos: Boolean(live) && !isDefense(live) });
  }
  if (battle) return 'Na Batalha só dá para atacar. Cartas da mão são jogadas na Fase Principal.';
  if (card.type & TYPE.MONSTER) {
    const level = card.level & 0xff;
    const need = level >= 7 ? 2 : level >= 5 ? 1 : 0;
    const have = view[ME].monsters.slice(0, 5).filter(Boolean).length;
    if (!prompt.summons.length && !prompt.monster_sets.length) return 'No clássico é uma Invocação-Normal (ou um monstro baixado) por turno, e você já fez a sua.';
    if (need > have) return `Monstro de Nível ${level} pede ${need} tributo${need > 1 ? 's' : ''}: ${need > 1 ? 'monstros seus' : 'um monstro seu'} no campo que vai para o Cemitério para ele entrar. Você tem ${have} no campo.`;
  }
  return 'O que a carta pede ainda não aconteceu: leia o texto acima (condições, custos ou materiais).';
}

/** Conteúdo da leitura (card-gestures.js mostra e liga as ações). */
function describeCard(key) {
  const live = cardAt(key);
  if (!live) return null;
  const [controller] = key.split(':').map(Number);
  const hidden = controller !== ME && isFaceDown(live);
  const data = cardOf(live.code);
  return { hidden, html: hidden ? cardBack() : cardFace(data), name: data.name, stats: cardStats(data, live), text: data.desc };
}
const showZoom = (key, options) => gestures.info(key, options);

/* ---------- Diálogo genérico ---------- */

/** Lista de escolhas (ocg-ask.js): devolve os índices escolhidos ou null (cancelar). */
const askBase = createAsk({ dialog: $('#ask'), title: $('#ask-title'), items: $('#ask-items'), actions: $('#ask-actions'), note: $('#ask-note'), paint: paintCards });
// Pergunta aberta: o topo e o Deck ficam inertes atrás do modal; o "⋯" no canto leva às opções (desistir), sem assustar.
const ask = (options) => { const choice = askBase(options); addMenuCorner($('#ask'), canSurrender() ? surrender : null); return choice; };

function cardItem(loc) {
  const live = loc.location === L.MZONE || loc.location === L.SZONE ? cardAt(locKey(loc.controller, loc.location, loc.sequence)) : null;
  const hidden = loc.controller !== ME && ((live && isFaceDown(live)) || loc.location === L.HAND || loc.location === L.DECK);
  const where = whereLabel(loc.location, loc.controller === ME);
  return { html: hidden || !loc.code ? cardBack() : cardFace(cardOf(loc.code), { live }), label: hidden ? `Carta virada · ${where}` : `${cardOf(loc.code).name} · ${where}`,
    info: hidden || !loc.code ? null : { name: cardOf(loc.code).name, stats: cardStats(cardOf(loc.code), live), text: cardOf(loc.code).desc } };
}

// Título das seleções: a dica do motor (ou o genérico) e, quando se sabe, a carta cujo efeito pediu.
const hint = (fallback) => {
  const text = (duel.state.hint && describe(duel.state.hint, cards)) || fallback;
  return duel.state.source ? `${cardOf(duel.state.source).name}: ${text}` : text;
};
// Contexto das perguntas comuns (ocg-ask.js).
const askContext = () => ({
  ask, me: ME, cards, cardOf, cardItem, face: (card) => cardFace(card), back: cardBack, hint, plan, toast,
  describe: (description, args) => describe(description, cards, args), races: RACES, attributes: ATTRIBUTES, inDuel: new Set(deckIds),
});

/* ---------- Respostas do jogador ---------- */

async function answer(prompt) {
  switch (prompt.type) {
    case M.SELECT_IDLECMD: case M.SELECT_BATTLECMD:
      return new Promise((resolve) => {
        current = { prompt, resolve };
        const idle = prompt.type === M.SELECT_IDLECMD;
        $('#to-battle').hidden = !(idle && prompt.to_bp);
        $('#to-m2').hidden = !(!idle && prompt.to_m2);
        $('#to-end').hidden = !prompt.to_ep;
        disarmConfirm($('#to-end'));
        // Sem mais nada a fazer, Encerrar vira o botão principal.
        const moves = idle ? [prompt.summons, prompt.special_summons, prompt.pos_changes, prompt.monster_sets, prompt.spell_sets, prompt.activates].some((list) => list.length) : prompt.attacks.length || prompt.chains.length;
        $('#to-end').classList.toggle('ghost', Boolean(moves || (idle && prompt.to_bp)));
        $('#hint').classList.toggle('live', !idle); // celular: na Batalha a dica (como atacar / nenhum ataque) aparece mesmo com a dica escondida
        $('#hint').textContent = (isPuzzle ? `${puzzle.goal} ` : '') + (idle
          ? tapText('Toque numa carta para ver as ações, ou arraste da mão para o campo. Toque duas vezes: jogar ou baixar.')
          : prompt.attacks.length ? tapText('Toque no seu monstro aceso para atacar (ou arraste-o até o alvo).') : 'Nenhum ataque disponível.');
        render();
        if (idle) maybeTips();
      });
    case M.SELECT_CHAIN: {
      if (!prompt.selects.length) return { type: R.SELECT_CHAIN, index: null };
      if (chainSkip.skips(prompt, duel.state)) return { type: R.SELECT_CHAIN, index: null };
      // Efeito obrigatório com uma opção só: não há o que escolher, só avisa.
      if (soleChoice(prompt) >= 0) { toast(`Efeito obrigatório: ${cardOf(prompt.selects[0].code).name}.`); return { type: R.SELECT_CHAIN, index: 0 }; }
      const items = prompt.selects.map((loc) => ({ ...cardItem(loc), label: `${cardOf(loc.code).name}: ${describeActivate(loc).replace(/^Ativar: ?/, '') || 'ativar'}` }));
      if (!prompt.forced) items.push({ label: 'Não responder mais com estas cartas nesta fase' });
      const chosen = await ask({ title: prompt.forced ? 'Escolha o efeito obrigatório' : 'Responder com uma carta?', note: lastPlay(), items, cancel: !prompt.forced });
      if (chosen && chosen[0] === prompt.selects.length) { chainSkip.remember(prompt, duel.state); return { type: R.SELECT_CHAIN, index: null }; }
      return { type: R.SELECT_CHAIN, index: chosen ? chosen[0] : null };
    }
    default: {
      const response = await answerCommon(prompt, askContext());
      if (response === undefined) console.warn('pergunta sem tela', prompt);
      return response ?? null;
    }
  }
}

/* ---------- Visualizar pilhas (Adicional, Cemitério, Banidas) ---------- */

async function openPile(controller, kind) {
  if (kind === 'deck') {
    // O Deck não aparece no snapshot: oferece só as cartas que a pergunta atual deixa usar de lá.
    const options = pileActions(controller, kind).flatMap((loc) => actionsFor(locKey(loc.controller, loc.location, loc.sequence)).map((item) => ({ loc, item })))
      .filter((option, index, all) => all.findIndex((other) => other.item.response.action === option.item.response.action && other.item.response.index === option.item.response.index) === index);
    if (!options.length) return;
    const chosen = await ask({ title: 'Do seu Deck', items: options.map(({ loc, item }) => ({ html: cardFace(cardOf(loc.code)), label: `${cardOf(loc.code).name} · ${item.label}` })), cancel: true });
    if (chosen && current) respond(options[chosen[0]].item.response);
    return;
  }
  const location = { extra: L.EXTRA, grave: L.GRAVE, banished: L.REMOVED }[kind];
  const list = view[controller][{ extra: 'extra', grave: 'grave', banished: 'banished' }[kind]].filter(Boolean);
  if (controller !== ME && kind === 'extra') { toast(`Deck Adicional do rival: ${list.length} cartas.`); return; }
  if (!list.length) { toast('Nenhuma carta aqui.'); return; }
  const entries = list.map((card) => ({ card, key: locKey(controller, location, card.sequence) }));
  const items = entries.map(({ card, key }) => {
    const actions = controller === ME ? actionsFor(key) : [];
    // info: segurar (ou o "i") lê a carta sem escolher, como em qualquer outro lugar.
    return { ...cardItem({ controller, location, sequence: card.sequence, code: card.code }), label: actions.length ? `${cardOf(card.code).name} · ${actions[0].label}` : cardOf(card.code).name };
  });
  const title = { extra: 'Seu Deck Adicional', grave: controller === ME ? 'Seu Cemitério' : 'Cemitério do rival', banished: controller === ME ? 'Suas cartas banidas' : 'Banidas do rival' }[kind];
  const chosen = await ask({ title: tapText(`${title}: toque numa carta`), items, cancel: true });
  if (!chosen) return;
  const { key } = entries[chosen[0]];
  const actions = controller === ME ? actionsFor(key) : [];
  if (actions.length === 1 && current) respond(actions[0].response);
  else showZoom(key);
}

/* ---------- Laço do duelo ---------- */

let surrendered = false;
const canSurrender = () => !surrendered && duel.state.winner === null && !puzzle && !replay; // a qualquer momento; sem puzzle nem replay
function surrender() {
  if (surrendered || duel.state.winner !== null) return;
  surrendered = true;
  duel.state.winner = FOE;
  duel.state.reason = 'desistiu';
  if ($('#ask').open) $('#ask').close(); // pergunta do motor aberta: fica sem resposta (o duelo acabou)
  current = null;
  render();
  finish(FOE);
}
bindSurrender({
  enabled: canSurrender,
  async onHold() { if (await confirmSurrender()) surrender(); },
});

let pumping = false;
async function pump({ replay: redo = [] } = {}) {
  if (pumping) return;
  pumping = true;
  let replayAt = 0;
  for (;;) {
    const result = duel.next();
    const quick = replayAt < redo.length;
    await play(result.events, quick);
    if (surrendered) break; // desistiu durante as animações
    if (result.winner !== null) { render(); finish(result.winner); break; }
    const { prompt } = result;
    let response;
    if (quick) response = redo[replayAt++];
    else if (prompt.player === FOE) {
      // Pausa só antes de uma jogada nova (~250 ms); zona, posição e alvo seguem a jogada, e Corrente vazia passa direto.
      const pause = prompt.type === M.SELECT_IDLECMD || prompt.type === M.SELECT_BATTLECMD ? 250 : prompt.type === M.SELECT_CHAIN && prompt.selects.length ? 60 : 0;
      if (pause) { render(); await wait(pause); }
      if (surrendered) break;
      response = decide(prompt, { view: duel.snapshot(), me: FOE, cards, state: duel.state, memory: aiMemory });
    } else {
      if (saved?.surrender) { surrender(); break; } // desistiu antes de recarregar
      if (result.retry) toast('Essa jogada não vale agora. Tente outra.');
      response = await answer(prompt);
    }
    if (surrendered) break;
    if (!response) { console.warn('sem resposta para', prompt); break; }
    responses.push(response);
    if (!quick) writeJson(saveKey, { responses, round, ...mark });
    duel.respond(response);
  }
  pumping = false;
}

/* ---------- Replay (só leitura): toca as respostas gravadas ---------- */

let paused = false;
let skipTo = 0; // "Próximo turno": anda sem animar até este turno
const pace = (ms) => new Promise((resolve) => setTimeout(resolve, ms / speed)); // anda mesmo com animação reduzida

async function watch(list) {
  let at = 0;
  for (;;) {
    let result;
    try { result = duel.next(); } catch { result = { retry: true, events: [], winner: null }; }
    const quick = duel.state.turn < skipTo;
    await play(result.events, quick || !motion);
    if (result.winner !== null) { render(); endReplay(result.winner); return; }
    if (result.retry || at >= list.length) { render(); endReplay(null, result.retry && at > 0); return; }
    if (!quick) {
      render();
      await pace(result.prompt.type === M.SELECT_CHAIN ? 120 : 520);
      while (paused && duel.state.turn >= skipTo) await pace(120 * speed);
    }
    try { duel.respond(list[at++]); } catch { render(); endReplay(null, true); return; }
  }
}

function endReplay(winner, broken = false) {
  $('#replay-bar').hidden = true;
  $('#result-kicker').textContent = `Replay · ${replay.label || 'Treino'} · ${longDate(replay.date)}`;
  $('#result-title').textContent = broken ? 'Replay interrompido' : winner === null ? 'Fim do replay' : winner === ME ? 'Vitória' : winner === FOE ? 'Derrota' : 'Empate';
  $('#result-copy').textContent = broken ? 'Uma resposta deste replay não vale neste duelo; ele parou aqui.'
    : `Turno ${duel.state.turn}. Quem gravou terminou com ${Math.max(0, duel.state.lp[ME]).toLocaleString('pt-BR')} PV; o rival com ${Math.max(0, duel.state.lp[FOE]).toLocaleString('pt-BR')}.`;
  $('#result .result-actions').innerHTML = '<button class="btn" type="button" data-again>Ver de novo</button><a class="btn ghost" href="index.html">Ir para o início</a>';
  $('#result [data-again]').addEventListener('click', () => location.reload());
  $('#result').showModal();
}

/* ---------- Fim do duelo ---------- */

/** Link de replay desta partida (decks, seed e todas as respostas, comprimidos no #). */
async function replayLink() {
  const data = { v: 2, kind: puzzle ? 'puzzle' : 'duel', seed: duelSeed, me: ME, label, date, responses, ...(puzzle ? { puzzle: puzzle.id } : { decks }) };
  return `${location.origin}${location.pathname}#r=${await encodeReplay(data)}`;
}
async function shareReplay() {
  const url = await replayLink();
  try {
    if (navigator.share && matchMedia('(pointer: coarse)').matches) await navigator.share({ title: 'Replay RushDaily', url });
    else { await navigator.clipboard.writeText(url); toast('Link do replay copiado.'); }
  } catch (error) {
    if (error?.name !== 'AbortError') prompt('Copie o link do replay:', url); // sem área de transferência
  }
}

async function finish(winner) {
  writeJson(saveKey, { responses, done: true, round, ...mark, ...(surrendered && { surrender: true }) });
  const result = winner === ME ? 'win' : winner === FOE ? 'loss' : 'draw';
  if (puzzle) { finishPuzzle(result); return; }
  // Só o PvP entra no histórico, e uma vez só (a partida terminada é repetida ao reabrir a página).
  if (rival && !saved?.done) {
    const key = `rushdaily-classic-pvp:${playerKey}`;
    const code = (await replayLink()).split('#r=')[1];
    writeJson(key, [{ date, vs: rival.key, result, turns: duel.state.turn, lp: Math.max(0, duel.state.lp[ME]), replay: code }, ...readJson(key, [])].slice(0, 100));
  }
  $('#result-kicker').textContent = `${rival ? `Desafio de ${rival.key}` : 'Treino'} · turno ${duel.state.turn}`;
  $('#result-title').textContent = winner === ME ? 'Vitória!' : winner === FOE ? 'Derrota' : 'Empate';
  $('#result-copy').textContent = `${duel.state.reason === 'desistiu' ? 'Você desistiu da partida. ' : ''}${duel.state.reason === 'turnos' ? `Chegou o limite de ${FORMAT.turnLimit} turnos: vence quem tem mais PV. ` : ''}Você terminou com ${Math.max(0, duel.state.lp[ME]).toLocaleString('pt-BR')} PV; o rival com ${Math.max(0, duel.state.lp[FOE]).toLocaleString('pt-BR')}.`;
  queueSync(0);
  $('#result').showModal();
}

function finishPuzzle(result) {
  const won = result === 'win';
  const dayNumber = puzzleDay ? Number(puzzleDay.slice(8)) : null;
  // Recupera a peça só para o puzzle do próprio dia (o link pode ter sido mexido).
  const recovered = won && puzzleDay && readJson(`rushdaily-enigma-recover:${playerKey}`, {})?.[puzzleDay] === puzzle.id;
  const granted = won && !recovered && puzzleDay && recoverDay(playerKey, puzzleDay, puzzle.id);
  $('#result-kicker').textContent = `Puzzle · ${puzzle.title}`;
  $('#result-title').textContent = won ? (granted || recovered ? 'Peça recuperada!' : 'Vitória!') : 'O turno acabou';
  $('#result-copy').textContent = won
    ? granted || recovered ? `A peça do dia ${dayNumber} voltou para o Enigma de ${monthName(monthOf(puzzleDay))}.`
      : puzzleDay ? `Puzzle vencido, mas o dia ${dayNumber} não pode ser recuperado (só dias deste mês, antes de hoje e sem vitória no desafio).` : 'Puzzle vencido.'
    : 'Faltou vencer neste turno. Recomece e tente outro caminho: o puzzle é sempre o mesmo.';
  $('#result .result-actions').innerHTML = `${won ? '<a class="btn" href="screens.html?screen=puzzle">Ver o Enigma</a>' : '<button class="btn" type="button" data-restart>Recomeçar</button><a class="btn ghost" href="screens.html?screen=puzzle">Ver o Enigma</a>'}<button class="btn ghost" type="button" data-share-replay>Copiar replay</button>`;
  $('#result [data-restart]')?.addEventListener('click', restartPuzzle);
  queueSync(0);
  $('#result').showModal();
}
function restartPuzzle() { writeJson(saveKey, { responses: [] }); location.reload(); }

/* ---------- Botões ---------- */

$('#to-battle').addEventListener('click', () => respond({ type: R.SELECT_IDLECMD, action: 6, index: null }));
$('#to-m2').addEventListener('click', () => respond({ type: R.SELECT_BATTLECMD, action: 2, index: null }));
$('#to-end').addEventListener('click', (event) => {
  const prompt = current?.prompt;
  // Encerrar com ataque ainda possível pede um 2º toque (sem diálogo): o turno não volta.
  const canAttack = prompt?.type === M.SELECT_BATTLECMD ? prompt.attacks.length > 0
    : prompt?.to_bp && view[ME].monsters.some((card) => card && !isFaceDown(card) && !isDefense(card));
  if (prompt && canAttack && !isPuzzle && !armConfirm(event.currentTarget, 'Encerrar sem atacar?')) return;
  if (prompt) respond(prompt.type === M.SELECT_IDLECMD ? { type: R.SELECT_IDLECMD, action: 7, index: null } : { type: R.SELECT_BATTLECMD, action: 3, index: null });
});
document.addEventListener('click', (event) => {
  const pileNode = event.target.closest('[data-pile]');
  if (pileNode) { const [controller, kind] = pileNode.dataset.pile.split(':'); openPile(Number(controller), kind); }
});
// Velocidade 1x/2x (lembrada por jogador) e toque na mesa: pula a espera da animação atual (a lógica segue igual).
const speedButton = $('#speed-toggle');
const showSpeed = () => { speedButton.textContent = `${pacer.speed}x`; speedButton.setAttribute('aria-pressed', String(pacer.speed === 2)); };
showSpeed();
speedButton.addEventListener('click', () => { pacer.toggle(); showSpeed(); });
const menuSpeed = (toggle) => { if (toggle) pacer.toggle(); showSpeed(); return pacer.speed; }; // no celular o botão do topo some: a velocidade fica no "⋯"
document.addEventListener('pointerdown', (event) => { if (!event.target.closest('button, a, dialog, .help-chip')) pacer.skip(); });
$('#menu-toggle').addEventListener('click', () => openDuelMenu({
  onSpeed: menuSpeed,
  onHelp: () => { if ($('#help').hidden) $('#help-toggle').click(); },
  onSurrender: canSurrender() ? surrender : null,
}));
// Primeiro duelo clássico: as mesmas dicas do Rush, com as regras daqui; aparecem na sua primeira Fase Principal.
let tipsShown = false;
function maybeTips() {
  const key = `rushdaily-seen-tips:classic:${playerKey}`;
  if (tipsShown || isPuzzle || replay || readJson(key, false)) return;
  tipsShown = true;
  writeJson(key, true);
  runTips([
    ['Objetivo: zerar os 8000 PV (pontos de vida) do rival. Seus monstros atacam; o de ATK maior vence a luta.', '#foe-plate'],
    ['Toque numa carta da mão e escolha Invocar. No clássico é uma Invocação-Normal (ou um monstro baixado) por turno.', '#hand'],
    ['Magias e Armadilhas: toque e escolha Ativar ou Baixar. A Armadilha baixada só pode ser ativada a partir do turno seguinte.', '#hand'],
    ['O turno passa por Compra, Apoio, Principal 1, Batalha, Principal 2 e Final. Na Batalha, toque no seu monstro aceso para atacar.', '#phases'],
    ['Quem começa não ataca no primeiro turno. Encerre quando terminar. Dúvida? "Como jogar" tem as palavras do jogo.', '#to-end'],
  ]);
}
$('#help-toggle').addEventListener('click', (event) => {
  const open = $('#help').hidden;
  $('#help').hidden = !open;
  event.currentTarget.setAttribute('aria-expanded', String(open));
});
$('#rematch').addEventListener('click', () => { writeJson(saveKey, { responses: [], round: round + 1 }); location.reload(); });
$('#restart').addEventListener('click', restartPuzzle);
$('#result').addEventListener('click', (event) => { if (event.target.closest('[data-share-replay]')) shareReplay(); });
$('#rp-play').addEventListener('click', (event) => {
  paused = !paused;
  event.currentTarget.textContent = paused ? 'Tocar' : 'Pausar';
  event.currentTarget.setAttribute('aria-pressed', String(paused));
});
$('#rp-speed').addEventListener('click', (event) => {
  speed = speed === 4 ? 1 : speed * 2;
  event.currentTarget.textContent = `${speed}x`;
});
$('#rp-turn').addEventListener('click', () => { skipTo = duel.state.turn + 1; });

// Celular: os botões do turno vão para a fileira do meio do tapete (no PC e no replay ficam na bandeja).
const phone = matchMedia('(max-width: 860px)');
const placeActions = () => (phone.matches && !replay ? $('#field') : $('.dock')).append($('.dock-actions'));
phone.addEventListener('change', placeActions);
placeActions();
// Celular: a linha da jogada some sozinha; tocar nela (ou no lugar dela) abre a narração completa. Tocar fora fecha.
$('#log').addEventListener('click', () => { if (document.body.classList.toggle('story-open')) $('#history').scrollTop = 1e6; });
document.addEventListener('pointerdown', (event) => { if (!event.target.closest('.story, #log')) document.body.classList.remove('story-open'); });
gestures = bindGestures();
start();
responses = [];
render();
// Mão e Adicional de quem joga: desenhadas em segundo plano, para o zoom e a consulta abrirem sem trocar o verso por carta.
warmCards([...view[ME].hand, ...view[ME].extra].filter(Boolean).map((card) => cardOf(card.code)));
if (replay) {
  $('#replay-bar').hidden = false;
  document.querySelector('.seat.me .who').textContent = 'Quem gravou';
  $('#hint').textContent = tapText(`Replay de ${longDate(replay.date)}: só para assistir. Toque nas cartas para ler.`);
  watch(replay.responses);
} else {
  $('#restart').hidden = !isPuzzle;
  if (isPuzzle) { $('#hint').textContent = puzzle.goal; log(`${puzzle.title}: ${puzzle.goal}`); }
  pump({ replay: saved?.responses || [] }); // partida terminada é repetida até o resultado
  if (!saved?.responses?.length) await banner(isPuzzle ? 'Vença neste turno!' : ME === 0 ? 'Duelo! Você começa' : 'Duelo! O rival começa', 'player');
}
window.__arena = { cards, duel: () => duel, view: () => view, current: () => current, responses: () => responses.length, respond, actionsFor, dropTargets, replayLink }; // testes automáticos
