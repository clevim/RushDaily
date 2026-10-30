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
import { RUSH_BACK, paintRushCards, rushImg, warmRushCards } from './rush-render.js';
import { answerCommon, chainSkipper, createAsk, soleChoice } from './ocg-ask.js';
import { POS_TITLE, RIVAL_TURN, TRAP_SET_WHY, addMenuCorner, bindCardGestures, bindSurrender, confirmSurrender, monsterWhyNot, openDuelMenu, runTips, tapText, turnChipTitle, whereLabel } from './card-gestures.js';
import { armConfirm, battleForecast, createPacer, disarmConfirm, escape, getPlayerKey, heartUnlocked, readJson, reducedMotion, removeKey, settingsFor, today, toast, useHeart, writeJson } from './common.js';
import { maximumTrios } from './maximum.js';
import { duelScene, enigmaBurst, enigmaMini } from './scene.js';
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
const pacer = createPacer(playerKey, motion); // velocidade 1x/2x e "pular" (toque na mesa)
const wait = pacer.wait;
const GOLD = 0xf5b21a;
const RED = 0xe0303f;
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
document.body.classList.toggle('calm', !motion); // "reduzir animações" dos Ajustes também para o CSS (brilho do Enigma)

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
// Cada tentativa embaralha de novo: seed aleatória guardada na partida salva (retomar repete as mesmas cartas). Saves antigos sem seed mantêm a do dia.
const duelSeed = saved ? (saved.seed || match.seed) : `${match.seed}:${crypto.getRandomValues(new Uint32Array(1))[0]}`;
const duel = createDuel(lib, { seed: duelSeed, format: FORMAT, decks, lp: startLp, hands: match.enemy.hand ? [FORMAT.hand, match.enemy.hand] : null, skills: withHeart ? [{ team: ME, code: HEART_CODE }] : [], cards, readScript, onError: (text) => console.warn('[motor]', text) });
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

const at = (row, col) => `style="grid-area:${row}/${col}" data-col="${col}"`; // data-col: no celular o lado do rival encosta no centro

const lastDef = new Map(), lastDown = new Map();
const wasMax = new Set();
function slot(controller, location, sequence, card, place, extraClass = '', max = null) {
  const key = locKey(controller, location, sequence);
  const spell = location === L.SZONE;
  const base = `zone ${spell ? 'szone' : 'mzone'} ${extraClass} ${controller === ME ? 'mine' : 'theirs'}`;
  if (!card) return `<div class="${base} empty" data-loc="${key}" ${place}></div>`;
  const data = cardOf(card.code);
  const hidden = isFaceDown(card) && controller !== ME;
  const classes = [base, 'filled'];
  if (max) { // Modo Máximo: três zonas, um monstro só; o ATK MÁXIMO fica no centro, as peças laterais não têm números
    classes.push('max', `max-${max.role.toLowerCase()}`);
    if (!wasMax.has(max.id)) classes.push('max-arrive');
  }
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
  }
  if (actionsFor(key).some((item) => item.action === 5)) classes.push('can-act'); // efeito ativável agora (vem do prompt do motor; vale carta do rival, ex.: Magia de Campo que os dois usam)
  if (controller === ME && current?.prompt.type === M.SELECT_BATTLECMD && actionsFor(key).some((item) => item.action === 'attack')) classes.push('ready');
  let label = hidden ? (spell ? 'Carta baixada do rival' : 'Monstro virado do rival')
    : `${data.name}${isFaceDown(card) ? ', virada' : ''}${location === L.MZONE && !isFaceDown(card) ? `, ${isDefense(card) ? 'Defesa' : 'Ataque'}, ATK ${card.attack}, DEF ${card.defense}` : ''}${controller === ME ? '' : ' (do rival)'}`;
  if (max) label = max.role === 'C' ? `${data.name}, monstro Máximo, ATK MÁXIMO ${card.attack}${controller === ME ? '' : ' (do rival)'}` : `${data.name}, peça ${max.role === 'L' ? 'esquerda' : 'direita'} do monstro Máximo${controller === ME ? '' : ' (do rival)'}`;
  return `<div class="${classes.join(' ')}" data-loc="${key}" ${place}${classes.includes('can-pos') ? ` title="${POS_TITLE}"` : ''}>
    <button class="card face" type="button" data-loc="${max && max.role !== 'C' ? max.center : key}" ${max && max.role !== 'C' ? 'data-side' : ''} data-gesture aria-label="${escape(label)}">${isFaceDown(card) ? back() : face(data, location === L.MZONE && !max ? card : null)}${max?.role === 'C' ? `<span class="max-badge" aria-hidden="true"><i>ATK MÁX</i><b>${card.attack}</b></span>` : ''}</button></div>`;
}

const PILE_LOCATION = { deck: L.DECK, extra: L.EXTRA, grave: L.GRAVE };
/** Cartas desta pilha com ação na pergunta atual (efeito do Cemitério, Invocação do Adicional ou do Deck). */
function pileActions(controller, kind) {
  const prompt = current?.prompt;
  const lists = prompt?.type === M.SELECT_IDLECMD ? [prompt.summons, prompt.special_summons, prompt.activates] : prompt?.type === M.SELECT_BATTLECMD ? [prompt.chains] : [];
  return lists.flat().filter((loc) => loc.controller === controller && loc.location === PILE_LOCATION[kind]);
}
function pile(controller, kind, count, top, place) {
  const labels = { deck: 'Deck', extra: 'Adicional', grave: 'Cemitério' };
  const short = { deck: 'Deck', extra: 'Adic.', grave: 'Cem.' };
  const art = kind === 'grave' ? (top ? face(cardOf(top.code)) : '') : count ? back() : '';
  const side = controller === ME ? 'seu' : 'do rival';
  return `<button class="pile ${kind} ${controller === ME ? 'mine' : 'theirs'} ${kind === 'deck' && count <= 6 ? 'low' : ''} ${pileActions(controller, kind).length ? 'can-act' : ''}" type="button" data-pile="${controller}:${kind}" ${place} aria-label="${labels[kind]} ${side}: ${count} cartas${kind === 'deck' && controller === ME ? '. Segure para desistir' : ''}">${art}<span class="pile-name" data-short="${short[kind]}">${labels[kind]}</span><span class="pile-count">${count}</span></button>`;
}

/**
 * Tapete Rush em 5 colunas: Campo, 3 zonas e Cemitério na linha dos monstros; Adicional, 3 zonas e Deck na de baixo.
 * Você embaixo; o rival espelhado em cima (o Deck dele fica no canto de cima à esquerda). A linha 3 é a faixa do meio.
 */
function renderField() {
  const cells = [], now = new Set();
  for (const controller of [FOE, ME]) {
    const side = view[controller];
    const mine = controller === ME;
    const monsterRow = mine ? 4 : 2;
    const spellRow = mine ? 5 : 1;
    const column = (seq) => (mine ? seq + 1 : 5 - seq);
    const trios = maximumTrios(side.monsters, cardOf);
    for (const seq of RUSH_ZONES.monsters) {
      const role = trios.get(seq);
      cells.push(slot(controller, L.MZONE, seq, side.monsters[seq], at(monsterRow, column(seq)), '', role && { role, id: `${controller}`, center: locKey(controller, L.MZONE, [...trios].find(([, r]) => r === 'C')[0]) }));
    }
    if (trios.size) now.add(`${controller}`);
    for (const seq of RUSH_ZONES.spells) cells.push(slot(controller, L.SZONE, seq, side.spells[seq], at(spellRow, column(seq))));
    cells.push(slot(controller, L.SZONE, RUSH_ZONES.field, side.spells[RUSH_ZONES.field], at(monsterRow, mine ? 1 : 5), 'fzone'));
    const grave = side.grave.filter(Boolean);
    cells.push(pile(controller, 'grave', grave.length, grave.at(-1), at(monsterRow, mine ? 5 : 1)));
    cells.push(pile(controller, 'extra', side.extra.filter(Boolean).length, null, at(spellRow, mine ? 1 : 5)));
    cells.push(pile(controller, 'deck', side.deck, null, at(spellRow, mine ? 5 : 1)));
  }
  $('#zones').innerHTML = cells.join('');
  wasMax.clear();
  now.forEach((id) => wasMax.add(id));
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
    const pose = { set: Boolean(poses.get(key)?.set) };
    const playable = actionsFor(key).length > 0;
    const canAct = actionsFor(key).some((item) => item.action === 5);
    const stats = isMonster(data) ? `, Nível ${data.level & 0xff}, ATK ${data.atk}, DEF ${data.def}` : '';
    return `<button class="card hand-card ${playable ? 'playable' : ''} ${canAct ? 'can-act' : ''} ${pose.set ? 'set-pose' : ''}" style="--i:${index}" type="button" data-loc="${key}" data-gesture aria-label="${escape(`${data.name}${stats}${pose.set ? ', para baixar virada' : ''}${playable ? ', jogável' : ''}`)}">${pose.set ? back() : face(data)}${isMonster(data) && !pose.set ? `<span class="hand-stats" aria-hidden="true">${data.atk}</span>` : ''}</button>`; // ATK no topo: no celular a mão só mostra o topo
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
  $('#turn-chip').title = turnChipTitle(FORMAT.turnLimit);
  $('#phases').dataset.owner = active === ME ? 'player' : 'enemy';
}

function render() {
  view = duel.snapshot();
  renderField();
  renderHand();
  renderTurn();
  tweenLp(ME);
  tweenLp(FOE);
  gestures?.mark();
  paintRushCards(document.body);
}

/* ---------- Faixa do meio, registro e efeitos ---------- */

// Fases do motor: Compra (1), Apoio (2), Principal (4), Batalha (8 a 0x80), Final (0x200).
function setPhase(phase) {
  const name = phase <= 2 ? 'draw' : phase === 4 || phase === 0x100 ? 'main' : phase < 0x100 ? 'battle' : 'end';
  for (const node of document.querySelectorAll('#phases li')) node.toggleAttribute('aria-current', node.dataset.phase === name);
}

let historyTurn = 0;
function log(message, story = true) {
  const node = $('#log');
  node.innerHTML = `<span>${escape(message)}</span>${[...node.children].slice(0, 2).map((child) => child.outerHTML).join('')}`;
  if (!story) return; // só a faixa do meio (a narração já marca a virada do turno)
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
async function cast(code, controller, verb = 'ativou') {
  const node = $('#cast');
  const data = cardOf(code);
  node.dataset.owner = controller === ME ? 'player' : 'enemy';
  node.innerHTML = `<div class="card">${face(data)}</div><p>${controller === ME ? 'Você' : 'O rival'} ${verb} ${escape(data.name)}</p>`;
  paintRushCards(node);
  // Espera o desenho (até 600 ms); sem ele mostra o nome em destaque, nunca o verso (verso quer dizer carta virada).
  const img = node.querySelector('img[data-rush-card]');
  if (img) {
    const url = await Promise.race([rushImg(data).catch(() => null), new Promise((resolve) => setTimeout(resolve, motion ? 600 : 0))]);
    if (url) img.src = url; else node.querySelector('.card').innerHTML = `<span class="cast-name">${escape(data.name)}</span>`;
  }
  node.classList.add('show');
  await wait(controller === ME ? 450 : 950); // a sua ativação você já sabe: destaque curto; a do rival fica visível
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
      <span class="link-name"><b>${escape(cardOf(link.code).name)}</b><small>${link.state === 'solving' ? 'resolvendo' : link.state === 'done' ? 'resolvida' : link.state === 'negated' ? 'negada' : link.controller === ME ? 'você' : 'rival'}</small></span></li>`).join('');
  paintRushCards(box);
}
// Sem Corrente aberta, a pergunta de resposta diz o que acabou de acontecer (a última linha da narração).
const lastPlay = () => { const text = $('#log span')?.textContent; return text ? `Agora: ${escape(text)}` : ''; };
const chainNote = () => (chain.length ? `Corrente aberta: ${chain.map((link, index) => `${index + 1}. ${escape(cardOf(link.code).name)} (${link.controller === ME ? 'você' : 'rival'})`).join(' · ')}` : '');

/* ---------- Narração dos eventos do motor ---------- */

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
const lpByTurn = [];
const lpNow = [...startLp];
let turnSeen = 0;

async function play(events, quick) {
  for (const event of events) {
    switch (event.type) {
      case M.NEW_TURN:
        setPhase(1); // a vez começa na Compra (sem isso a faixa segue no Final do turno anterior durante a faixa "Sua vez")
        turnSeen += 1;
        if (turnSeen > 1) lpByTurn[turnSeen - 1] = [...lpNow];
        chain = [];
        if (!quick) {
          // A faixa do meio não fica com a última jogada do turno anterior (ex.: "O rival atacou" no começo da sua vez).
          log(event.player === ME ? `Turno ${Math.max(1, duel.state.turn)}: sua vez.` : `Turno ${Math.max(1, duel.state.turn)}: vez do rival.`, false);
          renderChain(); render(); await banner(event.player === ME ? 'Sua vez' : 'Vez do rival', event.player === ME ? 'player' : 'enemy');
        }
        break;
      case M.NEW_PHASE: setPhase(event.phase); fightBy = null; break;
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
        if (!quick) { renderChain(); await wait(chain[event.chain_size - 1]?.controller === ME ? 160 : 320); }
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
        if (!quick) await wait(chain.every((link) => link.controller === ME) ? 100 : 260);
        chain = [];
        if (!quick) renderChain();
        break;
      case M.ATTACK: {
        const attacker = view?.[event.card.controller]?.monsters[event.card.sequence];
        log(`${who(event.card.controller)} atacou${event.target ? '' : ' direto'}${attacker ? ` com ${cardOf(attacker.code).name}` : ''}.`);
        fightBy = event.target ? event.card.controller : null; // dano no próprio atacante: o alvo era mais forte
        if (!quick && motion) await lunge(event);
        break;
      }
      case M.ATTACK_DISABLED: log('O ataque foi anulado.'); break;
      case M.DAMAGE: case M.PAY_LPCOST:
        lpNow[event.player] = Math.max(0, lpNow[event.player] - event.amount);
        if (!quick) { floatText(`−${event.amount.toLocaleString('pt-BR')}`, plateOf(event.player), event.player === ME ? 'damage' : 'deal'); scene.shake(Math.min(1, event.amount / 2500)); }
        if (event.type === M.DAMAGE) log(damageLine(event));
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
  await Promise.race([animation.finished.catch(() => {}), new Promise((resolve) => setTimeout(resolve, 900))]); // aba em segundo plano: a animação não termina
}

/* ---------- O que dá para fazer agora (pergunta aberta) ---------- */

let current = null; // { prompt, resolve }
let gestures = null; // card-gestures.js (ligado no fim do arquivo)
const poses = new Map(); // carta da mão -> { set }
const defaultPose = (card) => ({ set: Boolean(card.type & TYPE.TRAP) });
const plan = { target: null, tributes: null, zone: null };
const chainSkip = chainSkipper(); // "Não responder mais": vale para as cartas já oferecidas nesta fase (ocg-ask.js)

const IDLE_LABELS = { 0: 'Invocar por Normal', 1: 'Invocar por Especial', 2: 'Mudar posição', 3: 'Baixar em defesa (virado)', 4: 'Baixar', 5: 'Ativar' };
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
  poses.clear(); // a mão reordena: a pose escolhida não vale para a carta que ocupar o lugar
  gestures.reset();
  renderDock();
  resolve(response);
}

/* ---------- Alvos de arrastar ---------- */

/** Previsão do combate no alvo aceso (common.js). */
const forecast = (attacker, target) => battleForecast(attacker.attack, target && { hidden: isFaceDown(target), defense: isDefense(target), attack: target.attack, def: target.defense });

function dropTargets(key) {
  const prompt = current?.prompt;
  if (!prompt) return [];
  const [controller, location, sequence] = key.split(':').map(Number);
  if (controller !== ME) return [];
  if (prompt.type === M.SELECT_BATTLECMD && location === L.MZONE) {
    const attack = actionsFor(key).find((item) => item.action === 'attack');
    if (!attack) return [];
    const loc = prompt.attacks[attack.response.index];
    const attacker = view[ME].monsters[sequence];
    // peças laterais do Máximo não são alvo de ataque
    const foeMax = maximumTrios(view[FOE].monsters, cardOf);
    const targets = RUSH_ZONES.monsters.filter((seq) => view[FOE].monsters[seq] && !'LR'.includes(foeMax.get(seq) || '-')).map((seq) => ({ node: `.zone[data-loc="${locKey(FOE, L.MZONE, seq)}"]`, target: { controller: FOE, sequence: seq }, response: attack.response, forecast: attacker && forecast(attacker, view[FOE].monsters[seq]) }));
    if (loc.can_direct) targets.push({ node: '#foe-plate', target: null, response: attack.response, forecast: attacker && forecast(attacker, null) });
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

/* ---------- Gestos: tocar, tocar duas vezes, segurar, arrastar; teclado ---------- */

function bindGestures() {
  const rushTarget = (key) => (cardOf(cardAt(key)?.code).level & 0xff) >= 5 && key.split(':')[1] === String(L.HAND);
  const gestures = bindCardGestures({
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
    paint: paintRushCards,
    doubleTap: onDoubleTap,
    dragHint: (key) => (rushTarget(key) ? 'Solte numa zona livre ou em cima do monstro que vai virar tributo.' : null),
    beforeDown(event) { if (!$('#help').hidden && !event.target.closest('#help, #help-toggle')) $('#help-toggle').click(); },
  });
  document.addEventListener('click', (event) => {
    const pileNode = event.target.closest('[data-pile]');
    if (pileNode) { const [controller, kind] = pileNode.dataset.pile.split(':'); openPile(Number(controller), kind); }
  });
  return gestures;
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

/* ---------- Leitura da carta com as ações ---------- */

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
  // Campo: o mesmo texto do clássico (card-gestures.js), a partir do que o motor marcou neste turno.
  const { marks } = duel.state;
  if (location === L.SZONE) return live && isFaceDown(live) && card.type & TYPE.TRAP && marks.set.has(key) ? TRAP_SET_WHY : null;
  if (location === L.MZONE) {
    return monsterWhyNot({ battle, canBattle: Boolean(prompt.to_bp), firstTurn: duel.state.turn === 1, summoned: marks.summoned.has(key), set: marks.set.has(key),
      moved: marks.moved.has(key), attacked: marks.attacked.has(key), attackPos: Boolean(live) && !isDefense(live) });
  }
  if (battle) return 'Na Batalha só dá para atacar. Cartas da mão são jogadas na Fase Principal.';
  if (isMonster(card)) {
    const level = card.level & 0xff;
    const need = level >= 7 ? 2 : level >= 5 ? 1 : 0;
    const have = RUSH_ZONES.monsters.filter((seq) => view[ME].monsters[seq]).length;
    if (need > have) return `Monstro de Nível ${level} pede ${need} tributo${need > 1 ? 's' : ''}: ${need > 1 ? 'monstros seus' : 'um monstro seu'} no campo que vai para o Cemitério para ele entrar. Você tem ${have} no campo.`;
    if (have >= RUSH_ZONES.monsters.length) return 'Suas 3 zonas de monstro estão ocupadas.';
  }
  return 'O que a carta pede ainda não aconteceu: leia o [REQUISITO] (ou os materiais da Fusão) no texto acima.';
}

/** Conteúdo da leitura (card-gestures.js mostra e liga as ações). */
function describeCard(key) {
  const live = cardAt(key);
  if (!live) return null;
  const [controller, location] = key.split(':').map(Number);
  const hidden = controller !== ME && (isFaceDown(live) || location === L.HAND);
  const data = cardOf(live.code);
  return { hidden, html: hidden ? back() : face(data), name: data.name, stats: cardStats(data, location === L.MZONE ? live : null), text: data.desc };
}
const showZoom = (key, options) => gestures.info(key, options);

/* ---------- Diálogos (ocg-ask.js) ---------- */

const askBase = createAsk({ dialog: $('#ask'), title: $('#ask-title'), items: $('#ask-items'), actions: $('#ask-actions'), note: $('#ask-note'), paint: paintRushCards });
// Pergunta aberta: o topo e o Deck ficam inertes atrás do modal; o "⋯" no canto leva às opções (desistir), sem assustar.
const ask = (options) => { const choice = askBase(options); addMenuCorner($('#ask'), duel.state.winner === null ? surrender : null); return choice; };
function cardItem(loc) {
  const live = loc.location === L.MZONE || loc.location === L.SZONE ? cardAt(locKey(loc.controller, loc.location, loc.sequence)) : null;
  const hidden = loc.controller !== ME && ((live && isFaceDown(live)) || loc.location === L.HAND || loc.location === L.DECK);
  const where = whereLabel(loc.location, loc.controller === ME);
  return { html: hidden || !loc.code ? back() : face(cardOf(loc.code), loc.location === L.MZONE ? live : null), label: hidden ? `Carta virada · ${where}` : `${cardOf(loc.code).name} · ${where}`,
    info: hidden || !loc.code ? null : { name: cardOf(loc.code).name, stats: cardStats(cardOf(loc.code), loc.location === L.MZONE ? live : null), text: cardOf(loc.code).desc } };
}
// Título das seleções: a dica do motor (ou o genérico) e, quando se sabe, a carta cujo efeito pediu.
const hint = (fallback) => {
  const text = (duel.state.hint && describe(duel.state.hint, cards)) || fallback;
  return duel.state.source ? `${cardOf(duel.state.source).name}: ${text}` : text;
};
const askContext = () => ({
  ask: (options) => ask({ note: chainNote(), ...options }), me: ME, cards, cardOf, cardItem, face, back, hint, plan, toast,
  describe: (description, args) => describe(description, cards, args), races: RACES, attributes: ATTRIBUTES, inDuel: new Set(deckIds),
});

/* ---------- Respostas do jogador ---------- */

function renderDock() {
  const prompt = current?.prompt;
  const idle = prompt?.type === M.SELECT_IDLECMD;
  const battle = prompt?.type === M.SELECT_BATTLECMD;
  $('#to-battle').hidden = !(idle && prompt.to_bp);
  $('#to-end').hidden = !(idle || battle) || !prompt.to_ep;
  disarmConfirm($('#to-end'));
  // Sem mais nada a fazer (nenhuma jogada, nenhum ataque), Encerrar vira o botão principal.
  const moves = idle ? [prompt.summons, prompt.special_summons, prompt.pos_changes, prompt.monster_sets, prompt.spell_sets, prompt.activates.filter((loc) => !isHeart(loc))].some((list) => list.length) : battle && (prompt.attacks.length || prompt.chains.length);
  $('#to-end').classList.toggle('ghost', Boolean(moves || (idle && prompt.to_bp)));
  renderSkill();
  const hintNode = $('#hint');
  hintNode.classList.toggle('live', Boolean(battle)); // no celular a dica só aparece quando importa (na Batalha: como atacar)
  if (duel.state.winner !== null) hintNode.textContent = '';
  else if (idle) hintNode.textContent = tapText('Toque numa carta para ver as ações, ou arraste da mão para o campo (Invocações ilimitadas). Toque duas vezes: jogar ou baixar.');
  else if (battle) hintNode.textContent = prompt.attacks.length ? tapText('Toque no seu monstro aceso para atacar (ou arraste-o até o alvo).') : 'Nenhum ataque disponível. Encerre o turno.';
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
      if (chainSkip.skips(prompt, duel.state)) return { type: R.SELECT_CHAIN, index: null };
      // Efeito obrigatório com uma opção só: não há o que escolher, só avisa.
      if (soleChoice(prompt) >= 0) { toast(`Efeito obrigatório: ${cardOf(prompt.selects[0].code).name}.`); return { type: R.SELECT_CHAIN, index: 0 }; }
      render();
      const items = prompt.selects.map((loc) => ({ ...cardItem(loc), label: `${cardOf(loc.code).name}: ${describeActivate(loc).replace(/^Ativar: ?/, '') || 'ativar'}` }));
      if (!prompt.forced) items.push({ label: 'Não responder mais com estas cartas nesta fase' });
      const chosen = await ask({ title: prompt.forced ? 'Escolha o efeito obrigatório' : chain.length ? `Responder à Corrente ${chain.length}?` : 'Ativar uma carta agora?', note: chainNote() || lastPlay(), items, cancel: !prompt.forced });
      if (chosen && chosen[0] === prompt.selects.length) { chainSkip.remember(prompt, duel.state); return { type: R.SELECT_CHAIN, index: null }; }
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
  if (kind === 'deck') {
    // O Deck não aparece no snapshot: oferece só as cartas que a pergunta atual deixa usar de lá.
    const options = pileActions(controller, kind).flatMap((loc) => actionsFor(locKey(loc.controller, loc.location, loc.sequence)).map((item) => ({ loc, item })))
      .filter((option, index, all) => all.findIndex((other) => other.item.response.action === option.item.response.action && other.item.response.index === option.item.response.index) === index);
    if (!options.length) { toast(`${controller === ME ? 'Seu Deck' : 'Deck do rival'}: ${view[controller].deck} cartas.`); return; }
    const chosen = await ask({ title: 'Do seu Deck', items: options.map(({ loc, item }) => ({ html: face(cardOf(loc.code)), label: `${cardOf(loc.code).name} · ${item.label}` })), cancel: true });
    if (chosen && current) respond(options[chosen[0]].item.response);
    return;
  }
  const location = { extra: L.EXTRA, grave: L.GRAVE }[kind];
  const list = view[controller][kind].filter(Boolean);
  if (controller !== ME && kind === 'extra') { toast(`Deck Adicional do rival: ${list.length} cartas.`); return; }
  if (!list.length) { toast('Nenhuma carta aqui.'); return; }
  const entries = list.map((card) => ({ card, key: locKey(controller, location, card.sequence) }));
  const items = entries.map(({ card, key }) => {
    const actions = controller === ME ? actionsFor(key) : [];
    // info: segurar (ou o "i") lê a carta sem escolher, como em qualquer outro lugar.
    return { ...cardItem({ controller, location, sequence: card.sequence, code: card.code }), label: actions.length ? `${cardOf(card.code).name} · ${actions[0].label}` : cardOf(card.code).name };
  });
  const title = kind === 'extra' ? 'Seu Deck Adicional (Fusões e Rituais)' : controller === ME ? 'Seu Cemitério' : 'Cemitério do rival';
  const chosen = await ask({ title: tapText(`${title}: toque numa carta`), items, cancel: true });
  if (!chosen) return;
  const { key } = entries[chosen[0]];
  showZoom(key, { focus: true });
}

/* ---------- Laço do duelo ---------- */

function save(extra = {}) {
  writeJson(saveKey, { v: 2, seed: duelSeed, heart: withHeart, responses, ...(surrendered && { surrender: true }) });
}

/* ---------- Desistir (segurar o Deck): termina como derrota pelo fluxo normal ---------- */

let surrendered = false;
function surrender() {
  if (surrendered || duel.state.winner !== null) return;
  surrendered = true;
  duel.state.winner = FOE;
  duel.state.reason = 'desistiu';
  if ($('#ask').open) $('#ask').close(); // pergunta do motor aberta: fica sem resposta (o duelo acabou)
  save();
  render();
  finish(FOE, false);
}
bindSurrender({
  enabled: () => !surrendered && duel.state.winner === null, // a qualquer momento
  async onHold() { if (await confirmSurrender()) surrender(); },
});

async function pump(redo = []) {
  let replayAt = 0;
  for (;;) {
    const result = duel.next();
    const quick = replayAt < redo.length;
    await play(result.events, quick);
    if (surrendered) break; // desistiu durante as animações
    if (result.winner !== null) { render(); finish(result.winner, Boolean(saved?.done)); break; }
    const { prompt } = result;
    let response;
    if (quick) response = redo[replayAt++];
    else if (prompt.player === FOE) {
      if (replayAt === redo.length && replayAt) { replayAt += 1; render(); } // acabou de retomar: desenha a mesa uma vez
      renderDock();
      // Pausa só antes de uma jogada nova (~250 ms); zona, posição e alvo seguem a jogada, e Corrente vazia passa direto.
      const pause = prompt.type === M.SELECT_IDLECMD || prompt.type === M.SELECT_BATTLECMD ? 250 : prompt.type === M.SELECT_CHAIN && prompt.selects.length ? 60 : 0;
      if (pause) await wait(pause);
      if (surrendered) break;
      response = decideRush(prompt, { view: duel.snapshot(), me: FOE, cards, state: duel.state, memory: aiMemory, level: match.enemy.ai });
    } else {
      if (saved?.surrender) { surrender(); break; } // desistiu antes de recarregar
      if (result.retry) toast('Essa jogada não vale agora. Tente outra.');
      response = await answer(prompt);
    }
    if (surrendered) break;
    if (!response) { console.warn('sem resposta para', prompt); break; }
    responses.push(response);
    if (!quick) save();
    duel.respond(response);
  }
}

/* ---------- Fim do duelo ---------- */

let rewardDay = date; // qual booster esta vitória liberou (null: o desta dificuldade já saiu hoje)
let firstWin = true; // 1ª vitória do dia: é ela que traz a peça do Enigma
function finish(winner, already) {
  const won = winner === ME;
  const result = won ? 'win' : winner === FOE ? 'loss' : 'draw';
  lpByTurn[Math.max(1, duel.state.turn)] = [Math.max(0, duel.state.lp[ME]), Math.max(0, duel.state.lp[FOE])];
  save({ done: true, winner, turns: duel.state.turn });
  if (!already) {
    const history = readJson('rushdaily-history', {});
    firstWin = history[playerKey]?.[date] !== 'win';
    history[playerKey] = { ...(history[playerKey] || {}), [date]: history[playerKey]?.[date] === 'win' ? 'win' : result };
    writeJson('rushdaily-history', history);
    // Booster sorteado pela chave do jogador: cada um tira cartas diferentes do mesmo desafio.
    // Um booster por dificuldade vencida no dia ("dia~<id>"); a peça vem só com a 1ª vitória do dia.
    if (won) {
      const day = `${date}~${difficulty}`;
      rewardDay = readJson(`rushdaily-classic-booster:${playerKey}:${day}`, null) || readJson(`rushdaily-reward:${playerKey}:${day}`, null) ? null : day;
      if (rewardDay) writeJson(`rushdaily-reward:${playerKey}:${rewardDay}`, { seed: `booster:${rewardDay}:${playerKey}`, difficulty, pending: true });
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
    ? `${limit ? `No limite de ${FORMAT.turnLimit} turnos, você tinha mais PV.` : deckOut ? 'O deck do rival acabou.' : reason === 1 ? 'Os pontos de vida do rival chegaram a zero.' : 'Um efeito decidiu o duelo a seu favor.'} ${rewardDay && firstWin ? `Seu booster clássico está liberado e a peça do dia ${Number(date.slice(8))} entrou no Enigma.` : rewardDay ? `Booster ${settings.label} liberado; a peça do Enigma é uma por dia.` : `O booster ${settings.label} de hoje já saiu: vença em outra dificuldade para ganhar o dela.`}`
    : `${limit ? `No limite de ${FORMAT.turnLimit} turnos, ${winner === FOE ? 'o rival tinha mais PV' : 'os PV estavam iguais'}.` : reason === 'desistiu' ? 'Você desistiu da partida.' : deckOut ? 'Seu deck acabou antes do rival.' : 'Seus pontos de vida chegaram a zero.'} A revanche embaralha os decks de novo.`;
  $('#result-main').textContent = won && rewardDay ? 'Abrir booster clássico' : 'Voltar ao desafio';
  $('#result-main').href = won && rewardDay ? `screens.html?screen=reward&player=${playerKey}` : `index.html?player=${playerKey}`;
  if (won) scene.burst(GOLD);
  setTimeout(() => $('#result').open || $('#result').showModal(), motion ? 700 : 0);
}

/* ---------- Coração das Cartas ---------- */

// Miniatura do Enigma do Milênio na sua placa: pronto (brilha), espera (fora da Fase Principal), usado e sem carga.
let heartSpent = false;
let liveEnigma = null;
const SKILL_NOTE = { ready: 'Pronto: toque para ativar', wait: 'Use na sua Fase Principal', used: 'Usado neste duelo', empty: 'Sem carga: complete o Enigma do mês' };
function skillState() {
  if (!withHeart) return 'empty';
  const prompt = current?.prompt;
  const idle = prompt?.type === M.SELECT_IDLECMD;
  if (idle && prompt.activates.some(isHeart)) return 'ready';
  if (heartSpent || (idle && prompt.player === ME)) { heartSpent = true; return 'used'; } // a Skill é uma vez por duelo: na Principal sem ela, já foi
  return duel.state.winner !== null ? 'used' : 'wait';
}
function renderSkill() {
  const state = skillState();
  $('#skill').dataset.state = state;
  $('#heart').setAttribute('aria-disabled', String(state !== 'ready'));
  $('#skill-state').textContent = SKILL_NOTE[state];
}
/** Miniatura 3D do Enigma (procedural, scene.js); sem WebGL fica o desenho em SVG. */
function startLiveEnigma() {
  liveEnigma = enigmaMini($('#skill .enigma-live'), { reduced: !motion });
  $('#skill').classList.toggle('live', Boolean(liveEnigma));
}
// Peças do desenho do Enigma (as mesmas emendas da miniatura): a pirâmide se desfaz nelas quando não há o modelo 3D.
const ENIGMA_PIECES = [
  '7.5,15 19.5,15 19.5,27 14.1,27', '19.5,15 44.5,15 44.5,27 19.5,27', '44.5,15 56.5,15 49.9,27 44.5,27',
  '14.1,27 26,27 26,39 20.7,39', '26,27 38,27 38,39 26,39', '38,27 49.9,27 43.3,39 38,39',
  '20.7,39 32,39 32,49 26.2,49', '32,39 43.3,39 37.8,49 32,49', '26.2,49 37.8,49 32,59.5', '13,9.5 51,9.5 56.5,15 7.5,15',
];
function enigmaFlyer() {
  const icon = $('#skill .enigma-icon');
  const eye = icon.querySelector('.enigma-eye').outerHTML;
  const pieces = ENIGMA_PIECES.map((points, index) => `<polygon class="fly-piece${index === 9 ? ' top' : ''}" points="${points}" fill="url(#fly-front)" />`).join('');
  return `<svg class="enigma-icon enigma-fly" viewBox="4 1 56 60" aria-hidden="true"><defs><linearGradient id="fly-front" gradientUnits="userSpaceOnUse" x1="10" y1="10" x2="40" y2="60"><stop offset="0" class="stop-hi" /><stop offset="0.55" class="stop-mid" /><stop offset="1" class="stop-deep" /></linearGradient></defs>
    <ellipse class="enigma-loop fly-piece" cx="32" cy="5.2" rx="4.6" ry="2.6" />${pieces}${eye.replace('class="enigma-eye"', 'class="enigma-eye fly-piece"')}</svg>`;
}

/**
 * O poder consome o Enigma: a miniatura da placa cresce até o centro, brilha e se desfaz em peças; depois a Skill ativa.
 * Em 3D (enigmaBurst) quando há WebGL; senão, as peças do desenho em SVG. ~1,8 s. Com "reduzir animações": só um brilho.
 */
async function shatterEnigma() {
  const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
  const skill = $('#skill');
  if (!motion) { skill.classList.add('flash'); await sleep(450); skill.classList.remove('flash'); return; }
  const overlay = $('#enigma-burst');
  const from = $('#heart').getBoundingClientRect();
  overlay.insertAdjacentHTML('afterbegin', '<div class="enigma-rays" aria-hidden="true"></div>'); // atrás do 3D
  const rays = overlay.querySelector('.enigma-rays');
  const glow = () => {
    overlay.classList.add('glowing');
    rays.animate([{ opacity: 0, transform: 'translate(-50%, -50%) scale(0.3) rotate(0deg)' }, { opacity: 1, transform: 'translate(-50%, -50%) scale(1) rotate(40deg)' }], { duration: 480, easing: 'ease-out', fill: 'forwards' });
    scene.burst(GOLD);
  };
  overlay.classList.add('flying');
  overlay.hidden = false;
  skill.classList.add('spent');
  const angle = liveEnigma?.angle?.() ?? 0;
  liveEnigma?.dispose();
  liveEnigma = null;
  // Teto de 2,5 s: aba em segundo plano ou WebGL perdido nunca chamam onDone/terminam o quadro, e o duelo travaria aqui.
  let burst = null;
  await new Promise((resolve) => {
    setTimeout(resolve, 2500);
    burst = enigmaBurst($('#enigma-canvas'), { from, angle, onGlow: glow, onDone: resolve });
    if (!burst) flyPieces(overlay, from, glow).then(resolve); // sem WebGL: o desenho faz o mesmo caminho
  });
  burst?.dispose();
  rays.animate([{ opacity: 1 }, { opacity: 0 }], { duration: 200, fill: 'forwards' });
  await sleep(160);
  overlay.hidden = true;
  overlay.classList.remove('flying', 'glowing');
  rays.remove();
  skill.classList.remove('spent', 'live');
}

/** Reserva sem WebGL: o desenho cresce até o centro, brilha e as peças se afastam e somem. */
async function flyPieces(overlay, from, glow) {
  overlay.insertAdjacentHTML('beforeend', `<div class="enigma-flyer" aria-hidden="true">${enigmaFlyer()}</div>`);
  const flyer = overlay.querySelector('.enigma-flyer');
  Object.assign(flyer.style, { left: `${from.left}px`, top: `${from.top}px`, width: `${from.width}px`, height: `${from.height}px` });
  const size = Math.min(innerWidth, innerHeight) * 0.46;
  const dx = innerWidth / 2 - (from.left + from.width / 2);
  const dy = innerHeight / 2 - (from.top + from.height / 2);
  await flyer.animate([{ transform: 'none' }, { transform: `translate(${dx}px, ${dy}px) scale(${size / from.width})` }], { duration: 560, easing: 'cubic-bezier(.5,0,.15,1)', fill: 'forwards' }).finished;
  glow();
  await new Promise((resolve) => setTimeout(resolve, 480));
  await Promise.all([...flyer.querySelectorAll('.fly-piece')].map((part) => {
    const box = part.getBBox();
    const angle = Math.atan2(box.y + box.height / 2 - 32, box.x + box.width / 2 - 32);
    const reach = 34 + Math.random() * 30;
    return part.animate([
      { transform: 'none', opacity: 1 },
      { transform: `translate(${Math.cos(angle) * reach}px, ${Math.sin(angle) * reach + 10}px) rotate(${(Math.random() - 0.5) * 160}deg) scale(0.7)`, opacity: 0 },
    ], { duration: 620 + Math.random() * 120, easing: 'cubic-bezier(.2,.7,.3,1)', fill: 'forwards' }).finished;
  }));
  flyer.remove();
}

$('#heart').addEventListener('click', async () => {
  const prompt = current?.prompt;
  const index = prompt?.type === M.SELECT_IDLECMD ? prompt.activates.findIndex(isHeart) : -1;
  if (index < 0) { toast(`Coração das Cartas: ${SKILL_NOTE[skillState()].replace(/^Pronto: .*/, 'espere a sua vez')}.`); return; }
  const pending = current;
  current = null; // segura a mesa enquanto o Enigma explode
  heartSpent = true;
  renderDock();
  await shatterEnigma();
  current = pending;
  // A carga só sai depois que o laço grava a ativação na partida (alguns microtasks após respond): se a aba
  // fechar durante a animação, a carga continua e a Skill ainda pode ser usada.
  respond({ type: R.SELECT_IDLECMD, action: 5, index });
  setTimeout(() => useHeart(playerKey));
});

/* ---------- Botões e entrada ---------- */

$('#to-battle').addEventListener('click', () => respond({ type: R.SELECT_IDLECMD, action: 6, index: null }));
$('#to-end').addEventListener('click', (event) => {
  const prompt = current?.prompt;
  // Encerrar com ataque ainda possível pede um 2º toque (sem diálogo): o turno não volta.
  const canAttack = prompt?.type === M.SELECT_BATTLECMD ? prompt.attacks.length > 0
    : prompt?.to_bp && view[ME].monsters.some((card) => card && !isFaceDown(card) && !isDefense(card));
  if (prompt && canAttack && !armConfirm(event.currentTarget, 'Encerrar sem atacar?')) return;
  if (prompt) respond(prompt.type === M.SELECT_IDLECMD ? { type: R.SELECT_IDLECMD, action: 7, index: null } : { type: R.SELECT_BATTLECMD, action: 3, index: null });
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
  onSurrender: !surrendered && duel.state.winner === null ? surrender : null,
}));
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
    vs: `${match.player.label} 🆚 ${match.enemy.label}`, url: new URL('.', location.href).href,
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
// Celular: os botões do turno vão para a lateral da faixa do meio do tapete (no PC ficam ao lado da mão).
const phone = matchMedia('(max-width: 860px)');
const placeActions = () => (phone.matches ? $('#midline') : $('.dock')).append($('.dock-actions'));
phone.addEventListener('change', placeActions);
placeActions();
// Celular: a linha da jogada some sozinha; tocar nela (ou no lugar dela) abre a narração completa. Tocar fora fecha.
$('#log').addEventListener('click', () => { if (document.body.classList.toggle('story-open')) $('#history').scrollTop = 1e6; });
document.addEventListener('pointerdown', (event) => { if (!event.target.closest('.story, #log')) document.body.classList.remove('story-open'); });
const alignMat = () => { const { x, y } = center($('#midline')); scene.centerOn(x, y); };
addEventListener('resize', alignMat);

// Primeiro duelo: dicas curtas apontando o rival, a mão, as fases e o botão de encerrar (card-gestures.js, runTips).
const startTips = () => runTips([
  ['Objetivo: zerar os PV (pontos de vida) do rival. Seus monstros atacam; o de ATK maior vence a luta.', '#foe-plate'],
  ['Toque numa carta da sua mão e escolha Invocar. No Rush, invoque quantos monstros quiser.', '#hand'],
  ['Do segundo turno em diante: "Ir para a Batalha" e toque no seu monstro aceso para atacar.', '#phases'],
  ['No desafio do dia você sempre começa, e quem começa não ataca no primeiro turno. Encerre quando terminar. Dúvida? "Como jogar" tem as palavras do jogo.', '#to-end'],
]);

$('#field').insertAdjacentHTML('afterbegin', '<div id="zones" class="zones-grid"></div>');
$('#player-key').textContent = playerKey;
$('#foe-name').innerHTML = `Rival <span class="who-key">${escape(match.enemy.label)}</span>`;
$('#matchup-chip').innerHTML = `${escape(match.player.label)} <i>contra</i> ${escape(match.enemy.label)} · ${escape(settings.label)}`;
gestures = bindGestures();
render();
renderSkill();
startLiveEnigma();
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
  log(`Você começa contra ${match.enemy.label}: no desafio do dia, você sempre começa${withHeart ? '. O Coração das Cartas está com você' : ''}. Quem começa não ataca no primeiro turno.`);
  // Lembradas por jogador (a chave antiga, de antes, valia para o aparelho todo).
  const tipsKey = `rushdaily-seen-tips:rush:${playerKey}`;
  if (!readJson(tipsKey, false) && !readJson('rushdaily-seen-help', false)) { startTips(); writeJson(tipsKey, true); }
}
window.__duel = { cards, match, duel, view: () => view, current: () => current, responses: () => responses.length, respond, actionsFor, dropTargets }; // testes automáticos
