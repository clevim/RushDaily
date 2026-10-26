// Arena clássica: o motor do EDOPro pergunta, a arena responde (gestos, diálogos ou a IA do rival).
// O duelo é determinístico: salvar a lista de respostas basta para retomar a partida (e para o replay por link).
// Modos: PvP (?vs=), treino, puzzle "vença neste turno" (?dia=AAAA-MM-DD ou ?puzzle=id) e replay (#r=código, só leitura).
import createCore, { OcgLocation as L, OcgMessageType as M, OcgPosition as P, OcgResponseType as R } from '../vendor/ocgcore/index.js';
import { FORMATS, TYPE, createDuel } from '../engine/ocg.mjs';
import { decide } from '../engine/ocg-ai.mjs';
import { buildDeck, seeded } from '../engine/classic-deck.mjs';
import { ATTRIBUTES, RACES, describe } from '../data/classic/strings-pt.mjs';
import { cardBack, cardFace, cardStats } from './classic-card.js';
import { PVP_FORMAT, decodeDeck, deckById, ensureStarter, loadDeckHints, loadSeasonPool, readCollection, validDeck } from './classic-store.js';
import { paintCards, warmCards } from './classic-render.js';
import { escape, getPlayerKey, longDate, monthName, monthOf, puzzleFor, readJson, recoverDay, reducedMotion, today, toast, writeJson } from './common.js';
import { decodeReplay, encodeReplay } from './share.js';
import { answerCommon, createAsk } from './ocg-ask.js';
import { queueSync, syncNow } from './sync.js';
import { duelScene } from './scene.js';

const params = new URLSearchParams(location.search);
const playerKey = getPlayerKey();
syncNow(); // só progresso: a partida em andamento (rushdaily-*game:*) não sincroniza
const date = today();
const motion = !reducedMotion();
const $ = (selector) => document.querySelector(selector);
let speed = 1; // replay: 1x, 2x, 4x
const wait = (ms) => new Promise((resolve) => setTimeout(resolve, motion ? ms / speed : 0));
const GOLD = 0xf5b21a;
const RED = 0xe0303f;
const HOLD_MS = 420;
const DOUBLE_TAP_MS = 320;
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
  const label = hidden ? (spell ? 'Carta baixada do rival' : 'Monstro virado do rival') : `${data.name}${isFaceDown(card) ? ', virada' : ''}`;
  const materials = card.overlayCards?.length ? `<span class="xyz-mats">${card.overlayCards.length}</span>` : '';
  return `<div class="${classes.join(' ')}" data-loc="${key}" ${place}>
    <button class="card face" type="button" data-loc="${key}" data-gesture aria-label="${escape(label)}">${isFaceDown(card) ? cardBack() : cardFace(data, { live: card })}</button>${materials}</div>`;
}

function pile(controller, kind, count, top, place) {
  const labels = { deck: 'Deck', extra: 'Adicional', grave: 'Cemitério' };
  const short = { deck: 'Deck', extra: 'Adic.', grave: 'Cem.' };
  const face = kind === 'grave' ? (top ? cardFace(cardOf(top.code)) : '') : count ? cardBack() : '';
  return `<button class="pile ${kind} ${controller === ME ? 'mine' : 'theirs'}" type="button" data-pile="${controller}:${kind}" ${place} aria-label="${labels[kind]}: ${count} cartas">${face}<span class="pile-name" data-short="${short[kind]}">${labels[kind]}</span><span class="pile-count">${count}</span></button>`;
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
    $(`#${id}-lp`).textContent = lp.toLocaleString('pt-BR');
    $(`#${id}-bar`).style.width = `${Math.min(100, (lp / FORMAT.lp) * 100)}%`;
    const banished = side.banished.filter(Boolean).length;
    $(`#${id}-banished`).hidden = !banished;
    $(`#${id}-banished`).textContent = `Banidas: ${banished}`;
  }
  // Zonas de Monstro Extra: a 5 (esquerda) e a 6 (direita) de quem olha; as do rival vêm espelhadas.
  for (const [col, mineSeq, theirSeq] of [[3, 5, 6], [5, 6, 5]]) {
    const mineCard = view[ME].monsters[mineSeq];
    const theirCard = view[FOE].monsters[theirSeq];
    cells.push(theirCard && !mineCard
      ? slot(FOE, L.MZONE, theirSeq, theirCard, at(3, col), 'emz-zone')
      : slot(ME, L.MZONE, mineSeq, mineCard, at(3, col), 'emz-zone'));
  }
  $('#field').innerHTML = cells.join('');
}

function renderHand() {
  const hand = view[ME].hand.filter(Boolean);
  $('#hand').style.setProperty('--n', hand.length);
  $('#hand').innerHTML = hand.map((card, index) => {
    const key = locKey(ME, L.HAND, card.sequence);
    const pose = poses.get(key) || defaultPose(cardOf(card.code));
    const playable = actionsFor(key).length > 0;
    return `<button class="card hand-card ${playable ? 'playable' : ''} ${pose.set ? 'facedown set-pose' : ''}" style="--i:${index}" type="button" data-loc="${key}" data-gesture aria-label="${escape(cardOf(card.code).name)}${pose.set ? ', para baixar' : ''}">${pose.set ? cardBack() : cardFace(cardOf(card.code))}</button>`;
  }).join('');
  const foeHand = view[FOE].hand.filter(Boolean).length;
  $('#foe-hand').innerHTML = `<span class="fan">${cardBack().repeat(Math.min(foeHand, 7))}</span><b>${foeHand}</b>`;
  $('#foe-hand').setAttribute('aria-label', `Mão do rival: ${foeHand} cartas`);
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
  markTargets();
  paintCards(document.body);
}

/* ---------- Efeitos visuais e registro ---------- */

function log(message) {
  const node = $('#log');
  node.innerHTML = `<span>${escape(message)}</span>${[...node.children].slice(0, 2).map((child) => child.outerHTML).join('')}`;
}
function center(node) { const rect = node.getBoundingClientRect(); return { x: rect.left + rect.width / 2, y: rect.top + rect.height / 2 }; }
function floatText(text, node, kind) {
  if (!node) return;
  const { x, y } = center(node);
  const label = document.createElement('div');
  label.className = `float ${kind}`;
  label.textContent = text;
  Object.assign(label.style, { left: `${x}px`, top: `${y}px` });
  document.body.append(label);
  setTimeout(() => label.remove(), 1400);
}
async function banner(text, owner) {
  scene.setTurn(owner);
  const node = $('#banner');
  node.querySelector('span').textContent = text;
  node.dataset.owner = owner;
  node.classList.remove('run');
  void node.offsetWidth;
  node.classList.add('run');
  await wait(900);
}
async function cast(code, controller) {
  const node = $('#cast');
  node.innerHTML = `<div class="card">${cardFace(cardOf(code))}</div><p>${controller === ME ? 'Você ativou' : 'O rival ativou'} ${escape(cardOf(code).name)}</p>`;
  node.classList.add('show');
  paintCards(node);
  await wait(900);
  const { x, y } = center(node);
  scene.pulse(x, y, controller === ME ? GOLD : RED, 10, 220);
  node.classList.remove('show');
}

const who = (player) => (player === ME ? 'Você' : 'O rival');
const plateOf = (player) => (player === ME ? $('#me-lp') : $('#foe-lp'));

/** Narra os eventos de um lote; devolve depois das animações. */
async function play(events, quick) {
  for (const event of events) {
    switch (event.type) {
      case M.NEW_TURN:
        if (!quick) { render(); await banner(event.player === ME ? 'Sua vez' : 'Vez do rival', event.player === ME ? 'player' : 'enemy'); }
        break;
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
        if (!quick) await wait(250);
        break;
      }
      case M.DAMAGE: case M.PAY_LPCOST:
        if (!quick) { floatText(`−${event.amount}`, plateOf(event.player), 'damage'); scene.shake(Math.min(1, event.amount / 2500)); }
        break;
      case M.RECOVER: if (!quick) floatText(`+${event.amount}`, plateOf(event.player), 'heal'); break;
      default:
    }
  }
}

/* ---------- O que dá para fazer agora (pergunta aberta) ---------- */

let current = null; // { prompt, resolve }
const poses = new Map(); // carta da mão -> { set }
const defaultPose = (card) => ({ set: Boolean(card.type & TYPE.TRAP) });
// O que o gesto já decidiu: alvo do ataque arrastado, tributo solto em cima e zona onde a carta caiu.
const plan = { target: null, tributes: null, zone: null };
let skipChainTurn = null; // turno em que o jogador pediu para não ser perguntado de novo sobre respostas

const IDLE_LABELS = { 0: 'Invocar por Normal', 1: 'Invocar por Especial', 2: 'Mudar posição', 3: 'Baixar', 4: 'Baixar', 5: 'Ativar' };
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
  markTargets();
  hideZoom();
  resolve(response);
}

/* ---------- Alvos de arrastar ---------- */

let dragging = null; // { key }

function dropTargets(key) {
  const prompt = current?.prompt;
  if (!prompt) return [];
  const [controller, location] = key.split(':').map(Number);
  if (controller !== ME) return [];
  if (prompt.type === M.SELECT_BATTLECMD && location === L.MZONE) {
    const attack = actionsFor(key).find((item) => item.action === 'attack');
    if (!attack) return [];
    const loc = prompt.attacks[attack.response.index];
    const targets = view[FOE].monsters.map((card, seq) => (card ? { node: `[data-loc="${locKey(FOE, L.MZONE, seq)}"]`, target: { controller: FOE, sequence: seq }, response: attack.response } : null)).filter(Boolean);
    if (loc.can_direct) targets.push({ node: '#foe-plate', target: null, response: attack.response });
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
      else if (card.level >= 5 && pick.action !== 1) zones.push({ node, tribute: seq, response: pick.response }); // solta em cima = tributo
    });
  } else if (card.type & 0x80000) {
    zones.push({ node: `[data-loc="${locKey(ME, L.SZONE, 5)}"]`, zone: { location: L.SZONE, sequence: 5 }, response: pick.response });
  } else {
    view[ME].spells.slice(0, 5).forEach((slotCard, seq) => { if (!slotCard) zones.push({ node: `[data-loc="${locKey(ME, L.SZONE, seq)}"]`, zone: { location: L.SZONE, sequence: seq }, response: pick.response }); });
  }
  return zones;
}

function markTargets(key = dragging?.key) {
  document.querySelectorAll('.drop-ok, .drop-hover').forEach((node) => node.classList.remove('drop-ok', 'drop-hover'));
  if (!key) return;
  for (const target of dropTargets(key)) document.querySelector(target.node)?.classList.add('drop-ok');
}

/* ---------- Gestos ---------- */

function bindGestures() {
  let press = null;
  let lastTap = { key: null, at: 0 };
  document.addEventListener('pointerdown', (event) => {
    const node = event.target.closest('[data-gesture]');
    if (!node) return;
    const key = node.dataset.loc;
    // Fora da vez de responder (animações, vez do rival) só dá para ler a carta.
    press = { key, node, x: event.clientX, y: event.clientY, moved: false, held: false, ghost: null, idle: !current };
    const pressed = press;
    // Segurar troca a pose e redesenha a mão: se o dedo seguir arrastando, o fantasma sai da carta nova, não da que sumiu.
    if (!press.idle) press.timer = setTimeout(() => { pressed.held = true; onHold(key); pressed.node = document.querySelector(`.hand-card[data-loc="${key}"]`) || pressed.node; }, HOLD_MS);
  });
  document.addEventListener('pointermove', (event) => {
    if (!press || press.idle) return;
    const distance = Math.hypot(event.clientX - press.x, event.clientY - press.y);
    if (!press.moved && distance > 10) {
      if (!dropTargets(press.key).length) return;
      clearTimeout(press.timer);
      press.moved = true;
      dragging = { key: press.key };
      press.ghost = press.node.cloneNode(true);
      press.ghost.className = 'drag-ghost card';
      // Do tamanho da carta tocada e centrado no dedo (sem isso herda a largura da página e cobre o tapete).
      Object.assign(press.ghost.style, { width: `${press.node.getBoundingClientRect().width}px`, translate: '-50% -50%' });
      document.body.append(press.ghost);
      markTargets(press.key);
    }
    if (press.moved) {
      Object.assign(press.ghost.style, { left: `${event.clientX}px`, top: `${event.clientY}px` });
      document.querySelectorAll('.drop-hover').forEach((n) => n.classList.remove('drop-hover'));
      const over = document.elementFromPoint(event.clientX, event.clientY)?.closest('.drop-ok');
      over?.classList.add('drop-hover');
    }
  });
  const finish = (event) => {
    if (!press) return;
    clearTimeout(press.timer);
    const { key, moved, held, ghost } = press;
    press = null;
    if (moved) {
      ghost?.remove();
      const over = document.elementFromPoint(event.clientX, event.clientY)?.closest('.drop-ok');
      const target = over && dropTargets(key).find((item) => document.querySelector(item.node) === over);
      dragging = null;
      markTargets();
      if (target) {
        plan.target = target.target === undefined ? plan.target : target.target;
        plan.zone = target.zone || null;
        if (target.tribute !== undefined) plan.tributes = [target.tribute];
        respond(target.response);
      }
      return;
    }
    if (held) return;
    // Toque duplo só faz algo nas suas cartas (mão: baixar/levantar; campo: mudar posição). Nas outras, zoom na hora.
    const [controller, location] = key.split(':').map(Number);
    if (!current || controller !== ME || (location !== L.HAND && !actionsFor(key).some((item) => item.action === 2))) { showZoom(key); return; }
    const now = performance.now();
    if (lastTap.key === key && now - lastTap.at < DOUBLE_TAP_MS) { lastTap = { key: null, at: 0 }; onDoubleTap(key); return; }
    lastTap = { key, at: now };
    setTimeout(() => { if (lastTap.key === key && lastTap.at === now) showZoom(key); }, DOUBLE_TAP_MS);
  };
  document.addEventListener('pointerup', finish);
  document.addEventListener('pointercancel', () => { if (press) { clearTimeout(press.timer); press.ghost?.remove(); press = null; dragging = null; markTargets(); } });
  // Segurar no celular não deve abrir o menu do navegador sobre as cartas.
  document.addEventListener('contextmenu', (event) => { if (event.target.closest('[data-gesture]')) event.preventDefault(); });
  // Teclado (clique sem ponteiro): Enter numa carta abre a leitura com as ações; D é o mesmo que tocar duas vezes.
  document.addEventListener('click', (event) => {
    if (event.detail !== 0) return;
    const node = event.target.closest('[data-gesture]');
    if (node) showZoom(node.dataset.loc);
  });
  document.addEventListener('keydown', (event) => {
    const node = event.target.closest?.('[data-gesture]');
    if (node && event.key.toLowerCase() === 'd') onDoubleTap(node.dataset.loc);
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
function onHold(key) {
  const [controller, location] = key.split(':').map(Number);
  if (controller !== ME) { showZoom(key); return; }
  if (location === L.HAND) { togglePose(key); return; }
  const flip = actionsFor(key).find((item) => item.action === 2 && item.label === 'Invocar por Virada');
  if (flip) respond(flip.response); else showZoom(key);
}

/* ---------- Zoom com ações ---------- */

function cardAt(key) {
  const [controller, location, sequence] = key.split(':').map(Number);
  const side = view[controller];
  const list = { [L.HAND]: side.hand, [L.MZONE]: side.monsters, [L.SZONE]: side.spells, [L.GRAVE]: side.grave, [L.REMOVED]: side.banished, [L.EXTRA]: side.extra }[location];
  return list?.find((item) => item?.sequence === sequence) || list?.[sequence];
}

function showZoom(key) {
  const live = cardAt(key);
  if (!live) return;
  const [controller] = key.split(':').map(Number);
  const hidden = controller !== ME && isFaceDown(live);
  const actions = hidden ? [] : actionsFor(key);
  const zoom = $('#zoom');
  const data = cardOf(live.code);
  const buttons = actions.map((item, index) => `<button class="btn ${index ? 'ghost' : ''}" type="button" data-act="${index}">${escape(item.label)}</button>`).join('');
  zoom.innerHTML = `<div class="card">${hidden ? cardBack() : cardFace(data)}</div>
    <div class="zoom-copy">${hidden ? '<h2>Carta virada</h2><p>Você ainda não sabe qual é.</p>' : `<h2>${escape(data.name)}</h2><p class="zoom-stats">${escape(cardStats(data, live))}</p><p class="zoom-text">${escape(data.desc)}</p>`}
      ${buttons ? `<div class="zoom-actions">${buttons}</div>` : ''}</div>`;
  zoom.classList.add('show');
  paintCards(zoom);
  const openedAt = performance.now();
  zoom.onclick = (event) => {
    if (performance.now() - openedAt < 400) return; // o clique sintético do próprio toque que abriu o zoom
    const button = event.target.closest('[data-act]');
    if (button) { plan.target = null; plan.zone = null; respond(actions[Number(button.dataset.act)].response); return; }
    hideZoom();
  };
}
function hideZoom() { $('#zoom').classList.remove('show'); }

/* ---------- Diálogo genérico ---------- */

/** Lista de escolhas (ocg-ask.js): devolve os índices escolhidos ou null (cancelar). */
const ask = createAsk({ dialog: $('#ask'), title: $('#ask-title'), items: $('#ask-items'), actions: $('#ask-actions'), paint: paintCards });

function cardItem(loc) {
  const live = loc.location === L.MZONE || loc.location === L.SZONE ? cardAt(locKey(loc.controller, loc.location, loc.sequence)) : null;
  const hidden = loc.controller !== ME && ((live && isFaceDown(live)) || loc.location === L.HAND || loc.location === L.DECK);
  const where = { [L.HAND]: 'mão', [L.MZONE]: 'campo', [L.SZONE]: 'campo', [L.GRAVE]: 'cemitério', [L.REMOVED]: 'banida', [L.EXTRA]: 'Adicional', [L.DECK]: 'deck' }[loc.location] || '';
  const side = loc.controller === ME ? 'sua' : 'do rival';
  return { html: hidden || !loc.code ? cardBack() : cardFace(cardOf(loc.code), { live }), label: hidden ? `Carta ${side} (${where})` : `${cardOf(loc.code).name} · ${where} ${side}` };
}

const hint = (fallback) => (duel.state.hint && describe(duel.state.hint, cards)) || fallback;
// Contexto das perguntas comuns (ocg-ask.js).
const askContext = () => ({
  ask, me: ME, cards, cardOf, cardItem, face: (card) => cardFace(card), back: cardBack, hint, plan,
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
        $('#hint').textContent = (isPuzzle ? `${puzzle.goal} ` : '') + (idle
          ? 'Arraste da mão para o campo. Toque para ler e ver ações; toque duas vezes para alternar entre jogar e baixar.'
          : prompt.attacks.length ? 'Arraste seu monstro até o alvo, ou até o rival para atacar direto.' : 'Nenhum ataque disponível.');
        render();
      });
    case M.SELECT_CHAIN: {
      if (!prompt.selects.length) return { type: R.SELECT_CHAIN, index: null };
      if (!prompt.forced && skipChainTurn === duel.state.turn) return { type: R.SELECT_CHAIN, index: null };
      const items = prompt.selects.map((loc) => ({ ...cardItem(loc), label: `${cardOf(loc.code).name}: ${describeActivate(loc).replace(/^Ativar: ?/, '') || 'ativar'}` }));
      if (!prompt.forced) items.push({ label: 'Não responder mais neste turno' });
      const chosen = await ask({ title: prompt.forced ? 'Escolha o efeito obrigatório' : 'Responder com uma carta?', items, cancel: !prompt.forced });
      if (chosen && chosen[0] === prompt.selects.length) { skipChainTurn = duel.state.turn; return { type: R.SELECT_CHAIN, index: null }; }
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
  if (kind === 'deck') return;
  const location = { extra: L.EXTRA, grave: L.GRAVE, banished: L.REMOVED }[kind];
  const list = view[controller][{ extra: 'extra', grave: 'grave', banished: 'banished' }[kind]].filter(Boolean);
  if (controller !== ME && kind === 'extra') { toast(`Deck Adicional do rival: ${list.length} cartas.`); return; }
  if (!list.length) { toast('Nenhuma carta aqui.'); return; }
  const entries = list.map((card) => ({ card, key: locKey(controller, location, card.sequence) }));
  const items = entries.map(({ card, key }) => {
    const actions = controller === ME ? actionsFor(key) : [];
    return { html: cardFace(cardOf(card.code)), label: actions.length ? `${cardOf(card.code).name} · ${actions[0].label}` : cardOf(card.code).name };
  });
  const title = { extra: 'Seu Deck Adicional', grave: controller === ME ? 'Seu Cemitério' : 'Cemitério do rival', banished: controller === ME ? 'Suas cartas banidas' : 'Banidas do rival' }[kind];
  const chosen = await ask({ title: `${title}: toque numa carta`, items, cancel: true });
  if (!chosen) return;
  const { key } = entries[chosen[0]];
  const actions = controller === ME ? actionsFor(key) : [];
  if (actions.length === 1 && current) respond(actions[0].response);
  else showZoom(key);
}

/* ---------- Laço do duelo ---------- */

let pumping = false;
async function pump({ replay: redo = [] } = {}) {
  if (pumping) return;
  pumping = true;
  let replayAt = 0;
  for (;;) {
    const result = duel.next();
    const quick = replayAt < redo.length;
    await play(result.events, quick);
    if (result.winner !== null) { render(); finish(result.winner); break; }
    const { prompt } = result;
    let response;
    if (quick) response = redo[replayAt++];
    else if (prompt.player === FOE) {
      render();
      await wait(prompt.type === M.SELECT_CHAIN ? 60 : 380);
      response = decide(prompt, { view: duel.snapshot(), me: FOE, cards, state: duel.state, memory: aiMemory });
    } else {
      if (result.retry) toast('Essa jogada não vale agora. Tente outra.');
      response = await answer(prompt);
    }
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
  writeJson(saveKey, { responses, done: true, round, ...mark });
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
  $('#result-copy').textContent = `${duel.state.reason === 'turnos' ? `Chegou o limite de ${FORMAT.turnLimit} turnos: vence quem tem mais PV. ` : ''}Você terminou com ${Math.max(0, duel.state.lp[ME]).toLocaleString('pt-BR')} PV; o rival com ${Math.max(0, duel.state.lp[FOE]).toLocaleString('pt-BR')}.`;
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
$('#to-end').addEventListener('click', () => {
  const prompt = current?.prompt;
  if (prompt) respond(prompt.type === M.SELECT_IDLECMD ? { type: R.SELECT_IDLECMD, action: 7, index: null } : { type: R.SELECT_BATTLECMD, action: 3, index: null });
});
document.addEventListener('click', (event) => {
  const pileNode = event.target.closest('[data-pile]');
  if (pileNode) { const [controller, kind] = pileNode.dataset.pile.split(':'); openPile(Number(controller), kind); }
});
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

bindGestures();
start();
responses = [];
render();
// Mão e Adicional de quem joga: desenhadas em segundo plano, para o zoom e a consulta abrirem sem trocar o verso por carta.
warmCards([...view[ME].hand, ...view[ME].extra].filter(Boolean).map((card) => cardOf(card.code)));
if (replay) {
  $('#replay-bar').hidden = false;
  document.querySelector('.seat.me .who').textContent = 'Quem gravou';
  $('#hint').textContent = `Replay de ${longDate(replay.date)}: só para assistir. Toque nas cartas para ler.`;
  watch(replay.responses);
} else {
  $('#restart').hidden = !isPuzzle;
  if (isPuzzle) { $('#hint').textContent = puzzle.goal; log(`${puzzle.title}: ${puzzle.goal}`); }
  pump({ replay: saved?.responses || [] }); // partida terminada é repetida até o resultado
  if (!saved?.responses?.length) await banner(isPuzzle ? 'Vença neste turno!' : ME === 0 ? 'Duelo! Você começa' : 'Duelo! O rival começa', 'player');
}
window.__arena = { cards, duel: () => duel, view: () => view, current: () => current, responses: () => responses.length, respond, actionsFor, replayLink }; // testes automáticos
