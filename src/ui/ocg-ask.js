// Perguntas do motor do EDOPro em diálogos: o que as duas arenas (clássica e Rush) respondem igual.
// A página cuida do que depende do tapete (Fase Principal, Batalha, Corrente); aqui ficam as escolhas de cartas,
// posições, zonas, sim/não, opções, números e declarações.
import { OcgLocation as L, OcgMessageType as M, OcgOpCode, OcgPosition as P, OcgResponseType as R, cardMatchesOpcode } from '../vendor/ocgcore/index.js';
import { toCoreCard } from '../engine/ocg.mjs';
import { escape } from './common.js';
import { placeName } from '../data/classic/strings-pt.mjs';

export const fold = (text) => String(text).normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase();

/**
 * Diálogo de escolhas ligado a um <dialog> com título, lista e ações (ids: ask, ask-title, ask-items, ask-actions).
 * ask({ title, items: [{ html, label, keywords }], min, max, cancel, valid, instant, search, note }) -> índices ou null.
 * cancel: true (botão "Cancelar") ou o rótulo do botão que responde null.
 * paint(root) preenche as imagens das cartas depois de desenhar a lista.
 */
export function createAsk({ dialog, title: titleNode, items: itemsNode, actions: actionsNode, note: noteNode = null, paint = () => {} }) {
  // Contador (fixo no topo) e leitura da carta: criados uma vez dentro do diálogo, servem às duas arenas.
  const countNode = dialog.querySelector('.ask-count') || titleNode.insertAdjacentElement('afterend', Object.assign(document.createElement('p'), { className: 'ask-count' }));
  countNode.setAttribute('aria-live', 'polite');
  const detail = dialog.querySelector('.ask-detail') || dialog.appendChild(Object.assign(document.createElement('div'), { className: 'ask-detail', hidden: true }));
  return function ask({ title, items, min = 1, max = 1, cancel = false, valid = (chosen) => chosen.length >= min && chosen.length <= max, instant = max === 1 && min === 1, search = false, note = '', count = null, chosen: initial = [] }) {
    return new Promise((resolve) => {
      const chosen = [...initial];
      titleNode.textContent = title;
      if (noteNode) { noteNode.innerHTML = note; noteNode.hidden = !note; }
      // item.info { name, stats, text }: botão "i", segurar ou clique direito/tecla I abrem a leitura sem marcar.
      // item.locked: já faz parte da escolha (ex.: carta obrigatória da soma), não desmarca.
      const cell = (item, index) => {
        const button = `<button type="button" class="ask-item ${item.html ? 'with-card' : ''}" data-i="${index}" data-find="${escape(fold(`${item.label || ''} ${item.keywords || ''}`))}" aria-pressed="false"${item.locked ? ' disabled' : ''}>${item.html || ''}<span>${escape(item.label || '')}</span></button>`;
        return item.info ? `<div class="ask-cell">${button}<button type="button" class="ask-info" data-info="${index}" aria-label="Ler ${escape(item.info.name || 'a carta')}"><b aria-hidden="true">i</b></button></div>` : button;
      };
      // search: campo que filtra pelo rótulo (e por item.keywords), ignorando acentos.
      itemsNode.innerHTML = `${search ? '<input type="search" class="ask-search" placeholder="Buscar pelo nome" aria-label="Buscar pelo nome">' : ''}${items.map(cell).join('')}`;
      itemsNode.dataset.many = String(!instant);
      if (search) {
        const input = dialog.querySelector('.ask-search');
        input.oninput = () => {
          const query = fold(input.value.trim());
          for (const node of dialog.querySelectorAll('.ask-item')) (node.closest('.ask-cell') || node).hidden = Boolean(query) && !node.dataset.find.includes(query);
        };
        setTimeout(() => input.focus(), 50);
      }
      const confirm = instant ? '' : '<button class="btn" type="button" data-do="ok" disabled>Confirmar</button>';
      actionsNode.innerHTML = `${confirm}${cancel ? `<button class="btn ghost" type="button" data-do="cancel">${typeof cancel === 'string' ? escape(cancel) : 'Cancelar'}</button>` : ''}`;
      // Contador: "1 de 2 selecionadas — falta 1" (ou o texto de count(chosen), ex.: soma de Níveis).
      const plural = (n, word) => `${n} ${word}${n === 1 ? '' : 's'}`;
      const defaultCount = (list) => {
        const n = list.length;
        if (n < min) return `${n} de ${min} ${n === 1 ? 'selecionada' : 'selecionadas'} — falta${min - n > 1 ? 'm' : ''} ${min - n}`;
        if (n < max && max !== min) return `${plural(n, 'selecionada')} — pode marcar até ${max}`;
        return `${n} de ${max} ${n === 1 ? 'selecionada' : 'selecionadas'}`;
      };
      const refresh = (warn = '') => {
        for (const node of itemsNode.querySelectorAll('[data-i]')) {
          const at = chosen.indexOf(Number(node.dataset.i));
          node.setAttribute('aria-pressed', String(at >= 0));
          if (at >= 0 && (max > 1 || chosen.length > 1)) node.dataset.order = String(at + 1); else delete node.dataset.order;
        }
        const ready = valid(chosen);
        const ok = actionsNode.querySelector('[data-do="ok"]');
        if (ok) ok.disabled = !ready;
        countNode.hidden = instant && !count;
        countNode.textContent = warn || (count ? count(chosen) : defaultCount(chosen));
        countNode.classList.toggle('ready', ready && !warn);
      };
      refresh();
      const showDetail = (index) => {
        const item = items[index];
        if (!item?.info) return;
        detail.innerHTML = `<div class="ask-detail-art">${item.html || ''}</div><div class="ask-detail-copy"><h3>${escape(item.info.name || '')}</h3>${item.info.stats ? `<p class="ask-detail-meta">${escape(item.info.stats)}</p>` : ''}<p class="ask-detail-text">${escape(item.info.text || '')}</p></div><div class="result-actions"><button class="btn" type="button" data-do="back" data-back="${index}">Voltar</button></div>`;
        detail.hidden = false;
        dialog.classList.add('reading');
        paint(detail);
        detail.querySelector('[data-do="back"]').focus();
      };
      const hideDetail = () => {
        if (detail.hidden) return;
        const back = detail.querySelector('[data-back]')?.dataset.back;
        detail.hidden = true;
        detail.innerHTML = '';
        dialog.classList.remove('reading');
        itemsNode.querySelector(`[data-i="${back}"]`)?.focus();
      };
      const toggle = (index) => {
        if (items[index]?.locked) return;
        const at = chosen.indexOf(index);
        if (at >= 0) chosen.splice(at, 1);
        else if (chosen.length < max) chosen.push(index);
        else if (max === 1) chosen.splice(0, 1, index); // escolha única: tocar outra troca
        else { refresh(`Já há ${max} marcadas — toque numa para desmarcar.`); return; }
        refresh();
      };
      // Segurar abre a leitura (celular); o clique que vem depois do segurar não marca.
      let hold = null;
      let held = false;
      const stopHold = () => { clearTimeout(hold?.timer); hold = null; };
      dialog.onpointerdown = (event) => {
        held = false;
        stopHold();
        const node = event.target.closest('[data-i]');
        if (!node || !items[node.dataset.i]?.info) return;
        hold = { x: event.clientX, y: event.clientY, timer: setTimeout(() => { held = true; showDetail(Number(node.dataset.i)); }, 450) };
      };
      dialog.onpointermove = (event) => { if (hold && Math.hypot(event.clientX - hold.x, event.clientY - hold.y) > 10) stopHold(); };
      dialog.onpointerup = dialog.onpointercancel = stopHold;
      dialog.oncontextmenu = (event) => {
        const node = event.target.closest('[data-i]');
        if (!node || !items[node.dataset.i]?.info) return;
        event.preventDefault();
        if (!held) showDetail(Number(node.dataset.i));
        held = true;
      };
      // Teclado: setas andam pela grade, Enter/Espaço marcam (nativo do botão), I lê a carta.
      dialog.onkeydown = (event) => {
        const node = event.target.closest?.('[data-i]');
        if (!node || dialog.classList.contains('reading')) return;
        if (event.key === 'i' || event.key === 'I') { event.preventDefault(); showDetail(Number(node.dataset.i)); return; }
        const all = [...itemsNode.querySelectorAll('.ask-item')].filter((item) => !(item.closest('.ask-cell') || item).hidden);
        const cols = Math.max(1, all.filter((item) => item.offsetTop === all[0].offsetTop).length);
        const step = { ArrowRight: 1, ArrowLeft: -1, ArrowDown: cols, ArrowUp: -cols }[event.key];
        if (!step) return;
        event.preventDefault();
        all[Math.min(all.length - 1, Math.max(0, all.indexOf(node) + step))]?.focus();
      };
      const done = (value) => {
        stopHold();
        hideDetail();
        dialog.close();
        dialog.onclick = dialog.onkeydown = dialog.onpointerdown = dialog.onpointermove = dialog.onpointerup = dialog.onpointercancel = dialog.oncontextmenu = null;
        resolve(value);
      };
      dialog.onclick = (event) => {
        const info = event.target.closest('[data-info]');
        if (info) { showDetail(Number(info.dataset.info)); return; }
        const item = event.target.closest('[data-i]');
        if (item) {
          if (held) { held = false; return; }
          const index = Number(item.dataset.i);
          if (instant) { done([index]); return; }
          toggle(index);
          return;
        }
        const action = event.target.closest('[data-do]')?.dataset.do;
        if (action === 'back') hideDetail();
        if (action === 'ok' && valid(chosen)) done([...chosen]);
        if (action === 'cancel') done(null);
      };
      dialog.oncancel = (event) => { event.preventDefault(); if (!detail.hidden) hideDetail(); else if (cancel) done(null); };
      dialog.showModal();
      paint(dialog);
    });
  };
}

/** Zonas livres pela máscara do motor (bit ligado = ocupada ou bloqueada), as de `player` primeiro. */
export function freePlaces(mask, player, theirsFirst) {
  const out = [];
  const sides = theirsFirst ? [[1, 1 - player], [0, player]] : [[0, player], [1, 1 - player]];
  for (const [side, owner] of sides) {
    for (const [location, offset, size] of [[L.MZONE, 0, 7], [L.SZONE, 8, 8]]) {
      for (let seq = 0; seq < size; seq += 1) if (!(mask & (1 << (offset + seq + side * 16)))) out.push({ player: owner, location, sequence: seq });
    }
  }
  return out;
}

/**
 * "Não responder mais" na Corrente: lembra as cartas/efeitos oferecidos naquele turno e fase.
 * Antes valia para o turno inteiro: quem dispensava a Armadilha de Invocação na Fase Principal do rival
 * não era perguntado sobre a Armadilha de declaração de ataque na Batalha. Carta, efeito ou fase nova volta a perguntar.
 * skips(prompt, state): true = passa sem perguntar; remember(prompt, state): o jogador pediu para não ser perguntado.
 */
export function chainSkipper() {
  const skipped = new Set();
  const keys = (prompt, state) => prompt.selects.map((loc) => `${state.turn}:${state.phase}:${loc.code}:${loc.location}:${loc.sequence}:${loc.description}`);
  return {
    skips: (prompt, state) => !prompt.forced && keys(prompt, state).every((key) => skipped.has(key)),
    remember: (prompt, state) => { for (const key of keys(prompt, state)) skipped.add(key); },
  };
}

/**
 * Pergunta obrigatória com uma única resposta válida: o índice dela (a arena responde sozinha e avisa), senão -1.
 * Só efeito obrigatório (Corrente forçada) ou seleção de carta que não dá para cancelar; escolha de verdade sempre pergunta.
 */
export function soleChoice(prompt) {
  if (prompt.type === M.SELECT_CHAIN) return prompt.forced && prompt.selects.length === 1 ? 0 : -1;
  if (prompt.type === M.SELECT_CARD) return !prompt.can_cancel && prompt.min <= 1 && prompt.max >= 1 && prompt.selects.length === 1 ? 0 : -1;
  return -1;
}

/**
 * Responde as perguntas que não dependem do tapete. Devolve undefined quando a pergunta é da página.
 * ctx: { ask, me, cards, cardOf(code), cardItem(loc), face(card), back(), describe(desc, args), hint(fallback), toast?(text),
 *        races: [nome por bit], attributes: { bit: nome }, inDuel: Set de ids do duelo,
 *        plan: { target: { controller, sequence } | null, tributes: [seq] | null, zone: { location, sequence } | null } }
 * plan guarda o que o gesto já decidiu (alvo do ataque arrastado, tributo solto em cima, zona onde a carta caiu).
 */
export async function answerCommon(prompt, ctx) {
  const { ask, me, cards, cardOf, cardItem, face, back, describe, hint, plan } = ctx;
  if (prompt.type !== M.SELECT_UNSELECT_CARD) plan.picks = null; // passos de uma seleção já encerrada pelo motor
  switch (prompt.type) {
    case M.SELECT_EFFECTYN: {
      // Como no EDOPro: description 0 = sistema 200; 200 e 221 levam nome e local ("%ls" (%ls)); rótulo de carta leva só o nome.
      const name = cardOf(prompt.code).name;
      const title = describe(Number(prompt.description) || 200, [name, placeName(prompt.location, prompt.sequence)]) || `Usar o efeito de "${name}"?`;
      const chosen = await ask({ title, items: [{ html: face(cardOf(prompt.code)), label: 'Sim' }, { label: 'Não' }] });
      return { type: R.SELECT_EFFECTYN, yes: chosen[0] === 0 };
    }
    case M.SELECT_YESNO: {
      if (Number(prompt.description) === 31 && plan.target === null) return { type: R.SELECT_YESNO, yes: true }; // "Atacar diretamente?" depois de arrastar ao rival
      const chosen = await ask({ title: describe(prompt.description), items: [{ label: 'Sim' }, { label: 'Não' }] });
      return { type: R.SELECT_YESNO, yes: chosen[0] === 0 };
    }
    case M.SELECT_OPTION: {
      const chosen = await ask({ title: 'Escolha uma opção', items: prompt.options.map((option) => ({ label: describe(option) })) });
      return { type: R.SELECT_OPTION, index: chosen[0] };
    }
    case M.SELECT_CARD: case M.SELECT_TRIBUTE: {
      // Alvo do ataque arrastado ou tributo solto em cima: responde sozinho.
      const planned = prompt.type === M.SELECT_TRIBUTE ? plan.tributes : plan.target ? [plan.target.sequence] : null;
      if (planned) {
        const indices = prompt.selects.map((loc, index) => (loc.location === L.MZONE && planned.includes(loc.sequence) && (prompt.type === M.SELECT_TRIBUTE ? loc.controller === me : loc.controller === plan.target?.controller) ? index : -1)).filter((index) => index >= 0);
        plan.target = null;
        if (prompt.type === M.SELECT_TRIBUTE) plan.tributes = null;
        if (indices.length >= prompt.min) return { type: prompt.type === M.SELECT_CARD ? R.SELECT_CARD : R.SELECT_TRIBUTE, indicies: indices.slice(0, Math.max(prompt.min, 1)) };
      }
      if (soleChoice(prompt) >= 0) { ctx.toast?.(`${hint('Escolha')}: ${cardItem(prompt.selects[0]).label}.`); return { type: R.SELECT_CARD, indicies: [0] }; }
      const items = prompt.selects.map(cardItem);
      // Tributo: a soma de release_param precisa fechar o mínimo (monstros que valem 2 tributos).
      const tribute = prompt.type === M.SELECT_TRIBUTE;
      const worth = (chosen) => chosen.reduce((sum, index) => sum + (prompt.selects[index].release_param || 1), 0);
      const valid = tribute ? (chosen) => worth(chosen) >= prompt.min && chosen.length <= prompt.max : undefined;
      const count = tribute ? (chosen) => {
        const left = prompt.min - worth(chosen);
        return left > 0 ? `Selecione ${prompt.min} Tributo${prompt.min > 1 ? 's' : ''} — falta${left > 1 ? 'm' : ''} ${left}` : `${chosen.length} Tributo${chosen.length > 1 ? 's' : ''} marcado${chosen.length > 1 ? 's' : ''} — pode confirmar`;
      } : undefined;
      // Sempre com Confirmar (mesmo 1 de 1): alvo e tributo não saem num toque errado, e dá para ler a carta antes.
      const chosen = await ask({ title: `${hint('Escolha')}${prompt.max > 1 ? ` (${prompt.min === prompt.max ? prompt.min : `${prompt.min} a ${prompt.max}`})` : ''}`, items, min: prompt.min, max: prompt.max, cancel: prompt.can_cancel, valid, count, instant: false, search: items.length > 12, ...(tribute && { note: 'Tributo: o monstro marcado vai para o Cemitério para dar lugar ao novo.' }) });
      return { type: prompt.type === M.SELECT_CARD ? R.SELECT_CARD : R.SELECT_TRIBUTE, indicies: chosen };
    }
    case M.SELECT_UNSELECT_CARD: {
      // O motor pergunta uma carta por vez (índice em select_cards ++ unselect_cards; null = concluir/cancelar).
      // Com max > 1 a janela coleta a seleção inteira e plan.picks responde os passos seguintes sozinho;
      // se o motor deixar de oferecer a próxima carta (combinação inválida), volta a perguntar com o que já foi marcado.
      const all = [...prompt.select_cards, ...prompt.unselect_cards];
      const same = (a, b) => a.controller === b.controller && a.location === b.location && a.sequence === b.sequence && a.code === b.code;
      if (plan.picks) {
        const next = plan.picks[0];
        const at = next ? all.findIndex((loc) => same(loc, next)) : -1;
        if (at >= 0) { plan.picks.shift(); return { type: R.SELECT_UNSELECT_CARD, index: at }; }
        const finished = !next && prompt.can_finish;
        plan.picks = null;
        if (finished) return { type: R.SELECT_UNSELECT_CARD, index: null };
      }
      const before = prompt.unselect_cards.map((_, j) => prompt.select_cards.length + j);
      const items = all.map(cardItem);
      if (prompt.max <= 1) {
        // Passo a passo (scripts que não informam o total): um toque responde; as já marcadas aparecem marcadas.
        if (prompt.can_finish) items.push({ label: 'Concluir' });
        const chosen = await ask({ title: hint('Escolha as cartas'), items, cancel: prompt.can_cancel, chosen: before, count: () => (before.length ? `${before.length} marcada${before.length > 1 ? 's' : ''} — toque numa para desmarcar` : 'Toque numa carta para marcar') });
        if (!chosen || chosen[0] >= all.length) return { type: R.SELECT_UNSELECT_CARD, index: null };
        return { type: R.SELECT_UNSELECT_CARD, index: chosen[0] };
      }
      const chosen = await ask({ title: hint('Escolha as cartas'), items, min: prompt.min, max: prompt.max, cancel: prompt.can_cancel, chosen: before, instant: false, search: items.length > 12,
        // Sem mudança só vale como "concluir" quando o motor deixa concluir.
        valid: (list) => list.length >= prompt.min && list.length <= prompt.max && (prompt.can_finish || list.length !== before.length || list.some((i) => !before.includes(i))) });
      if (!chosen) return { type: R.SELECT_UNSELECT_CARD, index: null };
      const steps = [...before.filter((i) => !chosen.includes(i)), ...chosen.filter((i) => !before.includes(i))];
      if (!steps.length) return { type: R.SELECT_UNSELECT_CARD, index: null }; // nada mudou: concluir
      plan.picks = steps.slice(1).map((i) => all[i]);
      return { type: R.SELECT_UNSELECT_CARD, index: steps[0] };
    }
    case M.SELECT_SUM: {
      // Cada carta vale level ou alt (amount = level | alt << 16, ex.: tributo que conta como 2 Níveis), como no motor.
      const level = (loc) => loc.amount & 0xffff;
      const alt = (loc) => loc.amount >>> 16 || level(loc);
      const fits = (chosen) => {
        const used = [...prompt.selects_must, ...chosen.map((i) => prompt.selects[i])];
        if (prompt.max && (used.length < prompt.min || used.length > prompt.max)) return false;
        if (prompt.select_max) {
          // "Pelo menos" (Ritual): a soma alcança o total e nenhuma carta sobra (tirar a menor já não alcança), senão RETRY.
          const most = used.reduce((sum, loc) => sum + Math.max(level(loc), alt(loc)), 0);
          const least = used.reduce((sum, loc) => sum + level(loc), 0);
          return most >= prompt.amount && least - Math.min(...used.map((loc) => Math.min(level(loc), alt(loc)))) < prompt.amount;
        }
        // Exata: alguma combinação de level/alt fecha o total.
        let sums = new Set([0]);
        for (const loc of used) sums = new Set([...sums].flatMap((sum) => [sum + level(loc), sum + alt(loc)]));
        return sums.has(prompt.amount);
      };
      // As obrigatórias (selects_must) aparecem já marcadas e travadas na frente; a resposta leva só índices de selects.
      const k = prompt.selects_must.length;
      const own = (chosen) => chosen.filter((i) => i >= k).map((i) => i - k);
      const levelLabel = (loc) => `${cardItem(loc).label} · ${level(loc)}${alt(loc) !== level(loc) ? `/${alt(loc)}` : ''}`;
      const items = [...prompt.selects_must.map((loc) => ({ ...cardItem(loc), label: `${levelLabel(loc)} (obrigatória)`, locked: true })), ...prompt.selects.map((loc) => ({ ...cardItem(loc), label: levelLabel(loc) }))];
      const count = (chosen) => {
        const used = [...prompt.selects_must, ...own(chosen).map((i) => prompt.selects[i])];
        const a = used.reduce((sum, loc) => sum + level(loc), 0);
        const b = used.reduce((sum, loc) => sum + alt(loc), 0);
        return `Soma ${a}${b !== a ? ` (ou ${b})` : ''} de ${prompt.select_max ? 'pelo menos ' : ''}${prompt.amount}${fits(own(chosen)) ? ' — pode confirmar' : ''}`;
      };
      const chosen = await ask({ title: hint('Escolha as cartas'), items, min: 1, max: items.length, valid: (list) => fits(own(list)), count, chosen: [...Array(k).keys()], instant: false });
      return { type: R.SELECT_SUM, indicies: own(chosen) };
    }
    case M.SELECT_POSITION: {
      const options = [[P.FACEUP_ATTACK, 'Ataque'], [P.FACEUP_DEFENSE, 'Defesa'], [P.FACEDOWN_DEFENSE, 'Defesa virada'], [P.FACEDOWN_ATTACK, 'Ataque virado']].filter(([bit]) => prompt.positions & bit);
      if (options.length === 1) return { type: R.SELECT_POSITION, position: options[0][0] };
      const chosen = await ask({ title: `Posição de ${cardOf(prompt.code).name}`, items: options.map(([bit, label]) => ({ html: bit & (P.FACEDOWN_ATTACK | P.FACEDOWN_DEFENSE) ? back() : face(cardOf(prompt.code)), label })) });
      return { type: R.SELECT_POSITION, position: options[chosen[0]][0] };
    }
    case M.SELECT_PLACE: case M.SELECT_DISFIELD: {
      const type = prompt.type === M.SELECT_PLACE ? R.SELECT_PLACE : R.SELECT_DISFIELD;
      const free = freePlaces(prompt.field_mask, prompt.player, prompt.type === M.SELECT_DISFIELD);
      // A zona onde a carta foi solta vale se estiver livre; senão, a primeira livre.
      const zone = plan.zone && free.find((place) => place.location === plan.zone.location && place.sequence === plan.zone.sequence && place.player === me);
      plan.zone = null;
      return { type, places: zone ? [zone] : free.slice(0, prompt.count || 1) };
    }
    case M.SELECT_COUNTER: { let left = prompt.count; return { type: R.SELECT_COUNTER, counters: prompt.cards.map((card) => { const take = Math.min(left, card.count ?? left); left -= take; return take; }) }; }
    case M.SORT_CARD: case M.SORT_CHAIN: {
      // Toca nas cartas na ordem desejada; "Ordem padrão" (null) deixa o motor decidir, como antes.
      if (prompt.cards.length < 2) return { type: R.SORT_CARD, order: null };
      const chain = prompt.type === M.SORT_CHAIN;
      const chosen = await ask({ title: chain ? 'Ordem da Corrente: toque na que entra primeiro (resolve por último)' : 'Ordem das cartas: toque primeiro na que fica em cima', items: prompt.cards.map(cardItem), min: prompt.cards.length, max: prompt.cards.length, cancel: 'Ordem padrão', instant: false });
      // O motor quer, para cada carta (na ordem da mensagem), a posição dela na ordem nova (0 = primeira).
      return { type: R.SORT_CARD, order: chosen && prompt.cards.map((_, index) => chosen.indexOf(index)) };
    }
    case M.ROCK_PAPER_SCISSORS: { const chosen = await ask({ title: 'Pedra, papel ou tesoura?', items: [{ label: 'Tesoura' }, { label: 'Pedra' }, { label: 'Papel' }] }); return { type: R.ROCK_PAPER_SCISSORS, value: chosen[0] + 1 }; }
    case M.ANNOUNCE_NUMBER: { const chosen = await ask({ title: 'Declare um número', items: prompt.options.map((value) => ({ label: String(value) })) }); return { type: R.ANNOUNCE_NUMBER, value: chosen[0] }; }
    case M.ANNOUNCE_RACE: {
      const bits = ctx.races.map((label, i) => [1n << BigInt(i), label]).filter(([bit, label]) => label && BigInt(prompt.available) & bit);
      const chosen = await ask({ title: `Declare ${prompt.count > 1 ? `${prompt.count} Tipos` : 'um Tipo'}`, items: bits.map(([, label]) => ({ label })), min: prompt.count, max: prompt.count, instant: prompt.count === 1 });
      return { type: R.ANNOUNCE_RACE, races: chosen.map((i) => bits[i][0]) };
    }
    case M.ANNOUNCE_ATTRIB: {
      const bits = Object.entries(ctx.attributes).map(([bit, label]) => [Number(bit), label]).filter(([bit]) => prompt.available & bit);
      const chosen = await ask({ title: `Declare ${prompt.count > 1 ? `${prompt.count} Atributos` : 'um Atributo'}`, items: bits.map(([, label]) => ({ label })), min: prompt.count, max: prompt.count, instant: prompt.count === 1 });
      return { type: R.ANNOUNCE_ATTRIB, attributes: chosen.map((i) => bits[i][0]) };
    }
    case M.ANNOUNCE_CARD: {
      // Todas as cartas válidas com busca por nome (PT ou EN). As do duelo vêm primeiro e com imagem;
      // o resto só com o nome, para o diálogo continuar leve.
      const inDuel = ctx.inDuel;
      const valid = [...cards.values()].filter((card) => card.name && !card.skill && cardMatchesOpcode(toCoreCard(card), prompt.opcodes))
        .sort((a, b) => inDuel.has(b.id) - inDuel.has(a.id) || (b.pop || 0) - (a.pop || 0));
      if (!valid.length) {
        // Nenhuma carta do pool serve: scripts Rush citam o código da carta clássica, que só existe como alias.
        const codes = prompt.opcodes.filter((op, i) => prompt.opcodes[i + 1] === OcgOpCode.ISCODE && op < 0x100000000n).map(Number);
        return { type: R.ANNOUNCE_CARD, card: codes[0] ?? 0 };
      }
      const chosen = await ask({ title: 'Declare o nome de uma carta', search: true, items: valid.map((card) => ({ html: inDuel.has(card.id) ? face(card) : '', label: card.name, keywords: card.nameEn })) });
      return { type: R.ANNOUNCE_CARD, card: valid[chosen[0]].id };
    }
    default:
      return undefined;
  }
}
