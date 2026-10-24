// Arena do desafio do dia: Rush Duel no motor do EDOPro (ocgcore em WebAssembly, FORMATS.rush).
// O motor pergunta, a arena responde com gestos, diálogos (ocg-ask.js) ou a IA do rival (rush-ai.mjs).
// O duelo é determinístico: salvar a lista de respostas basta para retomar a partida do dia.
import createCore, { OcgLocation as L, OcgMessageType as M, OcgPosition as P, OcgResponseType as R } from '../vendor/ocgcore/index.js';
import { RUSH_ZONES, TYPE, createDuel } from '../engine/ocg.mjs';
import { decideRush } from '../engine/rush-ai.mjs';
import { DIFFICULTY_IDS, generateDailyMatch, getDifficulty } from '../engine/daily-generator.mjs';
import { HEART_CARD, HEART_CODE, HEART_SCRIPT, HEART_SCRIPT_NAME } from '../engine/heart.mjs';
import { ATTRIBUTES, RACES, describe } from '../data/classic/strings-pt.mjs';
import { cardStats, isMonster } from './rush-info.js';
import { RUSH_BACK, paintRushCards, warmRushCards } from './rush-render.js';
import { answerCommon, createAsk } from './ocg-ask.js';
import { daysInMonth, escape, getPlayerKey, heartUnlocked, readJson, reducedMotion, removeKey, settingsFor, today, toast, useHeart, writeJson } from './common.js';
import { duelScene, puzzleScene } from './scene.js';
import { resultGrid } from './share.js';
import { queueSync, syncNow } from './sync.js';

const params = new URLSearchParams(location.search);
// O PvP é clássico: quem chegar com ?vs= vai para a arena clássica.
if (params.has('vs')) { location.replace(`arena.html${location.search}`); await new Promise(() => {}); }
const playerKey = getPlayerKey();
syncNow(); // só progresso: a partida em andamento (rushdaily-game:*) não sincroniza
const difficulty = DIFFICULTY_IDS.includes(params.get('difficulty')) ? params.get('difficulty') : settingsFor(playerKey).difficulty;
const settings = getDifficulty(difficulty);
const date = today();
const motion = !reducedMotion();
const $ = (selector) => document.querySelector(selector);
const wait = (ms) => new Promise((resolve) => setTimeout(resolve, motion ? ms : 0));
const GOLD = 0xf5b21a;
const RED = 0xe0303f;
const HOLD_MS = 420;
const DOUBLE_TAP_MS = 320;
const ME = 0; // no desafio do dia você sempre começa (time 0)
const FOE = 1;
const saveKey = `rushdaily-game:${playerKey}:${date}:${difficulty}`;
$('#result').addEventListener('cancel', (event) => event.preventDefault());

/* ---------- Dados do dia ---------- */

const pool = await (await fetch('src/data/rush/cards.json')).json();
const cards = new Map(pool.map((card) => [card.id, card]));
cards.set(HEART_CODE, HEART_CARD);
const match = generateDailyMatch({ date, difficulty, pool });
const FORMAT = match.format;
const decks = [match.player.deck, match.enemy.deck];
const startLp = [match.player.lp, match.enemy.lp];
// Partida salva do dia (v2: respostas do motor). Saves do motor antigo são ignorados.
const savedRaw = readJson(saveKey, null);
const saved = savedRaw?.v === 2 ? savedRaw : null;
// O Coração entra no duelo se havia carga no começo; a partida retomada mantém a escolha.
const withHeart = saved ? Boolean(saved.heart) : heartUnlocked(playerKey);
const cardOf = (code) => cards.get(code) || { id: code, name: `Carta ${code}`, type: 0, desc: '', level: 0, atk: 0, def: 0 };
const scene = duelScene($('#mat'), { reduced: !motion });

/* ---------- Motor e scripts ---------- */

// O motor lê scripts de forma síncrona: baixa antes tudo o que os dois decks usam.
const scripts = new Map([['rush/c0.lua', null], ['proc_unofficial.lua', null], [HEART_SCRIPT_NAME, HEART_SCRIPT]]);
const corePromise = fetch('src/vendor/ocgcore/ocgcore.wasm')
  .then((response) => { if (!response.ok) throw new Error(`ocgcore.wasm: ${response.status}`); return response.arrayBuffer(); })
  .then((wasmBinary) => createCore({ sync: true, wasmBinary }))
  .catch(() => createCore({ sync: true }));
const rootScripts = await (await fetch('src/vendor/card-scripts/rush/index.json')).json();
const deckIds = [...new Set(decks.flatMap((deck) => [...deck.main, ...deck.extra]))];
// Monstros Normais não têm script: ficam marcados como vazios para o motor não pedir (e dar 404).
const hasScript = (id) => !(cardOf(id).type & TYPE.NORMAL);
for (const id of deckIds) if (!hasScript(id)) for (const code of [id, cardOf(id).alias]) if (code) scripts.set(`rush/c${code}.lua`, null);
const wanted = [...rootScripts, ...deckIds.filter(hasScript).map((id) => `rush/c${id}.lua`)];
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
const duel = createDuel(lib, { seed: match.seed, format: FORMAT, decks, lp: startLp, skills: withHeart ? [{ team: ME, code: HEART_CODE }] : [], cards, readScript, onError: (text) => console.warn('[motor]', text) });
let responses = [];
let view = duel.snapshot();
const aiMemory = {};

/* ---------- Cartas ---------- */

const locKey = (controller, location, sequence) => `${controller}:${location}:${sequence}`;
const isFaceDown = (card) => card.position & (P.FACEDOWN_ATTACK | P.FACEDOWN_DEFENSE);
const isDefense = (card) => card.position & (P.FACEUP_DEFENSE | P.FACEDOWN_DEFENSE);
const HEART_FACE = '<span class="rcard heart-face" aria-hidden="true"><svg viewBox="0 0 60 88"><path d="M30 70 C10 54 6 42 6 34 a12 12 0 0 1 24-4 a12 12 0 0 1 24 4 c0 8-4 20-24 36Z"/></svg><b>Coração das Cartas</b></span>';
/** Frente: imagem da carta (rush-render.js) e, no campo, a faixa de ATK/DEF atual (verde/vermelho se mudou). */
function face(card, live = null) {
  if (card.skill) return HEART_FACE;
  let stats = '';
  if (live && isMonster(card)) {
    const tone = (now, base) => (now > base ? 'up' : now < base ? 'down' : '');
    stats = `<span class="live-stats"><b class="${tone(live.attack, card.atk)}">${live.attack}</b><b class="${tone(live.defense, card.def)}">${live.defense}</b></span>`;
  }
  return `<span class="rcard"><img data-rush-card="${card.id}" alt="" draggable="false">${stats}</span>`;
}
const back = () => `<span class="rcard back" aria-hidden="true"><img src="${RUSH_BACK}" alt="" draggable="false"></span>`;

/* ---------- Desenho ---------- */

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
  if (controller === ME && current?.prompt.type === M.SELECT_BATTLECMD && actionsFor(key).some((item) => item.action === 'attack')) classes.push('ready');
  const label = hidden ? (spell ? 'Carta baixada do rival' : 'Monstro virado do rival')
    : `${data.name}${isFaceDown(card) ? ', virada' : ''}${location === L.MZONE && !isFaceDown(card) ? `, ${isDefense(card) ? 'Defesa' : 'Ataque'}, ATK ${card.attack}, DEF ${card.defense}` : ''}${controller === ME ? '' : ' (do rival)'}`;
  return `<div class="${classes.join(' ')}" data-loc="${key}" ${place}>
    <button class="card face" type="button" data-loc="${key}" data-gesture aria-label="${escape(label)}">${hidden ? back() : face(data, location === L.MZONE ? card : null)}</button></div>`;
}

function pile(controller, kind, count, top, place) {
  const labels = { deck: 'Deck', extra: 'Adicional', grave: 'Cemitério' };
  const short = { deck: 'Deck', extra: 'Adic.', grave: 'Cem.' };
  const art = kind === 'grave' ? (top ? face(cardOf(top.code)) : '') : count ? back() : '';
  const side = controller === ME ? 'seu' : 'do rival';
  return `<button class="pile ${kind} ${controller === ME ? 'mine' : 'theirs'} ${kind === 'deck' && count <= 6 ? 'low' : ''}" type="button" data-pile="${controller}:${kind}" ${place} aria-label="${labels[kind]} ${side}: ${count} cartas">${art}<span class="pile-name" data-short="${short[kind]}">${labels[kind]}</span><span class="pile-count">${count}</span></button>`;
}

/**
 * Tapete Rush em 5 colunas: Campo, 3 zonas e Cemitério na linha dos monstros; Adicional, 3 zonas e Deck na de baixo.
 * Você embaixo; o rival espelhado em cima (o Deck dele fica no canto de cima à esquerda). A linha 3 é a faixa do meio.
 */
function renderField() {
  const cells = [];
  for (const controller of [FOE, ME]) {
    const side = view[controller];
    const mine = controller === ME;
    const monsterRow = mine ? 4 : 2;
    const spellRow = mine ? 5 : 1;
    const column = (seq) => (mine ? seq + 1 : 5 - seq);
    for (const seq of RUSH_ZONES.monsters) cells.push(slot(controller, L.MZONE, seq, side.monsters[seq], at(monsterRow, column(seq))));
    for (const seq of RUSH_ZONES.spells) cells.push(slot(controller, L.SZONE, seq, side.spells[seq], at(spellRow, column(seq))));
    cells.push(slot(controller, L.SZONE, RUSH_ZONES.field, side.spells[RUSH_ZONES.field], at(monsterRow, mine ? 1 : 5), 'fzone'));
    const grave = side.grave.filter(Boolean);
    cells.push(pile(controller, 'grave', grave.length, grave.at(-1), at(monsterRow, mine ? 5 : 1)));
    cells.push(pile(controller, 'extra', side.extra.filter(Boolean).length, null, at(spellRow, mine ? 1 : 5)));
    cells.push(pile(controller, 'deck', side.deck, null, at(spellRow, mine ? 5 : 1)));
  }
  $('#zones').innerHTML = cells.join('');
}

const shownLp = [...startLp];
function tweenLp(player) {
  const id = player === ME ? 'me' : 'foe';
  const node = $(`#${id}-lp`);
  const to = Math.max(0, view[player].lp | 0); // o motor manda PV sem sinal: abaixo de zero vira 4 bilhões
  const from = shownLp[player];
  $(`#${id}-bar`).style.width = `${Math.min(100, (to / startLp[player]) * 100)}%`;
  shownLp[player] = to;
  if (from === to || !motion) { node.textContent = to.toLocaleString('pt-BR'); return; }
  const plate = node.closest('.seat');
  plate.classList.remove('hit');
  void plate.offsetWidth;
  plate.classList.add('hit');
  const start = performance.now();
  const step = (now) => {
    const t = Math.min(1, (now - start) / 750);
    node.textContent = Math.round(from + (to - from) * (1 - (1 - t) ** 3)).toLocaleString('pt-BR');
    if (t < 1) requestAnimationFrame(step);
  };
  requestAnimationFrame(step);
}

function renderHand() {
  const hand = view[ME].hand.filter(Boolean);
  $('#hand').style.setProperty('--n', hand.length);
  $('#hand').innerHTML = hand.map((card, index) => {
    const key = locKey(ME, L.HAND, card.sequence);
    const data = cardOf(card.code);
    const pose = poses.get(key) || defaultPose(data);
    const playable = actionsFor(key).length > 0;
    const stats = isMonster(data) ? `, Nível ${data.level & 0xff}, ATK ${data.atk}, DEF ${data.def}` : '';
    return `<button class="card hand-card ${playable ? 'playable' : ''} ${pose.set ? 'set-pose' : ''}" style="--i:${index}" type="button" data-loc="${key}" data-gesture aria-label="${escape(`${data.name}${stats}${pose.set ? ', para baixar virada' : ''}${playable ? ', jogável' : ''}`)}">${face(data)}</button>`;
  }).join('');
  const foeHand = view[FOE].hand.filter(Boolean).length;
  $('#foe-hand').innerHTML = `<span class="foe-backs">${Array.from({ length: Math.min(foeHand, 8) }, () => `<img src="${RUSH_BACK}" alt="">`).join('')}</span><b>${foeHand}</b>`;
  $('#foe-hand').setAttribute('aria-label', `Mão do rival: ${foeHand} cartas`);
}

function renderTurn() {
  const { turn, active } = duel.state;
  const over = duel.state.winner !== null;
  $('#turn-chip').innerHTML = over ? '<b>Duelo encerrado</b>' : `<b>Turno ${Math.max(1, turn)}/${FORMAT.turnLimit}</b> ${active === ME ? 'sua vez' : 'vez do rival'}`;
  $('#turn-chip').dataset.owner = active === ME ? 'player' : 'enemy';
  $('#phases').dataset.owner = active === ME ? 'player' : 'enemy';
}

function render() {
  view = duel.snapshot();
  renderField();
  renderHand();
  renderTurn();
  tweenLp(ME);
  tweenLp(FOE);
  markTargets();
  paintRushCards(document.body);
}

/* ---------- Faixa do meio, registro e efeitos ---------- */

// Fases do motor: Compra (1), Apoio (2), Principal (4), Batalha (8 a 0x80), Final (0x200).
function setPhase(phase) {
  const name = phase <= 2 ? 'draw' : phase === 4 || phase === 0x100 ? 'main' : phase < 0x100 ? 'battle' : 'end';
  for (const node of document.querySelectorAll('#phases li')) node.toggleAttribute('aria-current', node.dataset.phase === name);
}

let historyTurn = 0;
function log(message) {
  const node = $('#log');
  node.innerHTML = `<span>${escape(message)}</span>${[...node.children].slice(0, 2).map((child) => child.outerHTML).join('')}`;
  // Narração (coluna da direita no computador): as últimas jogadas, com o turno marcado na virada.
  const list = $('#history');
  const turn = Math.max(1, duel.state.turn);
  if (turn !== historyTurn) list.insertAdjacentHTML('beforeend', `<li class="turn-mark">Turno ${turn} · ${duel.state.active === ME ? 'você' : 'rival'}</li>`);
  historyTurn = turn;
  list.insertAdjacentHTML('beforeend', `<li class="${duel.state.active === ME ? 'mine' : 'theirs'}">${escape(message)}</li>`);
  while (list.children.length > 16) list.firstElementChild.remove();
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
  await wait(1000);
}
async function cast(code, controller, verb = 'ativou') {
  const node = $('#cast');
  node.dataset.owner = controller === ME ? 'player' : 'enemy';
  node.innerHTML = `<div class="card">${face(cardOf(code))}</div><p>${controller === ME ? 'Você' : 'O rival'} ${verb} ${escape(cardOf(code).name)}</p>`;
  node.classList.add('show');
  paintRushCards(node);
  await wait(950);
  const { x, y } = center(node);
  scene.pulse(x, y, controller === ME ? GOLD : RED, 10, 220);
  node.classList.remove('show');
}
const zoneNode = (loc) => document.querySelector(`.zone[data-loc="${locKey(loc.controller, loc.location, loc.sequence)}"]`);
function pop(loc, controller) {
  const node = zoneNode(loc);
  if (!node || !motion) return;
  node.classList.remove('arrive');
  void node.offsetWidth;
  node.classList.add('arrive');
  const { x, y } = center(node);
  scene.pulse(x, y, controller === ME ? GOLD : RED, 5, 140);
  scene.shake(0.12);
}

/* ---------- Corrente: monta (1, 2, 3...) e resolve de trás para frente ---------- */

let chain = []; // [{ code, controller, state: 'open' | 'solving' | 'done' | 'negated' }]
function renderChain() {
  const box = $('#chain');
  box.hidden = !chain.length;
  $('#chain-links').innerHTML = chain.map((link, index) => `<li class="link ${link.controller === ME ? 'mine' : 'theirs'} ${link.state}">
      <span class="link-n">${index + 1}</span><span class="link-card">${face(cardOf(link.code))}</span>
      <span class="link-name">${escape(cardOf(link.code).name)}<small>${link.state === 'solving' ? 'resolvendo' : link.state === 'done' ? 'resolvida' : link.state === 'negated' ? 'negada' : link.controller === ME ? 'você' : 'rival'}</small></span></li>`).join('');
  paintRushCards(box);
}
const chainNote = () => (chain.length ? `Corrente aberta: ${chain.map((link, index) => `${index + 1}. ${escape(cardOf(link.code).name)} (${link.controller === ME ? 'você' : 'rival'})`).join(' · ')}` : '');

/* ---------- Narração dos eventos do motor ---------- */

const who = (player) => (player === ME ? 'Você' : 'O rival');
const plateOf = (player) => (player === ME ? $('#me-lp') : $('#foe-lp'));
const lpByTurn = [];
const lpNow = [...startLp];
let turnSeen = 0;

async function play(events, quick) {
  for (const event of events) {
    switch (event.type) {
      case M.NEW_TURN:
        turnSeen += 1;
        if (turnSeen > 1) lpByTurn[turnSeen - 1] = [...lpNow];
        chain = [];
        if (!quick) { renderChain(); render(); await banner(event.player === ME ? 'Sua vez' : 'Vez do rival', event.player === ME ? 'player' : 'enemy'); }
        break;
      case M.NEW_PHASE: setPhase(event.phase); break;
      case M.DRAW: if (!quick && event.player === ME && turnSeen > 1) log(`Você comprou ${event.drawn.length} carta${event.drawn.length > 1 ? 's' : ''}.`); break;
      case M.SUMMONING: case M.SPSUMMONING: case M.FLIPSUMMONING: {
        const verb = { [M.SUMMONING]: 'invocou', [M.SPSUMMONING]: 'invocou por Especial', [M.FLIPSUMMONING]: 'virou' }[event.type];
        log(`${who(event.controller)} ${verb} ${cardOf(event.code).name}.`);
        if (!quick) { render(); pop(event, event.controller); await wait(380); }
        break;
      }
      case M.SET: log(`${who(event.controller)} baixou uma carta.`); if (!quick) { render(); pop(event, event.controller); await wait(220); } break;
      case M.MOVE: {
        // Saiu do campo (destruída, tributada, devolvida): queima a zona antes de redesenhar.
        const from = event.from;
        if (!quick && motion && (from.location === L.MZONE || from.location === L.SZONE) && event.to.location !== from.location) {
          const node = zoneNode(from);
          if (node?.classList.contains('filled')) { node.classList.add('shatter'); await wait(420); }
          render();
        }
        break;
      }
      case M.CHAINING:
        chain.push({ code: event.code, controller: event.controller, state: 'open' });
        log(`${who(event.controller)} ativou ${cardOf(event.code).name}${chain.length > 1 ? ` (Corrente ${chain.length})` : ''}.`);
        if (!quick) { renderChain(); render(); await cast(event.code, event.controller); }
        break;
      case M.CHAIN_SOLVING:
        if (chain[event.chain_size - 1]) chain[event.chain_size - 1].state = 'solving';
        if (!quick) { renderChain(); await wait(320); }
        break;
      case M.CHAIN_SOLVED:
        if (chain[event.chain_size - 1] && chain[event.chain_size - 1].state !== 'negated') chain[event.chain_size - 1].state = 'done';
        if (!quick) { renderChain(); render(); }
        break;
      case M.CHAIN_NEGATED: case M.CHAIN_DISABLED:
        if (chain[event.chain_size - 1]) chain[event.chain_size - 1].state = 'negated';
        log('O efeito foi negado.');
        if (!quick) { renderChain(); await wait(400); }
        break;
      case M.CHAIN_END:
        if (!quick) await wait(260);
        chain = [];
        if (!quick) renderChain();
        break;
      case M.ATTACK: {
        const attacker = view?.[event.card.controller]?.monsters[event.card.sequence];
        log(`${who(event.card.controller)} atacou${event.target ? '' : ' direto'}${attacker ? ` com ${cardOf(attacker.code).name}` : ''}.`);
        if (!quick && motion) await lunge(event);
        break;
      }
      case M.ATTACK_DISABLED: log('O ataque foi anulado.'); break;
      case M.DAMAGE: case M.PAY_LPCOST:
        lpNow[event.player] = Math.max(0, lpNow[event.player] - event.amount);
        if (!quick) { floatText(`−${event.amount.toLocaleString('pt-BR')}`, plateOf(event.player), event.player === ME ? 'damage' : 'deal'); scene.shake(Math.min(1, event.amount / 2500)); }
        if (event.type === M.DAMAGE) log(`${event.player === ME ? 'Você levou' : 'O rival levou'} ${event.amount.toLocaleString('pt-BR')} de dano.`);
        break;
      case M.RECOVER:
        lpNow[event.player] += event.amount;
        if (!quick) floatText(`+${event.amount.toLocaleString('pt-BR')}`, plateOf(event.player), 'heal');
        break;
      case M.LPUPDATE: lpNow[event.player] = event.lp; break;
      case M.CONFIRM_CARDS:
        if (!quick && event.cards.some((card) => card.controller === FOE && card.code)) log(`O rival revelou ${event.cards.map((card) => cardOf(card.code).name).join(', ')}.`);
        break;
      case M.TOSS_DICE: log(`${who(event.player)} rolou o dado: ${event.results.join(', ')}.`); break;
      case M.TOSS_COIN: log(`${who(event.player)} jogou a moeda: ${event.results.map((r) => (r ? 'cara' : 'coroa')).join(', ')}.`); break;
      case M.HINT:
        if (event.hint_type === 10 && Number(event.hint) === HEART_CODE) { log('O Coração das Cartas atendeu ao seu chamado.'); if (!quick) await cast(HEART_CODE, ME, 'chamou o'); }
        break;
      default:
    }
  }
}

/** Avanço do atacante até o alvo (ou até a placa do rival no ataque direto). */
async function lunge(event) {
  const attackerNode = zoneNode(event.card)?.querySelector('.face');
  const targetNode = event.target ? zoneNode(event.target) : (event.card.controller === ME ? $('#foe-plate') : $('.seat.me'));
  if (!attackerNode || !targetNode) return;
  const a = center(attackerNode);
  const t = center(targetNode);
  const rest = getComputedStyle(attackerNode).transform;
  const base = rest === 'none' ? '' : rest;
  const animation = attackerNode.animate([
    { transform: base || 'none' },
    { transform: `translate(${(t.x - a.x) * 0.8}px, ${(t.y - a.y) * 0.8}px) scale(1.15) ${base}`, offset: 0.5 },
    { transform: base || 'none' },
  ], { duration: 620, easing: 'cubic-bezier(.55,0,.2,1)' });
  await wait(300);
  scene.pulse(t.x, t.y, event.card.controller === ME ? GOLD : RED, 7, 220);
  scene.shake(0.4);
  targetNode.classList.remove('struck');
  void targetNode.offsetWidth;
  targetNode.classList.add('struck');
  await animation.finished.catch(() => {});
}

/* ---------- O que dá para fazer agora (pergunta aberta) ---------- */

let current = null; // { prompt, resolve }
const poses = new Map(); // carta da mão -> { set }
const defaultPose = (card) => ({ set: Boolean(card.type & TYPE.TRAP) });
const plan = { target: null, tributes: null, zone: null };
let skipChainTurn = null; // turno em que o jogador pediu para não ser perguntado de novo sobre respostas

const IDLE_LABELS = { 0: 'Invocar por Normal', 1: 'Invocar por Especial', 2: 'Mudar posição', 3: 'Baixar virado', 4: 'Baixar', 5: 'Ativar' };
const sameLoc = (loc, key) => locKey(loc.controller, loc.location, loc.sequence) === key;
const isHeart = (loc) => loc.code === HEART_CODE;

function describeActivate(loc) {
  const text = describe(loc.description, cards, [cardOf(loc.code).name]);
  return !text || text === 'Ativar' || text.startsWith('Efeito') ? 'Ativar' : `Ativar: ${text}`;
}
function positionLabel(loc) {
  const card = view?.[loc.controller]?.monsters[loc.sequence];
  if (!card) return 'Mudar posição';
  if (isFaceDown(card)) return 'Virar (Invocação-Virada)';
  return isDefense(card) ? 'Mudar para Ataque' : 'Mudar para Defesa';
}
/** Ações possíveis para uma carta na pergunta atual: [{ action, label, response }]. */
function actionsFor(key) {
  const prompt = current?.prompt;
  if (!prompt) return [];
  const out = [];
  if (prompt.type === M.SELECT_IDLECMD) {
    const lists = [[0, prompt.summons], [1, prompt.special_summons], [2, prompt.pos_changes], [3, prompt.monster_sets], [4, prompt.spell_sets], [5, prompt.activates]];
    for (const [action, list] of lists) {
      list.forEach((loc, index) => {
        if (!sameLoc(loc, key) || isHeart(loc)) return;
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

function respond(response) {
  if (!current) return;
  const { resolve } = current;
  current = null;
  dragging = null;
  markTargets();
  hideZoom();
  renderDock();
  resolve(response);
}

/* ---------- Alvos de arrastar ---------- */

let dragging = null; // { key }

function dropTargets(key) {
  const prompt = current?.prompt;
  if (!prompt) return [];
  const [controller, location, sequence] = key.split(':').map(Number);
  if (controller !== ME) return [];
  if (prompt.type === M.SELECT_BATTLECMD && location === L.MZONE) {
    const attack = actionsFor(key).find((item) => item.action === 'attack');
    if (!attack) return [];
    const loc = prompt.attacks[attack.response.index];
    const targets = RUSH_ZONES.monsters.filter((seq) => view[FOE].monsters[seq]).map((seq) => ({ node: `.zone[data-loc="${locKey(FOE, L.MZONE, seq)}"]`, target: { controller: FOE, sequence: seq }, response: attack.response }));
    if (loc.can_direct) targets.push({ node: '#foe-plate', target: null, response: attack.response });
    return targets;
  }
  if (prompt.type !== M.SELECT_IDLECMD || location !== L.HAND) return [];
  const card = cardOf(view[ME].hand.find((item) => item?.sequence === sequence)?.code);
  const pose = poses.get(key) || defaultPose(card);
  const actions = actionsFor(key);
  const pick = isMonster(card)
    ? actions.find((item) => item.action === (pose.set ? 3 : 0)) || actions.find((item) => item.action === 1)
    : actions.find((item) => item.action === (pose.set ? 4 : 5)) || actions.find((item) => item.action === 4);
  if (!pick) return [];
  const zones = [];
  if (isMonster(card)) {
    for (const seq of RUSH_ZONES.monsters) {
      const node = `.zone[data-loc="${locKey(ME, L.MZONE, seq)}"]`;
      if (!view[ME].monsters[seq]) zones.push({ node, zone: { location: L.MZONE, sequence: seq }, response: pick.response });
      else if ((card.level & 0xff) >= 5 && pick.action !== 1) zones.push({ node, tribute: seq, response: pick.response }); // solta em cima = tributo
    }
  } else if (card.type & 0x80000) {
    zones.push({ node: `.zone[data-loc="${locKey(ME, L.SZONE, RUSH_ZONES.field)}"]`, zone: { location: L.SZONE, sequence: RUSH_ZONES.field }, response: pick.response });
  } else {
    for (const seq of RUSH_ZONES.spells) if (!view[ME].spells[seq]) zones.push({ node: `.zone[data-loc="${locKey(ME, L.SZONE, seq)}"]`, zone: { location: L.SZONE, sequence: seq }, response: pick.response });
  }
  return zones;
}

function markTargets(key = dragging?.key) {
  document.querySelectorAll('.drop-ok, .drop-hover').forEach((node) => node.classList.remove('drop-ok', 'drop-hover'));
  if (!key) return;
  for (const target of dropTargets(key)) document.querySelector(target.node)?.classList.add('drop-ok');
}

/* ---------- Gestos: tocar, tocar duas vezes, segurar, arrastar; teclado ---------- */

function bindGestures() {
  let press = null;
  let lastTap = { key: null, at: 0 };
  document.addEventListener('pointerdown', (event) => {
    if (!$('#help').hidden && !event.target.closest('#help, #help-toggle')) $('#help-toggle').click();
    if (event.button > 0) return;
    const node = event.target.closest('[data-gesture]');
    if (!node) return;
    const key = node.dataset.loc;
    // Fora da vez de responder (animações, vez do rival) só dá para ler a carta.
    press = { key, node, x: event.clientX, y: event.clientY, moved: false, held: false, ghost: null, idle: !current };
    if (!press.idle) press.timer = setTimeout(() => { press.held = true; onHold(key); }, HOLD_MS);
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
      Object.assign(press.ghost.style, { width: `${press.node.getBoundingClientRect().width}px`, translate: '-50% -50%' });
      document.body.append(press.ghost);
      press.node.classList.add('lifting');
      markTargets(press.key);
      $('#hint').textContent = (cardOf(cardAt(press.key)?.code).level & 0xff) >= 5 && press.key.split(':')[1] === String(L.HAND)
        ? 'Solte numa zona livre ou em cima do monstro que vai virar tributo.' : 'Solte numa zona acesa.';
    }
    if (press.moved) {
      Object.assign(press.ghost.style, { left: `${event.clientX}px`, top: `${event.clientY}px` });
      document.querySelectorAll('.drop-hover').forEach((n) => n.classList.remove('drop-hover'));
      document.elementFromPoint(event.clientX, event.clientY)?.closest('.drop-ok')?.classList.add('drop-hover');
    }
  });
  const finish = (event) => {
    if (!press) return;
    clearTimeout(press.timer);
    const { key, moved, held, ghost, node } = press;
    press = null;
    if (moved) {
      ghost?.remove();
      node.classList.remove('lifting');
      const over = document.elementFromPoint(event.clientX, event.clientY)?.closest('.drop-ok');
      const target = over && dropTargets(key).find((item) => document.querySelector(item.node) === over);
      dragging = null;
      markTargets();
      renderDock();
      if (target) {
        plan.target = target.target === undefined ? plan.target : target.target;
        plan.zone = target.zone || null;
        if (target.tribute !== undefined) plan.tributes = [target.tribute];
        respond(target.response);
      }
      return;
    }
    if (held) return;
    // Toque duplo só faz algo nas suas cartas (mão: baixar/jogar; campo: mudar posição). Nas outras, zoom na hora.
    const [controller, location] = key.split(':').map(Number);
    if (!current || controller !== ME || (location !== L.HAND && !actionsFor(key).some((item) => item.action === 2))) { showZoom(key); return; }
    const now = performance.now();
    if (lastTap.key === key && now - lastTap.at < DOUBLE_TAP_MS) { lastTap = { key: null, at: 0 }; onDoubleTap(key); return; }
    lastTap = { key, at: now };
    setTimeout(() => { if (lastTap.key === key && lastTap.at === now) showZoom(key); }, DOUBLE_TAP_MS);
  };
  document.addEventListener('pointerup', finish);
  document.addEventListener('pointercancel', () => { if (press) { clearTimeout(press.timer); press.ghost?.remove(); press.node.classList.remove('lifting'); press = null; dragging = null; markTargets(); } });
  // Segurar no celular não deve abrir o menu do navegador sobre as cartas.
  document.addEventListener('contextmenu', (event) => { if (event.target.closest('[data-gesture]')) event.preventDefault(); });
  // Teclado (clique sem ponteiro): Enter numa carta abre a leitura com as ações; nas pilhas, a lista.
  document.addEventListener('click', (event) => {
    const pileNode = event.target.closest('[data-pile]');
    if (pileNode) { const [controller, kind] = pileNode.dataset.pile.split(':'); openPile(Number(controller), kind); return; }
    if (event.detail !== 0) return;
    const node = event.target.closest('[data-gesture]');
    if (node) showZoom(node.dataset.loc, { focus: true });
  });
  document.addEventListener('keydown', (event) => {
    if (event.key === 'Escape' && $('#zoom').classList.contains('show')) { hideZoom(); return; }
    const node = event.target.closest?.('[data-gesture]');
    if (!node) return;
    const key = event.key.toLowerCase();
    if (key === 'd') onDoubleTap(node.dataset.loc); // D: o mesmo que tocar duas vezes
  });
}

function togglePose(key) {
  const card = cardOf(cardAt(key)?.code);
  const pose = poses.get(key) || defaultPose(card);
  if (card.type & TYPE.TRAP) { toast('Armadilhas sempre entram viradas.'); return; }
  poses.set(key, { set: !pose.set });
  renderHand();
  paintRushCards($('#hand'));
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
  const flip = actionsFor(key).find((item) => item.action === 2 && item.label.startsWith('Virar'));
  if (flip) respond(flip.response); else showZoom(key);
}

/* ---------- Leitura da carta com as ações ---------- */

function cardAt(key) {
  const [controller, location, sequence] = key.split(':').map(Number);
  const side = view[controller];
  const list = { [L.HAND]: side.hand, [L.MZONE]: side.monsters, [L.SZONE]: side.spells, [L.GRAVE]: side.grave, [L.REMOVED]: side.banished, [L.EXTRA]: side.extra }[location];
  return list?.find((item) => item?.sequence === sequence) || list?.[sequence];
}

let zoomReturn = null;
function showZoom(key, { focus = false } = {}) {
  const live = cardAt(key);
  if (!live) return;
  const [controller, location] = key.split(':').map(Number);
  const hidden = controller !== ME && (isFaceDown(live) || location === L.HAND);
  const actions = hidden ? [] : actionsFor(key);
  const zoom = $('#zoom');
  const data = cardOf(live.code);
  const buttons = actions.map((item, index) => `<button class="btn ${index ? 'ghost' : ''}" type="button" data-act="${index}">${escape(item.label)}</button>`).join('');
  zoom.innerHTML = `<div class="card">${hidden ? back() : face(data)}</div>
    <div class="zoom-copy">${hidden ? '<h2>Carta virada</h2><p>Você ainda não sabe qual é.</p>' : `<h2>${escape(data.name)}</h2><p class="zoom-stats">${escape(cardStats(data, location === L.MZONE ? live : null))}</p><p class="zoom-text">${escape(data.desc)}</p>`}
      <div class="zoom-actions">${buttons}<button class="btn ghost" type="button" data-close>Fechar</button></div></div>`;
  zoom.classList.add('show');
  zoom.setAttribute('aria-hidden', 'false');
  zoom.setAttribute('role', 'dialog');
  zoom.setAttribute('aria-label', hidden ? 'Carta virada' : data.name);
  paintRushCards(zoom);
  zoomReturn = focus ? document.activeElement : null;
  if (focus) setTimeout(() => zoom.querySelector('.btn')?.focus(), 30);
  const openedAt = performance.now();
  zoom.onclick = (event) => {
    if (performance.now() - openedAt < 350 && event.detail !== 0) return; // o clique sintético do próprio toque que abriu
    const button = event.target.closest('[data-act]');
    if (button) { plan.target = null; plan.zone = null; respond(actions[Number(button.dataset.act)].response); return; }
    hideZoom();
  };
}
function hideZoom() {
  const zoom = $('#zoom');
  if (!zoom.classList.contains('show')) return;
  zoom.classList.remove('show');
  zoom.setAttribute('aria-hidden', 'true');
  zoom.innerHTML = '';
  if (zoomReturn?.isConnected) zoomReturn.focus();
  zoomReturn = null;
}

/* ---------- Diálogos (ocg-ask.js) ---------- */

const ask = createAsk({ dialog: $('#ask'), title: $('#ask-title'), items: $('#ask-items'), actions: $('#ask-actions'), note: $('#ask-note'), paint: paintRushCards });
const WHERE = { [L.HAND]: 'mão', [L.MZONE]: 'campo', [L.SZONE]: 'campo', [L.GRAVE]: 'Cemitério', [L.REMOVED]: 'banida', [L.EXTRA]: 'Adicional', [L.DECK]: 'Deck' };
function cardItem(loc) {
  const live = loc.location === L.MZONE || loc.location === L.SZONE ? cardAt(locKey(loc.controller, loc.location, loc.sequence)) : null;
  const hidden = loc.controller !== ME && ((live && isFaceDown(live)) || loc.location === L.HAND || loc.location === L.DECK);
  const where = `${WHERE[loc.location] || ''}${loc.controller === ME ? '' : ' do rival'}`;
  return { html: hidden || !loc.code ? back() : face(cardOf(loc.code), loc.location === L.MZONE ? live : null), label: hidden ? `Carta virada · ${where}` : `${cardOf(loc.code).name} · ${where}` };
}
const hint = (fallback) => (duel.state.hint && describe(duel.state.hint, cards)) || fallback;
const askContext = () => ({
  ask: (options) => ask({ note: chainNote(), ...options }), me: ME, cards, cardOf, cardItem, face, back, hint, plan,
  describe: (description, args) => describe(description, cards, args), races: RACES, attributes: ATTRIBUTES, inDuel: new Set(deckIds),
});

/* ---------- Respostas do jogador ---------- */

function renderDock() {
  const prompt = current?.prompt;
  const idle = prompt?.type === M.SELECT_IDLECMD;
  const battle = prompt?.type === M.SELECT_BATTLECMD;
  $('#to-battle').hidden = !(idle && prompt.to_bp);
  $('#to-end').hidden = !(idle || battle) || !prompt.to_ep;
  $('#heart').hidden = !(idle && prompt.activates.some(isHeart));
  const hintNode = $('#hint');
  if (duel.state.winner !== null) hintNode.textContent = '';
  else if (idle) hintNode.textContent = 'Arraste da mão para o campo (Invocações ilimitadas). Toque para ler e ver ações; toque duas vezes para alternar entre jogar e baixar.';
  else if (battle) hintNode.textContent = prompt.attacks.length ? 'Arraste seu monstro até o alvo, ou até a placa do rival para o ataque direto.' : 'Nenhum ataque disponível. Encerre o turno.';
  else if (duel.state.active === FOE) hintNode.textContent = 'O rival está jogando.';
}

async function answer(prompt) {
  switch (prompt.type) {
    case M.SELECT_IDLECMD: case M.SELECT_BATTLECMD:
      return new Promise((resolve) => {
        current = { prompt, resolve };
        render();
        renderDock();
      });
    case M.SELECT_CHAIN: {
      if (!prompt.selects.length) return { type: R.SELECT_CHAIN, index: null };
      if (!prompt.forced && skipChainTurn === duel.state.turn) return { type: R.SELECT_CHAIN, index: null };
      render();
      const items = prompt.selects.map((loc) => ({ ...cardItem(loc), label: `${cardOf(loc.code).name}: ${describeActivate(loc).replace(/^Ativar: ?/, '') || 'ativar'}` }));
      if (!prompt.forced) items.push({ label: 'Não responder mais neste turno' });
      const chosen = await ask({ title: prompt.forced ? 'Escolha o efeito obrigatório' : chain.length ? `Responder à Corrente ${chain.length}?` : 'Ativar uma carta agora?', note: chainNote(), items, cancel: !prompt.forced });
      if (chosen && chosen[0] === prompt.selects.length) { skipChainTurn = duel.state.turn; return { type: R.SELECT_CHAIN, index: null }; }
      return { type: R.SELECT_CHAIN, index: chosen ? chosen[0] : null };
    }
    default: {
      render();
      const response = await answerCommon(prompt, askContext());
      if (response === undefined) console.warn('pergunta sem tela', prompt);
      return response ?? null;
    }
  }
}

/* ---------- Pilhas: Cemitério e Deck Adicional ---------- */

async function openPile(controller, kind) {
  if (kind === 'deck') { toast(`${controller === ME ? 'Seu Deck' : 'Deck do rival'}: ${view[controller].deck} cartas.`); return; }
  const location = { extra: L.EXTRA, grave: L.GRAVE }[kind];
  const list = view[controller][kind].filter(Boolean);
  if (controller !== ME && kind === 'extra') { toast(`Deck Adicional do rival: ${list.length} cartas.`); return; }
  if (!list.length) { toast('Nenhuma carta aqui.'); return; }
  const entries = list.map((card) => ({ card, key: locKey(controller, location, card.sequence) }));
  const items = entries.map(({ card, key }) => {
    const actions = controller === ME ? actionsFor(key) : [];
    return { html: face(cardOf(card.code)), label: actions.length ? `${cardOf(card.code).name} · ${actions[0].label}` : cardOf(card.code).name };
  });
  const title = kind === 'extra' ? 'Seu Deck Adicional (Fusões)' : controller === ME ? 'Seu Cemitério' : 'Cemitério do rival';
  const chosen = await ask({ title: `${title}: toque numa carta`, items, cancel: true });
  if (!chosen) return;
  const { key } = entries[chosen[0]];
  showZoom(key, { focus: true });
}

/* ---------- Laço do duelo ---------- */

function save(extra = {}) {
  writeJson(saveKey, { v: 2, heart: withHeart, responses, ...extra });
}

async function pump(redo = []) {
  let replayAt = 0;
  for (;;) {
    const result = duel.next();
    const quick = replayAt < redo.length;
    await play(result.events, quick);
    if (result.winner !== null) { render(); finish(result.winner, Boolean(saved?.done)); break; }
    const { prompt } = result;
    let response;
    if (quick) response = redo[replayAt++];
    else if (prompt.player === FOE) {
      if (replayAt === redo.length && replayAt) { replayAt += 1; render(); } // acabou de retomar: desenha a mesa uma vez
      renderDock();
      await wait(prompt.type === M.SELECT_CHAIN ? 60 : 380);
      response = decideRush(prompt, { view: duel.snapshot(), me: FOE, cards, state: duel.state, memory: aiMemory, level: match.enemy.ai });
    } else {
      if (result.retry) toast('Essa jogada não vale agora. Tente outra.');
      response = await answer(prompt);
    }
    if (!response) { console.warn('sem resposta para', prompt); break; }
    responses.push(response);
    if (!quick) save();
    duel.respond(response);
  }
}

/* ---------- Fim do duelo ---------- */

function finish(winner, already) {
  const won = winner === ME;
  const result = won ? 'win' : winner === FOE ? 'loss' : 'draw';
  lpByTurn[Math.max(1, duel.state.turn)] = [Math.max(0, duel.state.lp[ME]), Math.max(0, duel.state.lp[FOE])];
  save({ done: true, winner, turns: duel.state.turn });
  if (!already) {
    const history = readJson('rushdaily-history', {});
    history[playerKey] = { ...(history[playerKey] || {}), [date]: history[playerKey]?.[date] === 'win' ? 'win' : result };
    writeJson('rushdaily-history', history);
    // Booster sorteado pela chave do jogador: cada um tira cartas diferentes do mesmo desafio.
    if (won && !readJson(`rushdaily-classic-booster:${playerKey}:${date}`, null)) {
      writeJson(`rushdaily-reward:${playerKey}:${date}`, { seed: `booster:${date}:${playerKey}`, difficulty, pending: true });
    }
    queueSync(0); // resultado sobe já, sem esperar a calma do agendamento
  }
  current = null;
  renderDock();
  renderTurn();
  const reason = duel.state.reason;
  const limit = reason === 'turnos';
  const deckOut = reason === 2;
  $('#result').dataset.result = won ? 'player' : winner === FOE ? 'enemy' : 'draw';
  $('#result-kicker').textContent = `${match.player.label} contra ${match.enemy.label} · ${settings.label} · turno ${Math.min(duel.state.turn, FORMAT.turnLimit)}`;
  $('#result-title').textContent = won ? 'Vitória' : winner === FOE ? 'Derrota' : 'Empate';
  $('#result-copy').textContent = won
    ? `${limit ? `No limite de ${FORMAT.turnLimit} turnos, você tinha mais PV.` : deckOut ? 'O deck do rival acabou.' : reason === 1 ? 'Os pontos de vida do rival chegaram a zero.' : 'Um efeito decidiu o duelo a seu favor.'} Seu booster clássico está liberado e a peça do dia ${Number(date.slice(8))} entrou no Enigma.`
    : `${limit ? `No limite de ${FORMAT.turnLimit} turnos, ${winner === FOE ? 'o rival tinha mais PV' : 'os PV estavam iguais'}.` : deckOut ? 'Seu deck acabou antes do rival.' : 'Seus pontos de vida chegaram a zero.'} A revanche usa a mesma seed: as cartas chegam na mesma ordem.`;
  $('#result-main').textContent = won ? 'Abrir booster clássico' : 'Voltar ao desafio';
  $('#result-main').href = won ? `screens.html?screen=reward&player=${playerKey}` : `index.html?player=${playerKey}`;
  if (won) scene.burst(GOLD);
  setTimeout(() => $('#result').open || $('#result').showModal(), motion ? 700 : 0);
}

/* ---------- Coração das Cartas ---------- */

/** O poder consome o Enigma: ele explode em partes e o jogador recomeça a montar. */
async function shatterEnigma() {
  // Sem o modelo do Enigma (etapa enigma do setup), só o clarão dourado.
  const model = await fetch('src/assets/puzzle/puzzle.json', { method: 'HEAD' }).then((response) => response.ok, () => false);
  if (!model) return wait(400);
  const overlay = $('#enigma-burst');
  overlay.hidden = false;
  return new Promise((resolve) => {
    let closed = false;
    const close = (view3d) => { if (closed) return; closed = true; view3d?.dispose?.(); overlay.hidden = true; resolve(); };
    const view3d = puzzleScene($('#enigma-canvas'), { explode: true, total: daysInMonth(), reduced: !motion, onDone: () => close(view3d) });
    setTimeout(() => close(view3d), motion ? 4200 : 600); // se o modelo não carregar, não trava a mesa
  });
}

$('#heart').addEventListener('click', async () => {
  const prompt = current?.prompt;
  const index = prompt?.type === M.SELECT_IDLECMD ? prompt.activates.findIndex(isHeart) : -1;
  if (index < 0) return;
  const pending = current;
  current = null; // segura a mesa enquanto o Enigma explode
  renderDock();
  useHeart(playerKey);
  await shatterEnigma();
  scene.burst(GOLD);
  current = pending;
  respond({ type: R.SELECT_IDLECMD, action: 5, index });
});

/* ---------- Botões e entrada ---------- */

$('#to-battle').addEventListener('click', () => respond({ type: R.SELECT_IDLECMD, action: 6, index: null }));
$('#to-end').addEventListener('click', () => {
  const prompt = current?.prompt;
  if (prompt) respond(prompt.type === M.SELECT_IDLECMD ? { type: R.SELECT_IDLECMD, action: 7, index: null } : { type: R.SELECT_BATTLECMD, action: 3, index: null });
});
$('#help-toggle').addEventListener('click', (event) => {
  const open = $('#help').hidden;
  $('#help').hidden = !open;
  event.currentTarget.setAttribute('aria-expanded', String(open));
});
$('#rematch').addEventListener('click', () => { removeKey(saveKey); location.reload(); });
// Grade para colar no grupo (sem cartas): o desafio do dia é igual para todos, então dá para comparar.
$('#share').addEventListener('click', async () => {
  const winner = duel.state.winner;
  const text = resultGrid({
    date, difficulty: settings.label, rating: settings.rating, outcome: winner === ME ? 'win' : winner === FOE ? 'loss' : 'draw',
    turns: Math.min(duel.state.turn, FORMAT.turnLimit), start: startLp, lpByTurn,
  });
  try {
    if (navigator.share && matchMedia('(pointer: coarse)').matches) { await navigator.share({ text }); return; }
    await navigator.clipboard.writeText(text);
    toast('Resultado copiado. Cole no grupo.');
  } catch (error) {
    if (error?.name !== 'AbortError') toast(text);
  }
});
$('#leave').href = `index.html?player=${playerKey}`;
const alignMat = () => { const { x, y } = center($('#midline')); scene.centerOn(x, y); };
addEventListener('resize', alignMat);

// Primeiro duelo: três dicas curtas apontando a mão e os botões.
function startTips() {
  const steps = [
    ['Arraste uma carta da sua mão até uma zona acesa. No Rush, invoque quantos monstros quiser.', '#hand'],
    ['Toque numa carta para ler e ver as ações. Toque duas vezes na mão para baixar virada.', '#hand'],
    ['Quem começa não ataca no primeiro turno. Encerre quando terminar.', '#to-end'],
  ];
  let step = 0;
  const show = () => {
    document.querySelectorAll('.tip-target').forEach((node) => node.classList.remove('tip-target'));
    if (step >= steps.length) { $('#tip').hidden = true; return; }
    $('#tip').hidden = false;
    $('#tip-text').textContent = `${step + 1}/${steps.length}  ${steps[step][0]}`;
    $('#tip-next').textContent = step === steps.length - 1 ? 'Entendi' : 'Próxima';
    $(steps[step][1]).classList.add('tip-target');
  };
  $('#tip-next').addEventListener('click', () => { step += 1; show(); });
  $('#tip-skip').addEventListener('click', () => { step = steps.length; show(); });
  show();
}

$('#field').insertAdjacentHTML('afterbegin', '<div id="zones" class="zones-grid"></div>');
$('#player-key').textContent = playerKey;
$('#foe-name').innerHTML = `Rival <span class="who-key">${escape(match.enemy.label)}</span>`;
$('#matchup-chip').innerHTML = `${escape(match.player.label)} <i>contra</i> ${escape(match.enemy.label)} · ${escape(settings.label)}`;
bindGestures();
render();
alignMat();
warmRushCards([...view[ME].hand, ...view[ME].extra].filter(Boolean).map((card) => cardOf(card.code)));
// Entrada vinda da home: abre o clarão só depois do primeiro quadro desenhado (com a mesa pronta).
if (document.body.classList.contains('entering')) {
  requestAnimationFrame(() => requestAnimationFrame(() => {
    document.body.classList.add('reveal');
    setTimeout(() => document.body.classList.remove('entering', 'reveal'), 1300);
  }));
}
const resuming = Boolean(saved?.responses?.length);
pump(saved?.responses || []);
if (!resuming) {
  log(`Você começa contra ${match.enemy.label}${withHeart ? '. O Coração das Cartas está com você' : ''}. Quem começa não ataca no primeiro turno.`);
  if (!readJson('rushdaily-seen-help', false)) { startTips(); writeJson('rushdaily-seen-help', true); }
}
window.__duel = { cards, match, duel, view: () => view, current: () => current, responses: () => responses.length, respond, actionsFor, dropTargets }; // testes automáticos
