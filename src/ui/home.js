// Tela Hoje: o desafio do dia no Rush do EDOPro (o mesmo para todos), a dificuldade e o deck que você recebeu.
import { ATTRIBUTE_OF, generateDailyMatch, listDifficulties } from '../engine/daily-generator.mjs';
import { TYPE } from '../engine/ocg.mjs';
import { bindKeyChip, escape, foil, glove, heartUnlocked, getPlayerKey, inspect, longDate, nav, readJson, reducedMotion, settingsFor, tilt, today, uniqueCards, writeJson } from './common.js';
import { RUSH_BACK, paintRushCards, rushImg, warmRushCards } from './rush-render.js';
import { cardStats, isMonster } from './rush-info.js';
import { homeScene } from './scene.js';
import { syncNow } from './sync.js';

const playerKey = getPlayerKey();
const date = today();
const settingsKey = `rushdaily-settings:${playerKey}`;
let difficulty = settingsFor(playerKey).difficulty;
const $ = (selector) => document.querySelector(selector);
const lp = (value) => value.toLocaleString('pt-BR');

document.querySelector('#nav').outerHTML = nav('today', playerKey);
bindKeyChip(playerKey);
$('#date').textContent = longDate(date);

const pool = await (await fetch('src/data/rush/cards.json')).json();
const cards = new Map(pool.map((card) => [card.id, card]));
const match = () => generateDailyMatch({ date, difficulty, pool });
const AI_LABEL = { aprendiz: 'Joga sem plano', duelista: 'Usa as Invocações ilimitadas', elite: 'Responde em toda chance', caos: 'Troca monstros sem medo' };

// Ordem do deck: monstros do mais forte ao mais fraco, depois Magias e Armadilhas.
const rank = (card) => (isMonster(card) ? 0 : card.type & TYPE.SPELL ? 1 : 2);
const order = (a, b) => rank(a) - rank(b) || (b.legend ? 1 : 0) - (a.legend ? 1 : 0) || b.atk - a.atk || a.name.localeCompare(b.name);
/** As três cartas do leque: os monstros mais fortes do Tipo do dia (Lenda primeiro). */
const heroCards = (side) => [...new Set(side.deck.main)].map((id) => cards.get(id)).filter(isMonster)
  .sort((a, b) => (b.race === side.theme.race) - (a.race === side.theme.race) || order(a, b)).slice(0, 3);

function renderDifficulty() {
  const field = $('#difficulty');
  field.innerHTML = `<legend>Dificuldade</legend>${listDifficulties().map((item) => `
    <label class="tier">
      <input type="radio" name="difficulty" value="${item.id}" ${item.id === difficulty ? 'checked' : ''}>
      <span class="tier-face">${glove(item.rating)}<span class="tier-name">${item.label}</span></span>
    </label>`).join('')}`;
}

function railItem({ id, count }) {
  const card = cards.get(id);
  return `<li>
      <button class="deck-card" type="button" data-id="${id}" aria-label="Ver ${escape(card.name)}${count > 1 ? `, ${count} cópias` : ''}">
        <span class="card ${foil(card)}"><img data-rush-card="${id}" alt="" decoding="async" width="418" height="609"></span>
        ${count > 1 ? `<span class="copies">×${count}</span>` : ''}
      </button>
    </li>`;
}

function render() {
  const data = match();
  const result = readJson('rushdaily-history', {})[playerKey]?.[date];
  $('#theme').textContent = `${data.player.label} × ${data.enemy.label}`;
  $('#you').textContent = data.player.label;
  $('#foe').textContent = data.enemy.label;
  // O nome mais longo manda no tamanho da fonte (CSS: --len), para o confronto caber na coluna.
  $('#matchup').style.setProperty('--len', Math.max(data.player.label.length, data.enemy.label.length));
  $('#matchup').setAttribute('aria-label', `${data.player.label} contra ${data.enemy.label}`);
  $('#brief').textContent = `Hoje você joga com um deck pronto de ${data.player.label} ${ATTRIBUTE_OF[data.player.theme.attribute] || ''} e enfrenta ${data.enemy.label} ${ATTRIBUTE_OF[data.enemy.theme.attribute] || ''}, o mesmo desafio para todo mundo. ${data.difficulty.modifier}${heartUnlocked(playerKey) ? ' Você tem um Coração das Cartas guardado: ele entra no duelo.' : ''}`.replace(/\s+/g, ' ').replace(' .', '.');
  const days = [date, `${date}~2`, ...listDifficulties().map((item) => `${date}~${item.id}`)]; // = renderReward (screens.js)
  const boosterPending = days.some((day) => readJson(`rushdaily-reward:${playerKey}:${day}`, null));
  const thisTaken = Boolean(readJson(`rushdaily-classic-booster:${playerKey}:${date}~${difficulty}`, null)); // o desta dificuldade já saiu
  const boosterLink = `<a href="screens.html?screen=reward&player=${playerKey}">Abrir booster</a>`;
  const ongoing = readJson(`rushdaily-game:${playerKey}:${date}:${difficulty}`, null);
  $('#status').innerHTML = result === 'win' ? (boosterPending ? `Vitória registrada. Seu booster está esperando: ${boosterLink}.` : thisTaken ? 'Vitória registrada e o booster desta dificuldade aberto. Vença em outra dificuldade para ganhar o dela (sem peça do Enigma).' : 'Vitória registrada. Vença nesta dificuldade para ganhar o booster dela (sem peça do Enigma).')
    : result === 'loss' ? 'Você perdeu hoje. A revanche continua aberta.'
      : result === 'draw' ? 'Empate. A revanche continua aberta.'
        : ongoing?.v === 2 && ongoing.responses?.length && !ongoing.done ? 'Sua partida de hoje está salva: entre para continuar.'
          : Object.keys(readJson('rushdaily-history', {})[playerKey] || {}).length ? 'Vença o duelo de hoje para ganhar um booster.'
            : 'Primeira vez? Você vence zerando os PV (pontos de vida) do rival. O duelo começa com dicas, e "Como jogar" explica as palavras. Vencer dá um booster.';
  $('#classic').href = `arena.html?player=${playerKey}`;
  $('#enter').href = `duel.html?player=${playerKey}&difficulty=${difficulty}`;
  $('#enter').textContent = ongoing?.v === 2 && ongoing.responses?.length && !ongoing.done ? 'Continuar o duelo' : 'Entrar na arena';

  const main = uniqueCards(data.player.deck.main).sort((a, b) => order(cards.get(a.id), cards.get(b.id)));
  const ids = data.player.deck.main.map((id) => cards.get(id));
  const monsters = ids.filter(isMonster).length;
  const spells = ids.filter((card) => card.type & TYPE.SPELL).length;
  const fusions = data.player.deck.extra.length;
  $('#deck-meta').textContent = `${ids.length} cartas: ${monsters} monstros, ${spells} Magias, ${ids.length - monsters - spells} Armadilhas${fusions ? ` · ${fusions} ${fusions > 1 ? 'Fusões' : 'Fusão'} no Adicional` : ''}`;
  $('#deck-rail').innerHTML = main.map(railItem).join('')
    + (fusions ? `<li class="rail-break" aria-hidden="true"><span>Adicional</span></li>${uniqueCards(data.player.deck.extra).map(railItem).join('')}` : '');
  paintRushCards($('#deck-rail'));
  document.querySelectorAll('.deck-card .card').forEach((node) => tilt(node, 18));

  $('#rival-stats').innerHTML = `
    <div><dt>Tipo</dt><dd>${escape(data.enemy.label)} ${escape(ATTRIBUTE_OF[data.enemy.theme.attribute] || '')}</dd></div>
    <div><dt>Pontos de vida</dt><dd>${lp(data.enemy.lp)} <small>contra seus ${lp(data.player.lp)}</small></dd></div>
    <div><dt>Estilo</dt><dd>${AI_LABEL[data.enemy.ai] || ''}</dd></div>`;
  return data;
}

renderDifficulty();
let data = render();
warmRushCards(data.player.deck.main.slice(0, 12));
// Leque 3D: começa com o verso e troca pelas frentes quando as imagens ficam prontas.
const frontsOf = (side) => Promise.all(heroCards(side).map((card) => rushImg(card).catch(() => RUSH_BACK)));
const scene = homeScene($('#stage'), { fronts: [RUSH_BACK, RUSH_BACK, RUSH_BACK], back: RUSH_BACK, reduced: reducedMotion(), anchor: $('.stage') });
const showFronts = () => { const side = data.player; frontsOf(side).then((urls) => { if (side.deck.main.join() === data.player.deck.main.join()) scene.setFronts(urls); }); };
showFronts();
// Sincroniza em segundo plano; se veio progresso de outro aparelho (vitória, booster), redesenha o dia.
syncNow().then(({ changed }) => {
  if (!changed) return;
  difficulty = settingsFor(playerKey).difficulty;
  renderDifficulty();
  data = render();
});

$('#difficulty').addEventListener('change', (event) => {
  difficulty = event.target.value;
  writeJson(settingsKey, { ...settingsFor(playerKey), difficulty, updatedAt: Date.now() });
  data = render(); // seu deck não muda com a dificuldade; o leque fica
});

$('#deck-rail').addEventListener('click', (event) => {
  const button = event.target.closest('.deck-card');
  if (!button) return;
  const card = cards.get(Number(button.dataset.id));
  inspect({ name: card.name, stats: cardStats(card), desc: card.desc, className: foil(card), html: `<img data-rush-card="${card.id}" alt="${escape(card.name)}">` }, paintRushCards);
});

$('#enter').addEventListener('click', async (event) => {
  if (event.metaKey || event.ctrlKey) return;
  event.preventDefault();
  const { href } = event.currentTarget; // currentTarget some depois do await
  document.body.classList.add('launching');
  try { sessionStorage.setItem('rushdaily-entering', '1'); } catch { /* sem sessão: arena abre sem a entrada */ }
  await scene.launch();
  location.href = href;
});
