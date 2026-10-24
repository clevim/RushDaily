import { ARCHETYPE_LABELS, ARCHETYPES, CARD_POOL, cardBackImage, cardImage, cardThumb } from '../data/cards.mjs';
import { generateDailyMatch, listDifficulties } from '../engine/daily-generator.mjs';
import { bindKeyChip, ensureStarter, escape, foil, glove, heartUnlocked, getPlayerKey, inspect, longDate, nav, readJson, reducedMotion, settingsFor, tilt, today, uniqueCards, writeJson } from './common.js';
import { homeScene } from './scene.js';
import { syncNow } from './sync.js';

const playerKey = getPlayerKey();
ensureStarter(playerKey);
const date = today();
const settingsKey = `rushdaily-settings:${playerKey}`;
let difficulty = settingsFor(playerKey).difficulty;
const $ = (selector) => document.querySelector(selector);
const lp = (value) => value.toLocaleString('pt-BR');

document.querySelector('#nav').outerHTML = nav('today', playerKey);
bindKeyChip(playerKey);
$('#date').textContent = longDate(date);

function match() {
  return generateDailyMatch({ date, playerKey, difficulty, archetypes: ARCHETYPES, pool: CARD_POOL });
}

function heroCards(deck) {
  return uniqueCards(deck).map(({ card }) => card).sort((a, b) => b.power - a.power).slice(0, 3);
}

function renderDifficulty() {
  const field = $('#difficulty');
  field.innerHTML = `<legend>Dificuldade</legend>${listDifficulties().map((item) => `
    <label class="tier">
      <input type="radio" name="difficulty" value="${item.id}" ${item.id === difficulty ? 'checked' : ''}>
      <span class="tier-face">${glove(item.rating)}<span class="tier-name">${item.label}</span></span>
    </label>`).join('')}`;
}

function render() {
  const data = match();
  const result = readJson('rushdaily-history', {})[playerKey]?.[date];
  $('#you').textContent = ARCHETYPE_LABELS[data.player.archetype];
  $('#foe').textContent = ARCHETYPE_LABELS[data.enemy.archetype];
  // O nome mais longo manda no tamanho da fonte (CSS: --len), para o confronto caber na coluna.
  $('#matchup').style.setProperty('--len', Math.max($('#you').textContent.length, $('#foe').textContent.length));
  $('#brief').textContent = `${data.difficulty.modifier}${heartUnlocked(playerKey) ? ' Você tem um Coração das Cartas guardado.' : ''}`;
  const boosterOpen = Boolean(readJson(`rushdaily-classic-booster:${playerKey}:${date}`, null));
  const boosterLink = `<a href="screens.html?screen=reward&player=${playerKey}">Abrir booster</a>`;
  $('#status').innerHTML = result === 'win' ? (boosterOpen ? 'Vitória registrada e booster aberto. Amanhã tem desafio novo.' : `Vitória registrada. Seu booster está esperando: ${boosterLink}.`)
    : result === 'loss' ? 'Você perdeu hoje. A revanche continua aberta.'
      : result === 'draw' ? 'Empate. A revanche continua aberta.'
        : 'Vença o duelo de hoje para ganhar um booster.';
  $('#enter').href = `duel.html?player=${playerKey}&difficulty=${difficulty}`;

  const unique = uniqueCards(data.player.deck).sort((a, b) => b.card.power - a.card.power);
  $('#deck-meta').textContent = `${data.player.stats.monsters} monstros, ${data.player.stats.spells} magias, ${data.player.stats.traps} armadilhas`;
  $('#deck-rail').innerHTML = unique.map(({ card, count }) => `
    <li>
      <button class="deck-card" type="button" data-id="${card.id}" aria-label="Ver ${escape(card.name)}">
        <span class="card ${foil(card)}"><img src="${cardThumb(card)}" alt="" loading="lazy" decoding="async" width="421" height="614"></span>
        ${count > 1 ? `<span class="copies">×${count}</span>` : ''}
      </button>
    </li>`).join('');
  document.querySelectorAll('.deck-card .card').forEach((node) => tilt(node, 18));

  $('#rival-stats').innerHTML = `
    <div><dt>Arquétipo</dt><dd>${ARCHETYPE_LABELS[data.enemy.archetype]}</dd></div>
    <div><dt>Pontos de vida</dt><dd>${lp(data.enemy.lp)}</dd></div>
    <div><dt>Consistência</dt><dd>${Math.round(data.enemy.stats.consistency * 100)}%</dd></div>`;
  return data;
}

renderDifficulty();
const data = render();
const scene = homeScene($('#stage'), { fronts: heroCards(data.player.deck).map((card) => cardThumb(card)), back: cardBackImage(), reduced: reducedMotion(), anchor: $('.stage') });
// Sincroniza em segundo plano; se veio progresso de outro aparelho (vitória, booster), redesenha o dia.
syncNow().then(({ changed }) => {
  if (!changed) return;
  difficulty = settingsFor(playerKey).difficulty;
  scene.setFronts(heroCards(render().player.deck).map((card) => cardThumb(card)));
});

$('#difficulty').addEventListener('change', (event) => {
  difficulty = event.target.value;
  writeJson(settingsKey, { ...settingsFor(playerKey), difficulty, updatedAt: Date.now() });
  const next = render();
  scene.setFronts(heroCards(next.player.deck).map((card) => cardThumb(card)));
});

$('#deck-rail').addEventListener('click', (event) => {
  const button = event.target.closest('.deck-card');
  if (!button) return;
  const card = CARD_POOL.find((item) => String(item.id) === button.dataset.id);
  inspect(card, cardImage(card));
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
