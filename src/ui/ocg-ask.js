// Perguntas do motor do EDOPro em diálogos: o que as duas arenas (clássica e Rush) respondem igual.
// A página cuida do que depende do tapete (Fase Principal, Batalha, Corrente); aqui ficam as escolhas de cartas,
// posições, zonas, sim/não, opções, números e declarações.
import { OcgLocation as L, OcgMessageType as M, OcgOpCode, OcgPosition as P, OcgResponseType as R, cardMatchesOpcode } from '../vendor/ocgcore/index.js';
import { toCoreCard } from '../engine/ocg.mjs';
import { escape } from './common.js';

export const fold = (text) => String(text).normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase();

/**
 * Diálogo de escolhas ligado a um <dialog> com título, lista e ações (ids: ask, ask-title, ask-items, ask-actions).
 * ask({ title, items: [{ html, label, keywords }], min, max, cancel, valid, instant, search, note }) -> índices ou null.
 * paint(root) preenche as imagens das cartas depois de desenhar a lista.
 */
export function createAsk({ dialog, title: titleNode, items: itemsNode, actions: actionsNode, note: noteNode = null, paint = () => {} }) {
  return function ask({ title, items, min = 1, max = 1, cancel = false, valid = (chosen) => chosen.length >= min && chosen.length <= max, instant = max === 1 && min === 1, search = false, note = '' }) {
    return new Promise((resolve) => {
      const chosen = [];
      titleNode.textContent = title;
      if (noteNode) { noteNode.innerHTML = note; noteNode.hidden = !note; }
      // search: campo que filtra pelo rótulo (e por item.keywords), ignorando acentos.
      itemsNode.innerHTML = `${search ? '<input type="search" class="ask-search" placeholder="Buscar pelo nome" aria-label="Buscar pelo nome">' : ''}${items.map((item, index) => `<button type="button" class="ask-item ${item.html ? 'with-card' : ''}" data-i="${index}" data-find="${escape(fold(`${item.label || ''} ${item.keywords || ''}`))}" aria-pressed="false">${item.html || ''}<span>${escape(item.label || '')}</span></button>`).join('')}`;
      if (search) {
        const input = dialog.querySelector('.ask-search');
        input.oninput = () => {
          const query = fold(input.value.trim());
          for (const node of dialog.querySelectorAll('.ask-item')) node.hidden = Boolean(query) && !node.dataset.find.includes(query);
        };
        setTimeout(() => input.focus(), 50);
      }
      const confirm = instant ? '' : '<button class="btn" type="button" data-do="ok" disabled>Confirmar</button>';
      actionsNode.innerHTML = `${confirm}${cancel ? '<button class="btn ghost" type="button" data-do="cancel">Cancelar</button>' : ''}`;
      const done = (value) => { dialog.close(); dialog.onclick = null; resolve(value); };
      dialog.onclick = (event) => {
        const item = event.target.closest('[data-i]');
        if (item) {
          const index = Number(item.dataset.i);
          if (instant) { done([index]); return; }
          const at = chosen.indexOf(index);
          if (at >= 0) chosen.splice(at, 1); else if (chosen.length < max) chosen.push(index);
          item.setAttribute('aria-pressed', String(at < 0 && chosen.includes(index)));
          const ok = dialog.querySelector('[data-do="ok"]');
          if (ok) ok.disabled = !valid(chosen);
          return;
        }
        const action = event.target.closest('[data-do]')?.dataset.do;
        if (action === 'ok') done([...chosen]);
        if (action === 'cancel') done(null);
      };
      dialog.oncancel = (event) => { event.preventDefault(); if (cancel) done(null); };
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
 * Responde as perguntas que não dependem do tapete. Devolve undefined quando a pergunta é da página.
 * ctx: { ask, me, cards, cardOf(code), cardItem(loc), face(card), back(), describe(desc, args), hint(fallback),
 *        races: [nome por bit], attributes: { bit: nome }, inDuel: Set de ids do duelo,
 *        plan: { target: { controller, sequence } | null, tributes: [seq] | null, zone: { location, sequence } | null } }
 * plan guarda o que o gesto já decidiu (alvo do ataque arrastado, tributo solto em cima, zona onde a carta caiu).
 */
export async function answerCommon(prompt, ctx) {
  const { ask, me, cards, cardOf, cardItem, face, back, describe, hint, plan } = ctx;
  switch (prompt.type) {
    case M.SELECT_EFFECTYN: {
      const chosen = await ask({ title: `${describe(prompt.description, [cardOf(prompt.code).name]) || `Usar o efeito de "${cardOf(prompt.code).name}"?`}`, items: [{ html: face(cardOf(prompt.code)), label: 'Sim' }, { label: 'Não' }] });
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
      const items = prompt.selects.map(cardItem);
      // Tributo: a soma de release_param precisa fechar o mínimo (monstros que valem 2 tributos).
      const valid = prompt.type === M.SELECT_TRIBUTE
        ? (chosen) => chosen.reduce((sum, index) => sum + (prompt.selects[index].release_param || 1), 0) >= prompt.min && chosen.length <= prompt.max
        : undefined;
      const chosen = await ask({ title: `${hint('Escolha')}${prompt.max > 1 ? ` (${prompt.min === prompt.max ? prompt.min : `${prompt.min} a ${prompt.max}`})` : ''}`, items, min: prompt.min, max: prompt.max, cancel: prompt.can_cancel, valid, instant: prompt.min === 1 && prompt.max === 1 });
      return { type: prompt.type === M.SELECT_CARD ? R.SELECT_CARD : R.SELECT_TRIBUTE, indicies: chosen };
    }
    case M.SELECT_UNSELECT_CARD: {
      const items = [...prompt.select_cards.map(cardItem), ...prompt.unselect_cards.map((loc) => ({ ...cardItem(loc), label: `✓ ${cardItem(loc).label}` }))];
      if (prompt.can_finish) items.push({ label: 'Concluir' });
      const chosen = await ask({ title: hint('Escolha as cartas'), items, cancel: prompt.can_cancel });
      if (!chosen || (prompt.can_finish && chosen[0] === items.length - 1)) return { type: R.SELECT_UNSELECT_CARD, index: null };
      return { type: R.SELECT_UNSELECT_CARD, index: chosen[0] };
    }
    case M.SELECT_SUM: {
      const level = (loc) => loc.amount & 0xffff;
      const alt = (loc) => loc.amount >>> 16 || level(loc);
      const fixed = prompt.selects_must.reduce((sum, loc) => sum + level(loc), 0);
      const fits = (chosen) => {
        const a = fixed + chosen.reduce((sum, i) => sum + level(prompt.selects[i]), 0);
        const b = fixed + chosen.reduce((sum, i) => sum + alt(prompt.selects[i]), 0);
        return prompt.select_max ? a >= prompt.amount : a === prompt.amount || b === prompt.amount;
      };
      const chosen = await ask({ title: `${hint('Escolha as cartas')} (total ${prompt.amount})`, items: prompt.selects.map((loc) => ({ ...cardItem(loc), label: `${cardItem(loc).label} · ${level(loc)}` })), min: 1, max: prompt.selects.length, valid: fits, instant: false });
      return { type: R.SELECT_SUM, indicies: chosen };
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
    case M.SORT_CARD: case M.SORT_CHAIN: return { type: R.SORT_CARD, order: null };
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
