import { RULES, activateSpell, activateTrap, attack, changePosition, createGame, endTurn, heartOfTheCards, serializeGame, setCard, summon, trapsFor } from '../engine/game-engine.mjs';
import { chooseAction, chooseTrap, recordOutcome } from '../engine/ai.mjs';
import { canAttackNow, canChangePosition, canSet, canSummon, isAttacker, tributesFor, zoneOf } from '../engine/rules.mjs';
import { canActivate } from '../engine/effects.mjs';
import { ARCHETYPE_LABELS, ARCHETYPES, CARD_POOL, cardBackImage, cardImage } from '../data/cards.mjs';
import { DIFFICULTY_IDS, generateDailyMatch, getDifficulty } from '../engine/daily-generator.mjs';
import { queueSync, syncNow } from './sync.js';
import { daysInMonth, escape, foil, getPlayerKey, heartUnlocked, useHeart, readJson, reducedMotion, removeKey, settingsFor, today, toast, writeJson } from './common.js';
import { duelScene, puzzleScene } from './scene.js';
import { resultGrid } from './share.js';

const params = new URLSearchParams(location.search);
const playerKey = getPlayerKey();
syncNow(); // só progresso: a partida em andamento (rushdaily-*game:*) não sincroniza
const difficulty = DIFFICULTY_IDS.includes(params.get('difficulty')) ? params.get('difficulty') : settingsFor(playerKey).difficulty;
const date = today();
// O PvP agora é clássico: quem chegar com ?vs= vai para a arena clássica.
if (params.has('vs')) { location.replace(`arena.html${location.search}`); await new Promise(() => {}); } // PvP é clássico: para o módulo aqui
const daily = generateDailyMatch({ date, playerKey, difficulty, archetypes: ARCHETYPES, pool: CARD_POOL });
const setup = { seed: daily.seed, playerDeck: daily.player.deck, enemyDeck: daily.enemy.deck, enemyLp: daily.enemy.lp, ai: difficulty, you: ARCHETYPE_LABELS[daily.player.archetype], foe: ARCHETYPE_LABELS[daily.enemy.archetype] };
const saveKey = `rushdaily-game:${playerKey}:${date}:${difficulty}`;
const memoryKey = `rushdaily-ai-memory:${playerKey}`;
const startLp = { player: 5000, enemy: setup.enemyLp };
const youLabel = setup.you;
const foeLabel = setup.foe;
const motion = !reducedMotion();
const scene = duelScene(document.querySelector('#mat'), { reduced: !motion });
const $ = (selector) => document.querySelector(selector);
const wait = (ms) => new Promise((resolve) => setTimeout(resolve, motion ? ms : 0));
const RED = 0xe0303f;
const GOLD = 0xf5b21a;
const HOLD_MS = 420;
const DOUBLE_TAP_MS = 320;

const ERRORS = {
  FIELD_FULL: 'Seu campo já tem 3 monstros.',
  BACKROW_FULL: 'Sua zona de Magias e Armadilhas está cheia.',
  NEED_TRIBUTES: 'Esse monstro precisa de tributos: nível 5 e 6 pedem 1, nível 7 ou mais pedem 2.',
  NEED_DISCARD: 'Essa magia pede outra carta na mão para descartar.',
  INVALID_ATTACK: 'Esse monstro já atacou neste turno.',
  NOT_IN_ATTACK: 'Só monstros em Posição de Ataque podem atacar.',
  MUST_TARGET: 'O rival tem monstros: escolha um deles como alvo.',
  CANNOT_ACTIVATE: 'O requisito dessa magia não foi cumprido (custo, condição ou alvo).',
  CANNOT_CHANGE: 'Esse monstro já mudou de posição ou já atacou neste turno.',
  FIRST_TURN: 'Quem começa não ataca no primeiro turno.',
  NOT_YOUR_TURN: 'Espere a sua vez.',
  DUEL_OVER: 'O duelo já terminou.',
  HEART_USED: 'O Coração das Cartas já foi usado neste duelo.',
};

let game = restore() || fresh();
game.aiMemory = readJson(memoryKey, {});
let selection = null; // { kind: 'hand' | 'field', uid }
let tribute = null; // invocação com tributo à espera da escolha: { action, origin, need, picked: [uid] }
let busy = false;
const poses = new Map(); // carta da mão -> { sideways, faceDown }
const shownLp = { player: game.player.lp, enemy: game.enemy.lp };
let hasHeart = heartUnlocked(playerKey); // carga de um mês inteiro vencido

// Fichas opacas no DOM: o uid revela o id da carta, e cartas viradas não podem vazar.
const tokens = new Map();
const tokenOf = (uid) => tokens.get(uid) || (tokens.set(uid, `c${tokens.size + 1}`), tokens.get(uid));
const uidOf = (token) => [...tokens].find(([, value]) => value === token)?.[0];
const el = (uid) => document.querySelector(`[data-token="${tokenOf(uid)}"]`);

function fresh() {
  return createGame({ seed: setup.seed, playerDeck: setup.playerDeck, enemyDeck: setup.enemyDeck, difficulty: setup.ai, enemyLp: setup.enemyLp });
}
function restore() {
  const parsed = readJson(saveKey, null);
  if (!parsed?.player) return null;
  for (const side of [parsed.player, parsed.enemy]) {
    side.attacks = new Set(side.attacks || []);
    side.backrow ||= [];
  }
  return parsed;
}
function save() {
  // PV no fim de cada turno (o último salvo do turno vale): vira a grade do resultado e volta com a partida.
  (game.lpByTurn ||= [])[game.turn] = [game.player.lp, game.enemy.lp];
  try { localStorage.setItem(saveKey, serializeGame(game)); } catch { /* sem armazenamento: a partida segue só nesta aba */ }
}

const myTurn = () => game.active === 'player' && !game.gameOver && !busy;
const canAttackWith = (card) => myTurn() && canAttackNow(game, 'player') && isAttacker(card) && !game.player.attacks.has(card.uid);
const poseOf = (card) => poses.get(card.uid) || { sideways: false, faceDown: card.type === 'trap' };
// Face e posição são independentes: em pé = Ataque, deitada = Defesa, com a face para cima ou virada.
const summonPosition = (pose) => (pose.faceDown ? (pose.sideways ? 'set' : 'set-attack') : pose.sideways ? 'defense' : 'attack');
const findCard = (uid) => ['hand', 'field', 'backrow'].flatMap((zone) => [...game.player[zone], ...game.enemy[zone]]).find((card) => card.uid === uid);
const ownerOf = (uid) => (['hand', 'field', 'backrow'].some((zone) => game.player[zone].some((card) => card.uid === uid)) ? 'player' : 'enemy');

/* ---------- Alvos válidos (arrastar ou tocar) ---------- */

function targetsFor(sel) {
  if (!sel || !myTurn()) return [];
  const player = game.player;
  if (sel.kind === 'hand') {
    const card = player.hand.find((item) => item.uid === sel.uid);
    if (!card) return [];
    const pose = poseOf(card);
    if (card.type === 'monster') {
      if (!canSummon(player, card)) return [];
      const tributes = tributesFor(card);
      const position = summonPosition(pose);
      // Cada zona do campo é um alvo: a carta vai para a zona escolhida. Com tributo, a zona (vazia ou ocupada) abre a escolha dos tributos.
      return [0, 1, 2].flatMap((index) => {
        const occupant = player.field.find((monster) => zoneOf(player, monster) === index);
        if (occupant && !tributes) return [];
        const action = { type: 'summon', uid: card.uid, position, zone: index, tributes: [], askTribute: tributes > 0 };
        return [occupant ? { uid: occupant.uid, action } : { zone: `player-m-${index}`, action }];
      });
    }
    if (!canSet(player)) return [];
    const type = card.type === 'spell' && !pose.faceDown ? (canActivate(game, 'player', card) ? 'activateSpell' : null) : 'setCard';
    if (!type) return [];
    return Array.from({ length: 3 - player.backrow.length }, (_, offset) => ({ zone: `player-s-${player.backrow.length + offset}`, action: { type, uid: card.uid } }));
  }
  const attacker = player.field.find((card) => card.uid === sel.uid);
  if (!attacker || !canAttackWith(attacker)) return [];
  if (game.enemy.field.length) return game.enemy.field.map((target) => ({ uid: target.uid, action: { type: 'attack', uid: attacker.uid, target: target.uid } }));
  return [{ zone: 'enemy-plate', action: { type: 'attack', uid: attacker.uid, target: null } }, ...[0, 1, 2].map((index) => ({ zone: `enemy-m-${index}`, action: { type: 'attack', uid: attacker.uid, target: null } }))];
}

function targetNode(target) {
  return target.uid ? el(target.uid)?.closest('.zone') : document.querySelector(`[data-zone="${target.zone}"]`);
}

function markTargets(targets) {
  document.querySelectorAll('.drop-ok, .drop-hover').forEach((node) => node.classList.remove('drop-ok', 'drop-hover'));
  document.querySelectorAll('[data-target]').forEach((node) => { node.removeAttribute('data-target'); node.removeAttribute('tabindex'); node.removeAttribute('role'); });
  targets.forEach((target, index) => {
    const node = targetNode(target);
    if (!node) return;
    node.classList.add('drop-ok');
    node.dataset.target = index;
    if (!node.matches('button')) { node.tabIndex = 0; node.setAttribute('role', 'button'); }
  });
}

/* ---------- Render ---------- */

function cardSlot(card, owner, kind, index) {
  const own = owner === 'player';
  const visible = card.faceUp !== false;
  const image = visible ? cardImage(card) : cardBackImage();
  const classes = ['zone', 'filled', kind === 'm' ? 'mzone' : 'szone'];
  if (kind === 'm' && card.position === 'defense') classes.push('defense');
  if (!visible) classes.push('facedown');
  if (own && kind === 'm' && canAttackWith(card)) classes.push('ready');
  if (own && game.player.attacks.has(card.uid)) classes.push('spent');
  if (selection?.uid === card.uid) classes.push('selected');
  if (tribute && own && kind === 'm') classes.push(tribute.picked.includes(card.uid) ? 'tribute-picked' : 'tributable');
  const label = visible || own
    ? `${card.name}${kind === 'm' ? `, ${card.position === 'defense' ? 'Defesa' : 'Ataque'}${visible ? '' : ', virado'}, ATK ${card.atk}, DEF ${card.def}` : visible ? '' : ', baixada'}`
    : kind === 'm' ? 'Monstro virado em Defesa' : 'Carta baixada';
  const gesture = own || visible ? 'data-gesture' : '';
  // Deitada, a carta impressa fica ilegível: um selo horizontal repete ATK e DEF (a DEF em destaque).
  const chip = kind === 'm' && card.position === 'defense' && (visible || own) ? `<span class="def-chip" aria-hidden="true">${card.atk}<b>${card.def}</b></span>` : '';
  return `<div class="${classes.join(' ')}" data-zone="${owner}-${kind}-${index}">
    <button class="card face ${visible ? foil(card) : ''}" type="button" data-token="${tokenOf(card.uid)}" ${gesture} aria-label="${escape(label)}"><img src="${image}" alt="" draggable="false"></button>${chip}</div>`;
}

function renderZones(owner, kind) {
  const cards = kind === 'm' ? [0, 1, 2].map((index) => game[owner].field.find((card) => zoneOf(game[owner], card) === index)) : game[owner].backrow;
  $(`#${owner}-${kind === 'm' ? 'field' : 'backrow'}`).innerHTML = [0, 1, 2].map((index) => (cards[index] ? cardSlot(cards[index], owner, kind, index) : `<div class="zone empty ${kind === 'm' ? 'mzone' : 'szone'}" data-zone="${owner}-${kind}-${index}"></div>`)).join('');
}

function renderHand() {
  const hand = game.player.hand;
  $('#hand').style.setProperty('--n', hand.length);
  $('#hand').innerHTML = hand.map((card, index) => {
    const pose = poseOf(card);
    const playable = myTurn() && targetsFor({ kind: 'hand', uid: card.uid }).length > 0;
    const shown = !pose.faceDown || card.type === 'trap'; // armadilha entra sempre virada, mas na sua mão você vê qual é
    const stats = card.type === 'monster' ? `, nível ${card.level}, ATK ${card.atk}, DEF ${card.def}` : '';
    const state = card.type === 'monster' ? { attack: 'em Ataque', defense: 'em Defesa', set: 'virada em Defesa', 'set-attack': 'virada em Ataque' }[summonPosition(pose)] : pose.faceDown ? 'para baixar virada' : 'para ativar';
    return `<button class="card hand-card ${shown ? foil(card) : ''} ${playable ? 'playable' : ''} ${pose.sideways ? 'sideways' : ''} ${pose.faceDown ? 'facedown' : ''} ${selection?.uid === card.uid ? 'selected' : ''}" style="--i:${index}" type="button" data-token="${tokenOf(card.uid)}" data-gesture aria-pressed="${selection?.uid === card.uid}" aria-label="${escape(`${card.name}${stats}, ${state}`)}"><img src="${shown ? cardImage(card) : cardBackImage()}" alt="" draggable="false"></button>`;
  }).join('');
}

function renderPlates() {
  $('#enemy-name').innerHTML = `Rival <span class="who-key">${foeLabel}</span>`;
  $('#player-key').textContent = playerKey;
  $('#enemy-hand').innerHTML = game.enemy.hand.map(() => `<img src="${cardBackImage()}" alt="">`).join('');
  $('#enemy-hand').setAttribute('aria-label', `Mão do rival: ${game.enemy.hand.length} cartas`);
  $('#enemy-plate').dataset.zone = 'enemy-plate';
  for (const owner of ['player', 'enemy']) {
    $(`#${owner}-deck`).textContent = game[owner].deck.length;
    $(`#${owner}-deck`).closest('.pile').classList.toggle('low', game[owner].deck.length <= 6);
    $(`#${owner}-grave`).textContent = game[owner].graveyard.length;
    tweenLp(owner);
  }
  $('#turn-chip').innerHTML = game.gameOver ? 'Duelo encerrado' : `<b>Turno ${game.turn}</b> ${game.active === 'player' ? 'sua vez' : 'vez do rival'}`;
  $('#turn-chip').dataset.owner = game.active;
}

/** Por que a carta da mão não tem jogada agora (mesma mensagem no teclado, no toque e no arraste). */
function whyNot(card) {
  const tributes = tributesFor(card);
  if (card.type === 'monster') {
    return game.player.field.length < tributes ? `${card.name} precisa de ${tributes} tributo${tributes > 1 ? 's' : ''} no seu campo.` : ERRORS.FIELD_FULL;
  }
  return card.type === 'spell' && !poseOf(card).faceDown && !canActivate(game, 'player', card) ? ERRORS.CANNOT_ACTIVATE : ERRORS.BACKROW_FULL;
}

function renderDock() {
  const hint = $('#hint');
  const direct = $('#direct');
  $('#end').disabled = !myTurn();
  direct.hidden = true;
  $('#tribute-ok').hidden = $('#tribute-cancel').hidden = !tribute;
  $('#end').hidden = !!tribute; // os botões do tributo ocupam o lugar dele
  $('#heart').hidden = !!tribute || !(hasHeart && myTurn() && !game.player.heartUsed && game.player.deck.length);
  if (!myTurn()) {
    hint.textContent = game.gameOver ? '' : 'O rival está jogando.';
    return;
  }
  if (tribute) {
    const { need, picked } = tribute;
    $('#tribute-ok').disabled = picked.length !== need;
    hint.textContent = `Toque ${need > 1 ? `em ${need} monstros` : 'no monstro'} do seu campo para sacrificar (${picked.length}/${need}).`;
    return;
  }
  const picked = selection?.kind === 'hand' ? game.player.hand.find((card) => card.uid === selection.uid) : null;
  const attacker = selection?.kind === 'field' ? game.player.field.find((card) => card.uid === selection.uid) : null;
  if (picked) {
    const tributes = tributesFor(picked);
    hint.textContent = !targetsFor(selection).length ? whyNot(picked)
      : picked.type === 'monster' && tributes ? `Escolha a zona acesa; depois você marca ${tributes > 1 ? `os ${tributes} tributos` : 'o tributo'}.` : 'Escolha uma zona acesa.';
  } else if (attacker) {
    if (game.enemy.field.length) hint.textContent = `Escolha o alvo de ${attacker.name}.`;
    else { direct.hidden = false; hint.textContent = `Campo do rival vazio: ${attacker.name} pode atacar direto.`; }
  } else {
    hint.textContent = !canAttackNow(game, 'player') ? 'Arraste cartas para o campo. Toque para ler, toque duas vezes para deitar, segure para virar. Ataques liberam no próximo turno.' : 'Arraste para jogar ou arraste seu monstro até o alvo para atacar.';
  }
}

function alignMat() {
  const { x, y } = center($('.midline'));
  scene.centerOn(x, y);
}

function render() {
  renderZones('enemy', 's');
  renderZones('enemy', 'm');
  renderZones('player', 'm');
  renderZones('player', 's');
  renderHand();
  renderPlates();
  renderDock();
  markTargets(targetsFor(selection));
  alignMat();
}

/* ---------- Efeitos ---------- */

function center(node) {
  const rect = node.getBoundingClientRect();
  return { x: rect.left + rect.width / 2, y: rect.top + rect.height / 2 };
}

function tweenLp(owner) {
  const node = $(`#${owner}-lp`);
  const to = Math.max(0, game[owner].lp);
  const from = shownLp[owner];
  $(`#${owner}-bar`).style.width = `${Math.min(100, (to / startLp[owner]) * 100)}%`;
  shownLp[owner] = to;
  if (from === to || !motion) {
    node.textContent = to.toLocaleString('pt-BR');
    return;
  }
  const plate = node.closest('.duelist');
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

function floatText(text, node, kind = 'damage') {
  const { x, y } = center(node);
  const label = document.createElement('div');
  label.className = `float ${kind}`;
  label.textContent = text;
  label.style.left = `${x}px`;
  label.style.top = `${y}px`;
  document.body.append(label);
  setTimeout(() => label.remove(), 1400);
}

/** Transform de repouso que o CSS dá à carta (ex.: deitada em Defesa). As animações terminam nele, sem estalo. */
function restTransform(node) {
  const value = getComputedStyle(node).transform;
  return value === 'none' ? '' : value;
}

function flyFrom(node, from) {
  if (!motion || !node || !from) return Promise.resolve();
  const rest = restTransform(node);
  // O retângulo final não depende da rotação: mede a zona, não a carta girada.
  const to = (node.closest('.zone') || node).getBoundingClientRect();
  const dx = from.left + from.width / 2 - (to.left + to.width / 2);
  const dy = from.top + from.height / 2 - (to.top + to.height / 2);
  return node.animate([
    { transform: `translate(${dx}px, ${dy}px) scale(${from.width / to.width}) ${rest}` },
    { transform: `translate(0, -16px) scale(1.15) ${rest}`, offset: 0.75 },
    { transform: rest || 'none' },
  ], { duration: 520, easing: 'cubic-bezier(.2,.9,.1,1)' }).finished;
}

/** Reinicia uma animação de classe (tremor) mesmo se ela já rodou no mesmo elemento. */
function replay(node, className) {
  node.classList.remove(className);
  void node.offsetWidth;
  node.classList.add(className);
  node.addEventListener('animationend', () => node.classList.remove(className), { once: true });
}

function shatter(uids) {
  for (const uid of uids) el(uid)?.closest('.zone')?.classList.add('shatter');
}

async function banner(text, owner) {
  scene.setTurn(owner);
  const node = $('#banner');
  node.querySelector('span').textContent = text;
  node.dataset.owner = owner;
  node.classList.remove('run');
  void node.offsetWidth;
  node.classList.add('run');
  await wait(1100);
}

async function cast(card, owner, verb = 'ativou') {
  const node = $('#cast');
  node.innerHTML = `<div class="card shimmer ${foil(card)}"><img src="${cardImage(card)}" alt=""></div><p>${owner === 'player' ? `Você ${verb}` : `O rival ${verb}`} ${escape(card.name)}</p>`;
  node.classList.add('show');
  await wait(1100);
  const { x, y } = center(node);
  scene.pulse(x, y, owner === 'player' ? GOLD : RED, 12, 260);
  scene.shake(0.35);
  node.classList.remove('show');
}

function log(message) {
  const node = $('#log');
  node.innerHTML = `<span>${escape(message)}</span>${[...node.children].slice(0, 2).map((child) => child.outerHTML).join('')}`;
}

function showZoom(card) {
  const zoom = $('#zoom');
  const stats = card.type === 'monster' ? `Nível ${card.level} · ${card.race} · ATK ${card.atk} · DEF ${card.def}` : card.type === 'spell' ? 'Card Mágico' : 'Card de Armadilha';
  zoom.innerHTML = `<div class="card shimmer ${foil(card)}"><img src="${cardImage(card)}" alt=""></div>
    <div class="zoom-copy"><h2>${escape(card.name)}</h2><p class="zoom-stats">${stats}</p>${card.requirement ? `<p><b>Requisito.</b> ${escape(card.requirement)}</p>` : ''}<p>${card.type === 'monster' ? '' : '<b>Efeito.</b> '}${escape(card.desc)}</p></div>`;
  zoom.classList.add('show');
}
function hideZoom() { $('#zoom').classList.remove('show'); }

/* ---------- Ações ---------- */

const who = (owner) => (owner === 'player' ? 'Você' : 'O rival');

async function doSummon(owner, action, origin) {
  const fromRect = origin || (owner === 'player' ? el(action.uid)?.getBoundingClientRect() : $('#enemy-hand img:last-child')?.getBoundingClientRect());
  const event = summon(game, owner, action.uid, { position: action.position, tributes: action.tributes || [], zone: action.zone ?? null });
  if (event.tributes.length) { shatter(event.tributes); await wait(420); }
  render();
  const node = el(action.uid);
  await flyFrom(node, fromRect);
  if (node) { const { x, y } = center(node); scene.pulse(x, y, owner === 'player' ? GOLD : RED, 5, 140); scene.shake(0.12); }
  const tributes = event.tributes.length ? ` com ${event.tributes.length} tributo${event.tributes.length > 1 ? 's' : ''}` : '';
  if (event.type === 'summon') {
    const summoned = game[owner].field.find((card) => card.uid === action.uid);
    await trapWindow(owner === 'player' ? 'enemy' : 'player', { kind: 'summon', summoned }, `${summoned.name} foi invocado. Ativar uma armadilha?`);
  }
  log(event.type === 'set_monster' ? `${who(owner)} baixou um monstro virado em ${action.position === 'set' ? 'Defesa' : 'Ataque'}${tributes}.` : `${who(owner)} invocou ${event.name}${action.position === 'defense' ? ' em Defesa' : ''}${tributes}.`);
}

async function doSet(owner, action, origin) {
  const fromRect = origin || (owner === 'player' ? el(action.uid)?.getBoundingClientRect() : $('#enemy-hand img:last-child')?.getBoundingClientRect());
  setCard(game, owner, action.uid);
  render();
  await flyFrom(el(action.uid), fromRect);
  log(`${who(owner)} baixou uma carta na zona de Magias e Armadilhas.`);
}

async function doSpell(owner, uid) {
  const card = findCard(uid);
  const event = activateSpell(game, owner, uid);
  render();
  await cast(card, owner);
  shatter(event.removed);
  await wait(event.removed.length ? 520 : 0);
  render();
  log(`${who(owner)} ativou ${event.name}${event.removed.length ? `: ${event.removed.length} carta${event.removed.length > 1 ? 's' : ''} destruída${event.removed.length > 1 ? 's' : ''}` : ''}.`);
}

/** Dá ao defensor a chance de responder com armadilha. Retorna true se alguma foi ativada. */
async function trapWindow(defender, context, question) {
  const traps = trapsFor(game, defender, context);
  if (!traps.length) return false;
  const trap = defender === 'player' ? await askTrap(traps, question) : chooseTrap(traps, game, defender);
  if (!trap) return false;
  await doTrap(defender, trap.uid, context);
  return true;
}

async function doTrap(owner, uid, context) {
  const card = findCard(uid);
  const node = el(uid);
  if (node && motion) await node.animate([{ transform: 'none' }, { transform: 'rotateY(90deg) scale(1.2)' }, { transform: 'none' }], { duration: 420 }).finished;
  const event = activateTrap(game, owner, uid, context);
  render();
  await cast(card, owner, 'ativou a armadilha');
  shatter(event.removed);
  await wait(event.removed.length ? 520 : 0);
  render();
  log(`${who(owner)} ativou ${event.name}: ${event.removed.length ? `${event.removed.length} carta${event.removed.length > 1 ? 's' : ''} destruída${event.removed.length > 1 ? 's' : ''}` : 'sem alvos'}.`);
}

async function doPosition(owner, uid, to = null) {
  const before = findCard(uid);
  const wasDown = before.faceUp === false;
  const wasDefense = before.position === 'defense';
  const event = changePosition(game, owner, uid, to);
  render();
  const node = el(uid);
  if (node && motion) {
    // Do estado anterior (em pé ou deitada) até o novo; desvirar passa de lado (rotateY 90°) no meio.
    const old = wasDefense ? 'rotate(90deg) scale(0.686)' : 'none';
    const rest = restTransform(node) || 'none';
    const flips = wasDown && event.faceUp;
    const mid = event.position === 'defense' || wasDefense ? 'rotate(45deg) scale(0.84)' : 'scale(1.06)';
    const frames = flips
      ? [{ transform: old }, { transform: `${mid} rotateY(90deg)`, offset: 0.5 }, { transform: rest }]
      : [{ transform: old }, { transform: rest }];
    await node.animate(frames, { duration: 520, easing: 'cubic-bezier(.2,.9,.1,1)' }).finished;
  }
  const where = event.position === 'defense' ? 'Defesa' : 'Ataque';
  log(event.type === 'flip' ? `${who(owner)} desvirou ${event.name} em ${where}.`
    : event.faceUp ? `${who(owner)} colocou ${event.name} em ${where}.` : `${who(owner)} colocou um monstro virado em ${where}.`);
}

async function askTrap(traps, question) {
  const dialog = $('#trap-prompt');
  $('#trap-kicker').textContent = question;
  let chosen = traps[0];
  const describe = () => { $('#trap-desc').innerHTML = `<b>${escape(chosen.name)}.</b> ${escape(chosen.desc)}`; };
  $('#trap-cards').innerHTML = traps.map((card, index) => `<button class="card ${index ? '' : 'selected'}" type="button" data-pick="${index}" aria-label="${escape(card.name)}"><img src="${cardImage(card)}" alt=""></button>`).join('');
  $('#trap-cards').onclick = (event) => {
    const pick = event.target.closest('[data-pick]');
    if (!pick) return;
    chosen = traps[Number(pick.dataset.pick)];
    $('#trap-cards').querySelectorAll('.card').forEach((node) => node.classList.toggle('selected', node === pick));
    describe();
  };
  describe();
  dialog.showModal();
  const answer = await new Promise((resolve) => {
    $('#trap-yes').onclick = () => resolve(chosen);
    $('#trap-no').onclick = () => resolve(null);
    dialog.oncancel = (event) => { event.preventDefault(); resolve(null); };
  });
  dialog.close();
  return answer;
}

async function doAttack(owner, uid, targetUid) {
  const foe = owner === 'player' ? 'enemy' : 'player';
  const attacker = game[owner].field.find((card) => card.uid === uid);
  // Janela de armadilha do defensor.
  if (await trapWindow(foe, { kind: 'attack', attacker, direct: !targetUid }, `${attacker.name} (ATK ${attacker.atk}) vai atacar ${targetUid ? game[foe].field.find((card) => card.uid === targetUid)?.name || 'seu monstro' : 'você diretamente'}. Ativar uma armadilha?`)) {
    if (!game[owner].field.some((card) => card.uid === uid) || !isAttacker(attacker)) return;
    if (targetUid && !game[foe].field.some((card) => card.uid === targetUid)) targetUid = null; // alvo sumiu: ataque vira direto se o campo esvaziou
    if (!targetUid && game[foe].field.length) return;
  }
  const attackerNode = el(uid);
  const targetNode = (targetUid && el(targetUid)) || $(`#${foe}-plate, .row.${foe === 'player' ? 'player' : 'enemy'} .duelist`);
  const events = attack(game, owner, uid, targetUid);
  const result = events.find((event) => event.type === 'attack' || event.type === 'direct_attack');
  const hurt = result.type === 'direct_attack' || (result.result === 'win' && !result.defense) ? foe : owner;

  if (motion && attackerNode && targetNode) {
    const a = center(attackerNode);
    const t = center(targetNode);
    const rest = restTransform(attackerNode);
    const lunge = attackerNode.animate([
      { transform: rest || 'none' },
      { transform: `translate(${(t.x - a.x) * 0.82}px, ${(t.y - a.y) * 0.82}px) scale(1.14) rotate(${owner === 'player' ? -6 : 6}deg) ${rest}`, offset: 0.5 },
      { transform: rest || 'none' },
    ], { duration: 640, easing: 'cubic-bezier(.55,0,.2,1)' });
    await wait(320);
    if (events.some((event) => event.type === 'flip') && targetNode.querySelector('img')) targetNode.querySelector('img').src = cardImage(findCard(targetUid));
    scene.pulse(t.x, t.y, hurt === 'player' ? RED : GOLD, 7, 220);
    scene.shake(result.damage >= 1000 ? 0.6 : 0.35);
    replay(targetNode, 'struck');
    await lunge.finished;
  }
  if (result.damage > 0) floatText(`−${result.damage.toLocaleString('pt-BR')}`, $(`#${hurt}-lp`), hurt === 'player' ? 'damage' : 'deal');
  shatter(events.filter((event) => event.type === 'destroy').map((event) => event.card));
  await wait(460);
  render();
  const target = targetUid && findCard(targetUid);
  const outcome = result.type === 'direct_attack' ? `atacou direto com ${attacker.name}`
    : result.defense ? (result.result === 'win' ? `quebrou a defesa de ${target?.name || 'um monstro'} com ${attacker.name}` : `bateu na defesa de ${target?.name || 'um monstro'}`)
      : result.result === 'win' ? `destruiu ${target?.name || 'um monstro'} com ${attacker.name}` : result.result === 'lose' ? `perdeu ${attacker.name} no combate` : `empatou o combate com ${attacker.name}`;
  log(`${who(owner)} ${outcome}${result.damage ? ` (${result.damage.toLocaleString('pt-BR')} de dano)` : ''}.`);
}

async function run(owner, action, origin) {
  if (action.type === 'summon') return doSummon(owner, action, origin);
  if (action.type === 'setCard') return doSet(owner, action, origin);
  if (action.type === 'activateSpell') return doSpell(owner, action.uid);
  if (action.type === 'changePosition') return doPosition(owner, action.uid, action.to);
  if (action.type === 'attack') return doAttack(owner, action.uid, action.target);
  return endTurn(game, owner);
}

/* ---------- Escolha dos tributos ---------- */

function beginTribute(action, origin) {
  const need = tributesFor(game.player.hand.find((card) => card.uid === action.uid));
  const field = game.player.field;
  selection = null;
  markTargets([]);
  // Sem escolha possível (todos os monstros vão): segue direto.
  if (field.length <= need) { playerAction({ ...action, askTribute: false, tributes: field.map((card) => card.uid) }, origin); return; }
  const dropped = field.find((card) => zoneOf(game.player, card) === action.zone);
  tribute = { action, origin, need, picked: dropped ? [dropped.uid] : [] };
  render();
}

function toggleTribute(uid) {
  const { picked, need } = tribute;
  if (picked.includes(uid)) picked.splice(picked.indexOf(uid), 1);
  else if (picked.length < need) picked.push(uid);
  else if (need === 1) picked.splice(0, 1, uid);
  else toast(`Só ${need} tributos: toque num escolhido para trocar.`);
  render();
}

/** `quiet`: cancelou tocando noutra carta; não refaz a mão para não perder o gesto que começa. */
function cancelTribute(quiet = false) {
  tribute = null;
  selection = null;
  if (!quiet) { render(); return; }
  document.querySelectorAll('.hand-card.selected').forEach((node) => node.classList.remove('selected'));
  renderZones('player', 'm');
  renderDock();
}

function confirmTribute() {
  if (!tribute || tribute.picked.length !== tribute.need) return;
  const { action, origin, picked } = tribute;
  const player = game.player;
  // A carta fica na zona escolhida se ela estiver livre ou for de um tributo; senão ocupa a zona de um tributo.
  const freed = picked.map((uid) => zoneOf(player, player.field.find((card) => card.uid === uid)));
  const taken = player.field.some((card) => zoneOf(player, card) === action.zone && !picked.includes(card.uid));
  tribute = null;
  playerAction({ ...action, askTribute: false, tributes: picked, zone: taken ? freed[0] : action.zone }, origin);
}

async function playerAction(action, origin) {
  if (!myTurn()) return;
  if (action.askTribute) { beginTribute(action, origin); return; }
  busy = true;
  selection = null;
  markTargets([]);
  try {
    if (typeof action === 'function') await action();
    else { await run('player', action, origin); poses.delete(action.uid); }
  } catch (error) {
    log(ERRORS[error.message] || 'Jogada inválida.');
  }
  busy = false;
  save();
  if (!finishIfNeeded()) render();
}

async function enemyTurn() {
  busy = true;
  selection = null;
  render();
  await banner('Vez do rival', 'enemy');
  let guard = 0;
  while (!game.gameOver && game.active === 'enemy' && guard < 30) {
    guard += 1;
    await wait(560);
    const decision = chooseAction(game, 'enemy', game.difficulty);
    game.events.push({ type: 'ai_decision', difficulty: game.difficulty, selected: decision.action.type, candidates: decision.candidates });
    try {
      await run('enemy', decision.action);
    } catch {
      if (!game.gameOver && game.active === 'enemy') endTurn(game, 'enemy');
    }
    save();
  }
  if (!game.gameOver && game.active === 'enemy') endTurn(game, 'enemy');
  busy = false;
  save();
  if (finishIfNeeded()) return;
  render();
  await banner('Sua vez', 'player');
  log(`Você comprou até ${game.player.hand.length} cartas.`);
}

/* ---------- Gestos: segurar, arrastar, tocar, tocar duas vezes ---------- */

let gesture = null;
let lastTap = { token: null, time: 0 };

function sourceOf(node) {
  const uid = uidOf(node.dataset.token);
  const owner = ownerOf(uid);
  const kind = node.classList.contains('hand-card') ? 'hand' : node.closest('.szone') ? 'backrow' : 'field';
  return { uid, owner, kind, card: findCard(uid) };
}

function startDrag(event) {
  const { node, source } = gesture;
  const targets = source.kind === 'hand' ? targetsFor({ kind: 'hand', uid: source.uid }) : source.kind === 'field' && source.owner === 'player' ? targetsFor({ kind: 'field', uid: source.uid }) : [];
  if (!targets.length) {
    if (source.kind === 'hand') { $('#hint').textContent = whyNot(source.card); toast(whyNot(source.card)); }
    return false;
  }
  const rect = node.getBoundingClientRect();
  const ghost = document.createElement('div');
  const pose = source.kind === 'hand' ? poseOf(source.card) : {};
  const faceDown = pose.faceDown;
  ghost.className = `drag-ghost card ${faceDown ? 'set' : ''} ${pose.sideways ? 'sideways' : ''}`;
  ghost.innerHTML = `<img src="${faceDown ? cardBackImage() : cardImage(source.card)}" alt="">`;
  // Deitada, gira o fantasma inteiro (moldura junto); a largura é a da carta em pé, não a do retângulo girado.
  const width = pose.sideways ? node.offsetWidth : rect.width;
  ghost.style.width = `${width}px`;
  document.body.append(ghost);
  node.classList.add('lifting');
  // O ponto de agarre é medido a partir do centro, que não muda com a rotação.
  gesture.drag = { ghost, targets, width, sideways: !!pose.sideways, offsetX: rect.left + rect.width / 2 - event.clientX, offsetY: rect.top + rect.height / 2 - event.clientY, rect };
  selection = { kind: source.kind === 'hand' ? 'hand' : 'field', uid: source.uid };
  markTargets(targets);
  renderDock(); // a dica passa a explicar o que fazer com a carta arrastada (ex.: soltar sobre o tributo)
  moveDrag(event);
  return true;
}

const ghostPose = (drag, x, y, tilt = 0) => `translate(${x + drag.offsetX - drag.width / 2}px, ${y + drag.offsetY - (drag.width * 614) / 842}px) rotate(${tilt + (drag.sideways ? 90 : 0)}deg)`;

function moveDrag(event) {
  const { ghost } = gesture.drag;
  ghost.style.transform = `${ghostPose(gesture.drag, event.clientX, event.clientY, Math.max(-12, Math.min(12, event.movementX * 0.6)))} scale(1.08)`;
  document.querySelectorAll('.drop-hover').forEach((node) => node.classList.remove('drop-hover'));
  dropTarget(event)?.node.classList.add('drop-hover');
}

function dropTarget(event) {
  const hit = document.elementFromPoint(event.clientX, event.clientY)?.closest('[data-target]');
  return hit ? { node: hit, target: gesture.drag.targets[Number(hit.dataset.target)] } : null;
}

async function endDrag(event) {
  const { ghost, rect } = gesture.drag;
  const drop = dropTarget(event);
  gesture.node.classList.remove('lifting');
  if (drop?.target) {
    const origin = ghost.getBoundingClientRect();
    ghost.remove();
    await playerAction(drop.target.action, origin);
  } else {
    const back = ghostPose({ ...gesture.drag, offsetX: 0, offsetY: 0 }, rect.left + rect.width / 2, rect.top + rect.height / 2);
    if (motion) await ghost.animate([{ transform: ghost.style.transform }, { transform: back }], { duration: 260, easing: 'ease-out' }).finished.catch(() => {});
    ghost.remove();
    selection = null;
    render();
  }
}

function flipDown(source) {
  const pose = { ...poseOf(source.card) };
  if (source.card.type === 'trap') { log('Armadilhas sempre entram viradas para baixo.'); return; }
  pose.faceDown = !pose.faceDown; // mantém o modo: em pé continua Ataque, deitada continua Defesa
  poses.set(source.uid, pose);
  render();
  const node = el(source.uid);
  if (node && motion) {
    const rest = restTransform(node) || 'none';
    node.animate([{ transform: `${rest === 'none' ? '' : rest} rotateY(90deg)` }, { transform: rest }], { duration: 320, easing: 'ease-out' });
  }
}

function turnSideways(source) {
  if (source.card.type !== 'monster') return;
  const pose = { ...poseOf(source.card) };
  pose.sideways = !pose.sideways; // mantém a face: virada continua virada
  poses.set(source.uid, pose);
  render();
}

function doubleTap(node) {
  const source = sourceOf(node);
  if (!myTurn() || source.owner !== 'player') return;
  if (source.kind === 'hand') turnSideways(source);
  else if (source.kind === 'field') {
    const card = source.card;
    if (canChangePosition(game, game.player, card)) playerAction({ type: 'changePosition', uid: source.uid, to: { position: card.position === 'defense' ? 'attack' : 'defense', faceUp: card.faceUp !== false } });
    else log(ERRORS.CANNOT_CHANGE);
  } else if (source.card.type === 'spell') {
    if (canActivate(game, 'player', source.card)) playerAction({ type: 'activateSpell', uid: source.uid });
    else log(ERRORS.CANNOT_ACTIVATE);
  } else log('Armadilhas disparam sozinhas quando o rival declara um ataque.');
}

// Toque simples espera a janela do toque duplo antes de abrir a descrição.
let pendingTap = null;
function tap(node) {
  const zone = node.closest('[data-target]');
  if (zone && selection) {
    const target = targetsFor(selection)[Number(zone.dataset.target)];
    if (target) { playerAction(target.action); return; }
  }
  clearTimeout(pendingTap?.timer);
  const source = sourceOf(node);
  pendingTap = { token: node.dataset.token, timer: setTimeout(() => { pendingTap = null; showZoom(source.card); }, DOUBLE_TAP_MS) };
}

// Teclado: Enter escolhe a carta e depois a zona acesa (sem arrastar).
function keySelect(node) {
  const source = sourceOf(node);
  if (!myTurn() || source.owner !== 'player') return;
  if (source.kind === 'hand') selection = selection?.uid === source.uid ? null : { kind: 'hand', uid: source.uid };
  else if (source.kind === 'field' && canAttackWith(source.card)) selection = selection?.uid === source.uid ? null : { kind: 'field', uid: source.uid };
  render();
}

document.addEventListener('pointerdown', (event) => {
  if (!$('#help').hidden && !event.target.closest('#help, #help-toggle')) $('#help-toggle').click();
  if (event.button > 0 || gesture) return;
  if ($('#zoom').classList.contains('show')) { hideZoom(); return; }
  if (tribute) {
    // Marcando tributos: tocar num monstro seu liga/desliga; fora do painel de botões, cancela.
    const slot = event.target.closest('#player-field .zone.filled');
    if (slot) { event.preventDefault(); toggleTribute(uidOf(slot.querySelector('[data-token]').dataset.token)); return; }
    if (!event.target.closest('.dock')) cancelTribute(true);
  }
  const node = event.target.closest('[data-gesture]');
  const zone = event.target.closest('[data-target]');
  if (!node) {
    if (zone && selection) {
      const target = targetsFor(selection)[Number(zone.dataset.target)];
      if (target) playerAction(target.action);
    }
    return;
  }
  event.preventDefault();
  node.setPointerCapture?.(event.pointerId);
  const source = sourceOf(node);
  // Toque duplo é detectado no segundo toque (como em apps nativos): cancela a descrição pendente.
  const double = pendingTap?.token === node.dataset.token;
  if (double) { clearTimeout(pendingTap.timer); pendingTap = null; }
  gesture = { node, source, id: event.pointerId, x: event.clientX, y: event.clientY, double, drag: null };
  // Segurar: na mão vira a face; no campo desvira a sua carta virada; nas outras, mostra a descrição.
  gesture.timer = setTimeout(() => {
    if (!gesture || gesture.drag || gesture.double) return;
    gesture.held = true;
    if (source.kind === 'hand' && source.owner === 'player') flipDown(source);
    else if (source.kind === 'field' && source.owner === 'player' && source.card.faceUp === false && myTurn()) {
      if (canChangePosition(game, game.player, source.card)) playerAction({ type: 'changePosition', uid: source.uid, to: { faceUp: true } });
      else log(ERRORS.CANNOT_CHANGE);
    } else showZoom(source.card);
  }, HOLD_MS);
});

document.addEventListener('pointermove', (event) => {
  if (!gesture || event.pointerId !== gesture.id) return;
  if (gesture.drag) { moveDrag(event); return; }
  if (gesture.held) return;
  if (Math.hypot(event.clientX - gesture.x, event.clientY - gesture.y) > 8) {
    clearTimeout(gesture.timer);
    if (!myTurn() || !startDrag(event)) gesture.moved = true;
  }
});

async function finishGesture(event, cancelled = false) {
  if (!gesture || event.pointerId !== gesture.id) return;
  const current = gesture;
  clearTimeout(current.timer);
  if (current.held) { /* já agiu ao segurar */ }
  else if (current.drag) await endDrag(event);
  else if (!cancelled && !current.moved) {
    if (current.double) doubleTap(current.node);
    else tap(current.node);
  }
  if (gesture === current) gesture = null;
}
document.addEventListener('pointerup', (event) => { finishGesture(event); });
document.addEventListener('pointercancel', (event) => { finishGesture(event, true); });
// Segurar no celular/PC não deve abrir o menu do navegador sobre as cartas.
document.addEventListener('contextmenu', (event) => { if (event.target.closest('[data-gesture]')) event.preventDefault(); });

// Teclado: Enter = escolher/jogar, I = descrição, D = de lado (toque duplo), V = virar (segurar).
document.addEventListener('click', (event) => {
  if (event.detail !== 0) return;
  const node = event.target.closest('[data-gesture]');
  const zone = event.target.closest('[data-target]');
  const slot = tribute && event.target.closest('#player-field .zone.filled');
  if (slot) { toggleTribute(uidOf(slot.querySelector('[data-token]').dataset.token)); return; }
  if (zone && selection) { const target = targetsFor(selection)[Number(zone.dataset.target)]; if (target) { playerAction(target.action); return; } }
  if (node) keySelect(node);
});
document.addEventListener('keydown', (event) => {
  if (event.key === 'Escape') { hideZoom(); if (selection) { selection = null; render(); } }
  if ((event.key === 'Enter' || event.key === ' ') && event.target.matches('[data-target]:not(button)')) { event.preventDefault(); event.target.click(); }
  const node = event.target.closest?.('[data-gesture]');
  if (!node) return;
  const key = event.key.toLowerCase();
  if (key === 'i') showZoom(sourceOf(node).card);
  if (key === 'd') doubleTap(node);
  if (key === 'v' && sourceOf(node).kind === 'hand') flipDown(sourceOf(node));
});

/* ---------- Fim de duelo ---------- */

function finishIfNeeded() {
  if (!game.gameOver) return false;
  render();
  if (!game.recorded) {
    game.recorded = true;
    recordOutcome(game);
    writeJson(memoryKey, game.aiMemory);
    const result = game.winner === 'player' ? 'win' : game.winner === 'draw' ? 'draw' : 'loss';
    const history = readJson('rushdaily-history', {});
    history[playerKey] = { ...(history[playerKey] || {}), [date]: history[playerKey]?.[date] === 'win' ? 'win' : result };
    writeJson('rushdaily-history', history);
    // Booster sorteado pela chave do jogador: cada um tira cartas diferentes do mesmo desafio.
    if (game.winner === 'player' && !readJson(`rushdaily-classic-booster:${playerKey}:${date}`, null)) {
      writeJson(`rushdaily-reward:${playerKey}:${date}`, { seed: `booster:${date}:${playerKey}`, difficulty, pending: true });
    }
    save();
    queueSync(0); // resultado sobe já, sem esperar a calma do agendamento
  }
  const won = game.winner === 'player';
  const deckOut = game.events.some((event) => event.type === 'deck_out');
  const timeUp = game.events.some((event) => event.type === 'turn_limit');
  $('#result').dataset.result = game.winner;
  $('#result-kicker').textContent = `${youLabel} contra ${foeLabel}, ${getDifficulty(difficulty).label}, turno ${game.turn}`;
  $('#result-title').textContent = won ? 'Vitória' : game.winner === 'draw' ? 'Empate' : 'Derrota';
  $('#result-copy').textContent = won
    ? `${timeUp ? `No limite de ${RULES.TURN_LIMIT} turnos, você tinha mais PV.` : deckOut ? 'O deck do rival acabou.' : 'Os pontos de vida do rival chegaram a zero.'} Seu booster clássico está liberado e a peça do dia ${Number(date.slice(8))} entrou no Enigma.`
    : `${timeUp ? `No limite de ${RULES.TURN_LIMIT} turnos, o rival tinha mais PV.` : deckOut ? 'Seu deck acabou antes do rival.' : 'Seus pontos de vida chegaram a zero.'} A revanche usa a mesma seed: as cartas chegam na mesma ordem.`;
  $('#result-main').textContent = won ? 'Abrir booster clássico' : 'Voltar ao desafio';
  $('#result-main').href = won ? `screens.html?screen=reward&player=${playerKey}` : `index.html?player=${playerKey}`;
  if (won) scene.burst(GOLD);
  setTimeout(() => $('#result').open || $('#result').showModal(), motion ? 700 : 0);
  return true;
}

/* ---------- Entrada ---------- */

/** O poder consome o Enigma: ele explode em partes e o jogador recomeça a montar. */
function shatterEnigma() {
  const overlay = $('#enigma-burst');
  overlay.hidden = false;
  return new Promise((resolve) => {
    const view = puzzleScene($('#enigma-canvas'), { explode: true, total: daysInMonth(), reduced: !motion, onDone: () => { view.dispose?.(); overlay.hidden = true; resolve(); } });
    if (!motion) setTimeout(() => { view.dispose?.(); overlay.hidden = true; resolve(); }, 600);
  });
}

$('#heart').addEventListener('click', () => playerAction(async () => {
  const from = $('#player-deck').closest('.pile').getBoundingClientRect();
  const event = heartOfTheCards(game, 'player');
  useHeart(playerKey);
  hasHeart = false;
  await shatterEnigma();
  scene.burst(GOLD);
  render();
  await flyFrom(el(event.card), from);
  await cast(findCard(event.card), 'player', 'puxou com o Coração das Cartas');
  log(`O Coração das Cartas trouxe ${event.name}.`);
}));

$('#tribute-ok').addEventListener('click', confirmTribute);
$('#tribute-cancel').addEventListener('click', () => cancelTribute());
$('#direct').addEventListener('click', () => {
  if (selection?.kind === 'field') playerAction({ type: 'attack', uid: selection.uid, target: null });
});
$('#end').addEventListener('click', async () => {
  if (!myTurn()) return;
  selection = null;
  tribute = null;
  endTurn(game, 'player');
  save();
  if (finishIfNeeded()) return;
  await enemyTurn();
});
$('#help-toggle').addEventListener('click', () => {
  const open = $('#help').hidden;
  $('#help').hidden = !open;
  $('#help-toggle').setAttribute('aria-expanded', String(open));
});
$('#rematch').addEventListener('click', () => { removeKey(saveKey); location.reload(); });
// Grade para colar no grupo (sem cartas): o desafio do dia é igual para todos, então dá para comparar.
$('#share').addEventListener('click', async () => {
  const text = resultGrid({
    date, difficulty: getDifficulty(difficulty).label, rating: getDifficulty(difficulty).rating,
    outcome: game.winner === 'player' ? 'win' : game.winner === 'draw' ? 'draw' : 'loss',
    turns: Math.min(game.turn, RULES.TURN_LIMIT), start: [startLp.player, startLp.enemy], lpByTurn: game.lpByTurn,
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
addEventListener('resize', alignMat);

// Primeiro duelo: três dicas curtas apontando a mão e o campo, no lugar do painel de regras.
function startTips() {
  const steps = [
    ['Arraste uma carta da sua mão até uma zona que acender.', '#hand'],
    ['Toque duas vezes numa carta para deitar (Defesa) ou levantar (Ataque).', '#hand'],
    ['Quem começa não ataca no primeiro turno. Encerre quando terminar.', '#end'],
  ];
  let at = 0;
  const show = () => {
    document.querySelectorAll('.tip-target').forEach((node) => node.classList.remove('tip-target'));
    if (at >= steps.length) { $('#tip').hidden = true; return; }
    $('#tip').hidden = false;
    $('#tip-text').textContent = `${at + 1}/${steps.length}  ${steps[at][0]}`;
    $('#tip-next').textContent = at === steps.length - 1 ? 'Entendi' : 'Próxima';
    $(steps[at][1]).classList.add('tip-target');
  };
  $('#tip-next').addEventListener('click', () => { at += 1; show(); });
  $('#tip-skip').addEventListener('click', () => { at = steps.length; show(); });
  show();
}

render();
// Entrada vinda da home: abre o clarão só depois do primeiro quadro desenhado (com a mesa pronta).
if (document.body.classList.contains('entering')) {
  requestAnimationFrame(() => requestAnimationFrame(() => {
    document.body.classList.add('reveal');
    setTimeout(() => document.body.classList.remove('entering', 'reveal'), 1300);
  }));
}
if (!finishIfNeeded()) {
  if (game.active === 'enemy') enemyTurn();
  else if (game.turn === 1 && !game.player.field.length && !game.player.backrow.length) {
    banner('Sua vez', 'player');
    log(`Você começa contra ${foeLabel}. Quem começa não ataca no primeiro turno.`);
    if (!readJson('rushdaily-seen-help', false)) { startTips(); writeJson('rushdaily-seen-help', true); }
  }
}
