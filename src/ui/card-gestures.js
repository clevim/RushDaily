/* Interação com as cartas, comum às arenas Rush (duel.js) e Clássica (arena.js).
 * Sem efeitos ao importar: cada arena chama bindCardGestures() com os seus ganchos.
 *
 * Modelo: tocar numa carta sua com ações abre a barra de ações ao lado dela (sem espera);
 * nas outras, abre a leitura. Tocar duas vezes = atalho (mudar posição / alternar jogar-baixar),
 * segurar = ler (em qualquer carta; no PC também clique direito, e passar o mouse mostra a prévia),
 * arrastar = jogar na zona acesa (ou atacar o alvo aceso).
 * "Atacar" na barra acende os alvos: tocar num deles ataca, tocar fora cancela.
 * As respostas ao motor saem sempre das ações que o motor ofereceu (actions/targets da arena). */
import { OcgLocation as L } from '../vendor/ocgcore/index.js';
import { escape } from './common.js';

const HOLD_MS = 420;
const DOUBLE_TAP_MS = 320;
const DRAG_PX = 10;

const ICONS = {
  summon: '<path d="M12 3v12m-5-5 5 5 5-5M5 20h14"/>',
  set: '<rect x="6" y="3" width="12" height="18" rx="1.5"/><path d="m9 9 6 6m0-6-6 6"/>',
  activate: '<path d="M13 2 5 14h6l-1 8 8-12h-6z"/>',
  position: '<path d="M20 12a8 8 0 1 1-2.3-5.6M20 4v5h-5"/>',
  attack: '<path d="m4 20 9-9m-6 9-3-3m16-13-9 9 3 3 9-9V4z"/>',
  info: '<circle cx="12" cy="12" r="9"/><path d="M12 11v6m0-10v.01"/>',
};
const icon = (name) => `<svg viewBox="0 0 24 24" aria-hidden="true" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round">${ICONS[name]}</svg>`;
const kindOf = (item) => ({ 0: 'summon', 1: 'summon', 2: 'position', 3: 'set', 4: 'set', 5: 'activate', attack: 'attack' }[item.action] || 'activate');
/** Rótulo curto para a barra (o completo vai no title/aria-label). */
export function shortLabel(item) {
  if (item.action === 0) return 'Invocar';
  if (item.action === 1) return 'Especial';
  if (item.action === 3) return 'Baixar'; // monstro baixado: virado em defesa
  if (item.action === 4) return 'Baixar';
  if (item.action === 'attack') return 'Atacar';
  if (item.action === 2) return /^Mudar para /.test(item.label) ? item.label.slice(11) : /Virad|Virar/.test(item.label) ? 'Virar' : 'Posição';
  return 'Ativar';
}
/** Mouse (PC): os textos dizem "Clique" em vez de "Toque". Sem matchMedia (testes no Node) fica "Toque". */
export const tapText = (text) => (globalThis.matchMedia?.('(pointer: fine)').matches ? text.replace(/\bToque\b/g, 'Clique').replace(/\btoque\b/g, 'clique') : text);

/** Onde a carta está, para os rótulos dos diálogos (igual no Rush e no clássico): "sua mão", "mão do rival". */
const WHERE = { [L.HAND]: ['sua mão', 'mão do rival'], [L.MZONE]: ['seu campo', 'campo do rival'], [L.SZONE]: ['seu campo', 'campo do rival'], [L.GRAVE]: ['seu Cemitério', 'Cemitério do rival'],
  [L.REMOVED]: ['suas banidas', 'banidas do rival'], [L.EXTRA]: ['seu Deck Adicional', 'Deck Adicional do rival'], [L.DECK]: ['seu Deck', 'Deck do rival'] };
export const whereLabel = (location, mine) => WHERE[location]?.[mine ? 0 : 1] || '';

export const BLOCKED = 'Um efeito impede isso agora.';
/** Tooltip do selo ↻ (monstro que ainda pode mudar de posição); title só aparece com mouse. */
export const POS_TITLE = '↻ Mudar posição: clique duas vezes na carta ou use a barra de ações.';
export const RIVAL_TURN = 'Agora é a vez do rival. Espere a sua vez para jogar.';
/** Dica do chip "Turno 7/30": o número conta as vezes dos dois duelistas, não só as suas. */
export const turnChipTitle = (limit) => `Turnos somados: cada vez (sua ou do rival) conta 1.${limit ? ` O duelo termina depois do turno ${limit}.` : ''}`;
export const TRAP_SET_WHY = 'Armadilha baixada neste turno só pode ser ativada a partir do próximo turno.';
/**
 * "Por que não dá agora?" de um monstro seu no campo, com o mesmo texto no Rush e no clássico.
 * Só afirma o que as marcas do turno (duel.state.marks) e a pergunta aberta mostram; o resto é BLOCKED.
 * f: { battle (pergunta da Batalha), canBattle (dá para ir à Batalha), firstTurn, summoned, set, moved, attacked, attackPos }
 */
export function monsterWhyNot(f) {
  if (f.battle) {
    if (f.firstTurn) return 'Quem começa não ataca no primeiro turno.';
    if (f.attacked) return 'Este monstro já atacou neste turno.';
    if (!f.attackPos) return 'Só monstros em Posição de Ataque atacam.';
    return BLOCKED;
  }
  const position = f.set ? 'Monstro baixado neste turno só pode ser virado a partir do próximo turno.'
    : f.summoned ? 'Monstro Invocado neste turno não pode mudar de posição.'
      : f.moved ? 'Este monstro já mudou de posição neste turno.'
        : f.attacked ? 'Monstro que atacou neste turno não muda mais de posição.' : BLOCKED;
  const attack = f.firstTurn ? ' Quem começa não ataca no primeiro turno.' : f.canBattle ? ' Para atacar, vá para a Batalha.' : '';
  return position + attack;
}

/** "Nível 4 · Guerreiro · ATK 1800 / DEF 1200" -> meta + força (ATK/DEF em destaque). */
export function splitStats(stats = '') {
  const match = stats.match(/^(.*?)\s*·?\s*(ATK .*)$/);
  return match ? { meta: match[1], power: match[2] } : { meta: stats, power: '' };
}

/**
 * @param {object} a ganchos da arena
 *  live(): há pergunta aberta do motor; actions(key): ações da carta; targets(key): alvos de soltar/atacar;
 *  pick(item): responde com a ação escolhida; drop(target): responde com o alvo; describe(key): conteúdo da leitura
 *  ({ html, name, stats, text, hidden }) ou null; paint(el); doubleTap(key); dragHint?(key); beforeDown?(event);
 *  whyNot?(key): motivo, em texto, de a carta não ter ação agora (mostrado na leitura)
 * Segurar, clique direito e (no PC) passar o mouse chamam a mesma leitura: showInfo(key). A prévia do mouse
 * marca #zoom com .preview (sem foco, sem botões, sem bloquear o campo); quem posiciona é o CSS do layout.
 */
export function bindCardGestures(a) {
  const zoom = document.querySelector('#zoom');
  const hint = document.querySelector('#hint');
  let press = null; // dedo/mouse apertado numa carta
  let marked = null; // carta cujos alvos estão acesos (arrastando ou mirando)
  let aiming = false; // "Atacar" escolhido, esperando o toque no alvo
  let bar = null; // { key, el }
  let lastTap = { key: null, at: 0 };
  let savedHint = null;
  let zoomReturn = null;
  let previewKey = null; // carta da prévia do mouse (PC); null = leitura de verdade ou nenhuma
  let quietUntil = 0; // ignora o clique sintético do toque que abriu a leitura (ou do dedo que segurou)
  const reading = () => Boolean(zoom?.classList.contains('show')) && !previewKey;
  const cardNode = (key) => document.querySelector(`[data-gesture][data-loc="${key}"]:not([data-side])`);
  // Painel de leitura fixo (PC): só vale quando o layout o mostra (no celular ele some e a leitura é a folha #zoom).
  const reader = document.querySelector('#reader');
  const docked = () => Boolean(reader?.offsetParent);
  let readerKey = null;
  let readerActions = [];
  reader?.addEventListener('click', (event) => {
    const button = event.target.closest('button');
    if (button?.dataset.term) showTerm(button);
    else if (button?.dataset.act !== undefined) run(readerKey, readerActions[Number(button.dataset.act)], event.detail === 0);
  });

  function setHint(text) {
    if (!hint) return;
    if (text) { savedHint ??= hint.textContent; hint.textContent = text; } else if (savedHint !== null) { hint.textContent = savedHint; savedHint = null; }
    hint.classList.toggle('live', Boolean(text)); // no celular a dica fica escondida: a do gesto (mirar/arrastar) aparece por cima da bandeja
  }
  function mark(key = marked) {
    marked = key;
    document.querySelectorAll('.drop-ok, .drop-hover').forEach((node) => { node.classList.remove('drop-ok', 'drop-hover'); delete node.dataset.forecast; delete node.dataset.tone; });
    if (key) for (const target of a.targets(key)) {
      const node = document.querySelector(target.node);
      node?.classList.add('drop-ok');
      // Previsão do combate no alvo (a arena manda { text, tone }): evita atacar sem querer um monstro mais forte.
      if (node && target.forecast) Object.assign(node.dataset, { forecast: target.forecast.text, tone: target.forecast.tone });
    }
  }
  function stopAim() { if (!aiming) return; aiming = false; cardNode(marked)?.classList.remove('selected'); mark(null); setHint(null); }
  function closeBar(refocus = false) {
    if (!bar) return;
    const { key, el } = bar;
    bar = null;
    el.remove();
    cardNode(key)?.classList.remove('selected');
    if (refocus) cardNode(key)?.focus();
  }
  const targetAt = (key, over) => over && a.targets(key).find((item) => document.querySelector(item.node) === over);

  /* Ação escolhida (barra ou leitura). Atacar com ponteiro mira; pelo teclado o motor pergunta o alvo. */
  function run(key, item, keyboard) {
    closeBar();
    hideInfo();
    if (item.action === 'attack' && !keyboard && a.targets(key).length) {
      aiming = true;
      mark(key);
      cardNode(key)?.classList.add('selected');
      const direct = a.targets(key).some((target) => target.target === null);
      setHint(tapText(`Toque no alvo aceso${direct ? ' (ou no rival para ataque direto)' : ''}. Toque fora para cancelar.`));
      return;
    }
    a.pick(item);
  }

  function openBar(key, focus = false) {
    closeBar();
    const actions = a.live() ? a.actions(key) : [];
    const node = cardNode(key);
    if (!actions.length || !node) { showInfo(key, { focus }); return; }
    const el = document.createElement('div');
    el.className = 'card-bar';
    el.setAttribute('role', 'toolbar');
    el.setAttribute('aria-label', 'Ações da carta');
    el.innerHTML = actions.map((item, index) => `<button type="button" class="${index ? '' : 'primary'}" data-act="${index}" title="${escape(item.label)}" aria-label="${escape(item.label)}">${icon(kindOf(item))}<span>${escape(shortLabel(item))}</span></button>`).join('')
      + `<button type="button" data-info aria-label="Ler a carta">${icon('info')}<span>Info</span></button>`;
    node.classList.add('selected');
    document.body.append(el);
    const r = node.getBoundingClientRect();
    const b = el.getBoundingClientRect();
    const top = r.top - b.height - 10 >= 8 ? r.top - b.height - 10 : Math.min(r.bottom + 10, innerHeight - b.height - 8);
    el.style.left = `${Math.max(8, Math.min(r.left + r.width / 2 - b.width / 2, innerWidth - b.width - 8))}px`;
    el.style.top = `${Math.max(8, top)}px`;
    el.addEventListener('click', (event) => {
      const button = event.target.closest('button');
      if (!button) return;
      const keyboard = event.detail === 0;
      if ('info' in button.dataset) { closeBar(); showInfo(key, { focus: keyboard }); return; }
      run(key, actions[Number(button.dataset.act)], keyboard);
    });
    bar = { key, el };
    if (focus) el.querySelector('button').focus();
  }

  /* ---------- Leitura: bottom sheet no celular, painel lateral no PC ---------- */
  function showInfo(key, { focus = false, preview = false } = {}) {
    const info = a.describe(key);
    if (!info || !zoom) return;
    if (!preview) closeBar();
    const actions = info.hidden || !a.live() ? [] : a.actions(key);
    // Carta sua sem botão: diz por quê (o novato não conhece a regra que bloqueou).
    const why = !actions.length && !info.hidden ? a.whyNot?.(key) : null;
    const { meta, power } = splitStats(info.stats);
    const body = (nameId) => `<div class="zoom-art"><div class="card">${info.html}</div></div>
      <div class="zoom-copy">
        <h2${nameId}>${escape(info.hidden ? 'Carta virada' : info.name)}</h2>
        ${info.hidden ? '<p class="zoom-text">Você ainda não sabe qual é.</p>' : linkTerms(`${meta ? `<p class="zoom-meta">${escape(meta)}</p>` : ''}${power ? `<p class="zoom-power">${escape(power)}</p>` : ''}<p class="zoom-text">${escape(info.text || '')}</p>`)}
        ${why ? `<p class="zoom-why" role="note"><b>Por que não dá agora?</b> ${escape(why)}</p>` : ''}
      </div>`;
    const acts = actions.map((item, index) => `<button class="zoom-act ${index ? '' : 'primary'}" type="button" data-act="${index}">${icon(kindOf(item))}<span>${escape(item.label)}</span></button>`).join('');
    // PC: a leitura vai para o painel fixo da coluna da direita (#reader), sem cobrir o campo; ele guarda a última
    // carta lida. A prévia do mouse só mostra a carta; o clique mostra também as ações (sem "Fechar").
    if (docked()) {
      if (preview && readerKey === key) return; // já está no painel (talvez com as ações do clique)
      reader.innerHTML = `<div class="reader-card">${body('')}${preview || !actions.length ? '' : `<div class="zoom-actions">${acts}</div>`}</div>`;
      a.paint?.(reader);
      readerKey = key;
      readerActions = actions;
      if (focus) reader.querySelector('.zoom-act')?.focus({ preventScroll: true });
      return;
    }
    zoom.innerHTML = `<div class="zoom-panel" role="dialog" aria-modal="true" aria-labelledby="zoom-name" tabindex="-1">
      <span class="zoom-grab" aria-hidden="true"></span>
      ${body(' id="zoom-name"')}
      <div class="zoom-actions">${acts}<button class="zoom-act" type="button" data-close>Fechar</button></div>
    </div>`;
    zoom.classList.add('show');
    zoom.classList.toggle('preview', preview);
    zoom.setAttribute('aria-hidden', String(preview));
    a.paint?.(zoom);
    const panel = zoom.querySelector('.zoom-panel');
    if (preview) { previewKey = key; return; } // prévia: não rouba o foco nem responde a clique
    zoomReturn = document.activeElement;
    previewKey = null;
    (focus ? panel.querySelector('button') : panel).focus({ preventScroll: true });
    quietUntil = Math.max(quietUntil, performance.now() + 350);
    zoom.onclick = (event) => {
      if (performance.now() < quietUntil && event.detail !== 0) return; // o clique sintético do próprio toque que abriu
      const button = event.target.closest('button');
      if (button?.dataset.term) { showTerm(button); return; }
      if (button?.dataset.act !== undefined) { run(key, actions[Number(button.dataset.act)], event.detail === 0); return; }
      if (button || !event.target.closest('.zoom-panel')) hideInfo();
    };
    // Arrastar a alça/cabeçalho para baixo fecha (celular).
    let startY = null;
    panel.onpointerdown = (event) => { if (event.target.closest('.zoom-grab, .zoom-art') && panel.scrollTop <= 0) startY = event.clientY; };
    panel.onpointermove = (event) => { if (startY !== null) panel.style.translate = `0 ${Math.max(0, event.clientY - startY)}px`; };
    panel.onpointerup = panel.onpointercancel = (event) => {
      if (startY === null) return;
      const dy = event.clientY - startY;
      startY = null;
      panel.style.translate = '';
      if (dy > 80) hideInfo();
    };
  }
  function hideInfo() {
    if (reader) { reader.querySelector('.zoom-actions')?.remove(); readerKey = null; } // painel fixo: a carta fica, as ações (já velhas) saem
    if (!zoom?.classList.contains('show')) return;
    zoom.classList.remove('show', 'preview');
    zoom.setAttribute('aria-hidden', 'true');
    zoom.innerHTML = '';
    if (previewKey) { previewKey = null; return; }
    if (zoomReturn?.isConnected) zoomReturn.focus({ preventScroll: true });
    zoomReturn = null;
  }

  /* ---------- Ponteiro: toque, toque duplo, segurar (ler), arrastar ---------- */
  document.addEventListener('pointerdown', (event) => {
    a.beforeDown?.(event);
    clearTimeout(hoverTimer);
    if (previewKey) hideInfo(); // clicar vale pelo que o clique faz, não pela prévia
    if (event.button > 0 || event.target.closest('.card-bar, .zoom, .reader')) return;
    if (aiming) {
      const key = marked;
      const target = targetAt(key, event.target.closest('.drop-ok'));
      stopAim();
      if (target) { event.preventDefault(); a.drop(target); }
      return; // tocar fora só cancela
    }
    const node = event.target.closest('[data-gesture]');
    if (!node) { closeBar(); return; }
    const key = node.dataset.loc;
    if (bar && bar.key !== key) closeBar();
    // Fora da vez de responder (animações, vez do rival) só dá para ler a carta.
    press = { key, node, x: event.clientX, y: event.clientY, moved: false, held: false, ghost: null, idle: !a.live() };
    const pressed = press;
    // Segurar = ler, em qualquer carta (alternar Ataque/virado fica no toque duplo e na barra).
    press.timer = setTimeout(() => { pressed.held = true; closeBar(); showInfo(key); }, HOLD_MS);
  });
  document.addEventListener('pointermove', (event) => {
    if (!press) return;
    if (!press.moved && Math.hypot(event.clientX - press.x, event.clientY - press.y) > DRAG_PX) {
      clearTimeout(press.timer);
      if (press.idle || !a.targets(press.key).length) return;
      closeBar();
      press.moved = true;
      press.ghost = press.node.cloneNode(true);
      press.ghost.className = `drag-ghost card${press.node.classList.contains('set-pose') ? ' set' : ''}`;
      // Do tamanho da carta tocada e centrado no dedo (sem isso herda a largura da página).
      Object.assign(press.ghost.style, { width: `${press.node.getBoundingClientRect().width}px`, translate: '-50% -50%' });
      document.body.append(press.ghost);
      press.node.classList.add('lifting');
      mark(press.key);
      setHint(a.dragHint?.(press.key) || 'Solte numa zona acesa.');
    }
    if (press.moved) {
      Object.assign(press.ghost.style, { left: `${event.clientX}px`, top: `${event.clientY}px` });
      document.querySelectorAll('.drop-hover').forEach((n) => n.classList.remove('drop-hover'));
      document.elementFromPoint(event.clientX, event.clientY)?.closest('.drop-ok')?.classList.add('drop-hover');
    }
  });
  const endDrag = () => { press.ghost?.remove(); press.node.classList.remove('lifting'); mark(null); setHint(null); };
  document.addEventListener('pointerup', (event) => {
    if (!press) return;
    clearTimeout(press.timer);
    const { key, moved, held } = press;
    if (moved) {
      const target = targetAt(key, document.elementFromPoint(event.clientX, event.clientY)?.closest('.drop-ok'));
      endDrag();
      press = null;
      if (target) a.drop(target);
      return;
    }
    press = null;
    if (held) { quietUntil = performance.now() + 400; return; }
    const now = performance.now();
    if (a.live() && lastTap.key === key && now - lastTap.at < DOUBLE_TAP_MS) { lastTap = { key: null, at: 0 }; closeBar(); a.doubleTap(key); return; }
    lastTap = { key, at: now };
    if (bar?.key === key) { closeBar(); return; } // tocar de novo fecha
    openBar(key);
  });
  document.addEventListener('pointercancel', () => { if (!press) return; clearTimeout(press.timer); if (press.moved) endDrag(); press = null; });
  // Clique direito numa carta = ler. No toque longo o navegador também manda contextmenu: só bloqueia o menu (o segurar já lê).
  document.addEventListener('contextmenu', (event) => {
    const node = event.target.closest('[data-gesture]');
    if (!node) return;
    event.preventDefault();
    if (!press) showInfo(node.dataset.loc);
  });
  // PC: passar o mouse numa carta mostra a leitura como prévia; sair dela fecha.
  const hover = globalThis.matchMedia?.('(hover: hover) and (pointer: fine)');
  let hoverTimer = null;
  document.addEventListener('pointerover', (event) => {
    if (event.pointerType !== 'mouse' || !hover?.matches) return;
    const node = event.target.closest('[data-gesture]');
    if (!node || previewKey === node.dataset.loc) return;
    clearTimeout(hoverTimer);
    hoverTimer = setTimeout(() => { if (!press && !bar && !aiming && !reading() && node.isConnected) showInfo(node.dataset.loc, { preview: true }); }, 250);
  });
  document.addEventListener('pointerout', (event) => {
    if (event.pointerType !== 'mouse') return;
    const node = event.target.closest('[data-gesture]');
    if (!node || node.contains(event.relatedTarget)) return;
    clearTimeout(hoverTimer);
    if (previewKey) hideInfo();
  });
  addEventListener('resize', () => closeBar());

  /* ---------- Teclado ---------- */
  // Enter/Espaço numa carta (clique sem ponteiro) abre a barra com foco; sem ações, a leitura.
  document.addEventListener('click', (event) => {
    if (event.detail !== 0) return;
    const node = event.target.closest('[data-gesture]');
    if (node) openBar(node.dataset.loc, true);
  });
  document.addEventListener('keydown', (event) => {
    if (reading()) {
      if (event.key === 'Escape') { event.preventDefault(); hideInfo(); return; }
      if (event.key === 'Tab') { // foco preso na leitura
        const items = [...zoom.querySelectorAll('button')];
        const at = items.indexOf(document.activeElement);
        event.preventDefault();
        items[(at + (event.shiftKey ? -1 : 1) + items.length) % items.length]?.focus();
      }
      return;
    }
    if (event.key === 'Escape' && (bar || aiming)) { event.preventDefault(); stopAim(); closeBar(true); return; }
    if (bar?.el.contains(event.target) && /^Arrow/.test(event.key)) {
      const items = [...bar.el.querySelectorAll('button')];
      const step = event.key === 'ArrowLeft' || event.key === 'ArrowUp' ? -1 : 1;
      event.preventDefault();
      items[(items.indexOf(event.target) + step + items.length) % items.length].focus();
      return;
    }
    const node = event.target.closest?.('[data-gesture]');
    if (node && event.key.toLowerCase() === 'd') { closeBar(); a.doubleTap(node.dataset.loc); } // D: o mesmo que tocar duas vezes
  });

  return {
    /** Reacende os alvos depois de redesenhar. */
    mark: () => mark(),
    /** Depois de responder ao motor: fecha barra, mira e leitura. */
    reset() { closeBar(); aiming = false; savedHint = null; hint?.classList.remove('live'); mark(null); hideInfo(); tipActed?.(); },
    info: showInfo,
    hideInfo,
    isOpen: reading,
  };
}

/**
 * Confirmação própria (um <dialog> à parte, empilhado por cima): não toca no #ask, então uma pergunta do motor aberta
 * volta intacta ao cancelar. Devolve true se o jogador confirmou.
 */
export function confirmSurrender() {
  return new Promise((resolve) => {
    const dialog = document.createElement('dialog');
    dialog.className = 'prompt plate ask';
    dialog.innerHTML = '<p class="prompt-kicker">Desistir da partida?</p><div class="result-actions"><button class="btn" type="button" data-yes>Desistir</button><button class="btn ghost" type="button" data-no>Cancelar</button></div>';
    const done = (value) => { dialog.close(); dialog.remove(); resolve(value); };
    dialog.onclick = (event) => { if (event.target.closest('[data-yes]')) done(true); else if (event.target.closest('[data-no]')) done(false); };
    dialog.oncancel = (event) => { event.preventDefault(); done(false); };
    document.body.append(dialog);
    dialog.showModal();
    dialog.querySelector('[data-no]').focus(); // desistir exige escolha ativa
  });
}

/**
 * Menu de opções da partida (botão "⋯" do topo e, com uma pergunta do motor aberta, o cantinho do diálogo):
 * "Como jogar" (se onHelp), "Desistir da partida" (se onSurrender; pede confirmação) e "Voltar ao duelo".
 * Também é um <dialog> à parte, então a pergunta aberta volta intacta.
 */
export function openDuelMenu({ onHelp, onSurrender, onSpeed }) {
  const dialog = document.createElement('dialog');
  dialog.className = 'prompt plate ask duel-menu';
  dialog.setAttribute('aria-label', 'Opções da partida');
  dialog.innerHTML = `<p class="prompt-kicker">Opções da partida</p><div class="result-actions">${onSpeed ? `<button class="btn ghost" type="button" data-speed>Velocidade das animações: ${onSpeed()}x</button>` : ''}${onHelp ? '<button class="btn ghost" type="button" data-help>Como jogar</button>' : ''}${onSurrender ? '<button class="btn ghost" type="button" data-surrender>Desistir da partida</button>' : ''}<button class="btn" type="button" data-back>Voltar ao duelo</button></div>`;
  const close = () => { dialog.close(); dialog.remove(); };
  dialog.onclick = async (event) => {
    if (event.target === dialog || event.target.closest('[data-back]')) close();
    else if (event.target.closest('[data-speed]')) event.target.closest('[data-speed]').textContent = `Velocidade das animações: ${onSpeed(true)}x`;
    else if (event.target.closest('[data-help]')) { close(); onHelp(); } else if (event.target.closest('[data-surrender]')) { close(); if (await confirmSurrender()) onSurrender(); }
  };
  dialog.oncancel = (event) => { event.preventDefault(); close(); };
  document.body.append(dialog);
  dialog.showModal();
  dialog.querySelector('[data-back]').focus();
}

/** Cantinho discreto "⋯" no diálogo de pergunta aberto: o topo e o Deck ficam inertes atrás do modal. */
export function addMenuCorner(dialog, onSurrender) {
  dialog.querySelector('.ask-menu')?.remove();
  if (!onSurrender) return; // sem o que oferecer (puzzle, replay, duelo encerrado)
  const button = document.createElement('button');
  button.type = 'button';
  button.className = 'ask-menu';
  button.setAttribute('aria-label', 'Opções da partida');
  button.textContent = '⋯';
  button.onclick = () => openDuelMenu({ onSurrender });
  dialog.prepend(button);
}

/* ---------- Glossário: termos da leitura abrem a definição de "Palavras do jogo" ---------- */

// [termo do glossário (<dt>), forma no texto da carta]. Só vira botão o que existe no glossário da página.
const TERMS = [
  ['Requisito', /\[REQUISITO\]|REQUISITO|Requisitos?/u], ['Tributo', /[Tt]ributos?|[Tt]ributad[ao]s?/u], ['Corrente', /Corrente/u],
  ['Baixar', /[Bb]aixar|[Bb]aixad[ao]s?/u], ['Deck Adicional', /Deck Adicional|Adicional/u], ['Lenda', /LENDA|Lenda/u],
  ['Máximo', /Invocação-Máximo|ATK MÁXIMO|MÁXIMO|Máximo/u], ['ATK / DEF', /ATK|DEF/u], ['Cemitério', /Cemitério/u],
  ['Invocação-Normal', /Invocaç(?:ão|ões)-Normal/u], ['Ataque direto', /[Aa]taque direto|diretamente/u], ['PV', /PV/u],
];
const TERM_RE = new RegExp(`(?<![\\p{L}\\p{N}])(?:${TERMS.map(([, re]) => re.source).join('|')})(?![\\p{L}\\p{N}])`, 'gu');
const glossary = () => new Map([...document.querySelectorAll('.glossary dt')].map((dt) => [dt.textContent.trim(), dt.nextElementSibling?.textContent.trim() || '']));
/** HTML (já escapado) -> o mesmo, com a 1ª ocorrência de cada termo como botão. Não mexe dentro das tags. */
function linkTerms(html) {
  const defs = glossary();
  const done = new Set();
  return html.split(/(<[^>]+>)/).map((part) => (part.startsWith('<') ? part : part.replace(TERM_RE, (match) => {
    const term = TERMS.find(([, re]) => new RegExp(`^(?:${re.source})$`, 'u').test(match))?.[0];
    if (!term || !defs.has(term) || done.has(term)) return match;
    done.add(term);
    return `<button type="button" class="term" data-term="${escape(term)}" aria-label="${escape(`${match}: o que é?`)}">${match}</button>`;
  }))).join('');
}
/** Mostra a definição embaixo do texto da carta (uma por vez; tocar no mesmo termo fecha). */
function showTerm(button) {
  const copy = button.closest('.zoom-copy');
  const open = copy.querySelector('.zoom-def');
  const same = open?.dataset.term === button.dataset.term;
  open?.remove();
  copy.querySelectorAll('.term[aria-expanded]').forEach((node) => node.removeAttribute('aria-expanded'));
  if (same) return;
  const def = document.createElement('p');
  def.className = 'zoom-def';
  def.setAttribute('role', 'note');
  def.dataset.term = button.dataset.term;
  def.innerHTML = `<b>${escape(button.dataset.term)}</b> ${escape(glossary().get(button.dataset.term) || '')}`;
  (copy.querySelector('.zoom-text') || button.parentElement).after(def);
  button.setAttribute('aria-expanded', 'true');
}

/* ---------- Dicas de primeira vez (as duas arenas) ---------- */

let tipActed = null; // avança a dica aberta quando o jogador age (reset() das arenas, depois de cada resposta ao motor)
/**
 * Passo a passo curto: steps = [[texto, seletor do elemento citado]]. A dica fica presa acima da mão (no celular, acima
 * dos botões do turno), sem cobrir as fileiras do tapete; o elemento citado ganha contorno pulsante (.tip-target).
 * Avança sozinha quando o jogador age (joga uma carta, muda de fase) e some depois da última; "Pular" fecha tudo.
 */
export function runTips(steps) {
  const tip = document.querySelector('#tip');
  if (!tip) return;
  let step = 0;
  let shownAt = 0;
  const place = () => {
    if (tip.hidden) return;
    const hand = document.querySelector('#hand').getBoundingClientRect();
    if (matchMedia('(max-width: 860px)').matches) {
      const buttons = document.querySelector('.dock')?.getBoundingClientRect();
      const above = buttons?.height ? Math.min(buttons.top, hand.top) : hand.top;
      Object.assign(tip.style, { top: '', bottom: `${innerHeight - above + 6}px`, left: '50%' });
    } else {
      // PC: na coluna dos botões (à direita da mão), logo acima deles: não cobre o tapete nem a mão.
      const dock = document.querySelector('.dock').getBoundingClientRect();
      const top = Math.min(...[...document.querySelectorAll('.dock > :not(.tip)')].filter((n) => n.offsetHeight).map((n) => n.getBoundingClientRect().top), hand.top);
      Object.assign(tip.style, { top: '', bottom: `${innerHeight - top + 8}px`, left: `${dock.left + dock.width / 2}px` });
    }
  };
  const show = () => {
    document.querySelectorAll('.tip-target').forEach((node) => node.classList.remove('tip-target'));
    if (step >= steps.length) { tip.hidden = true; tipActed = null; removeEventListener('resize', place); return; }
    tip.hidden = false;
    shownAt = performance.now();
    tip.querySelector('#tip-text').textContent = `${step + 1}/${steps.length}  ${steps[step][0]}`;
    tip.querySelector('#tip-next').textContent = step === steps.length - 1 ? 'Entendi' : 'Próxima';
    document.querySelector(steps[step][1])?.classList.add('tip-target');
    place();
  };
  tip.querySelector('#tip-next').addEventListener('click', () => { step += 1; show(); });
  tip.querySelector('#tip-skip').addEventListener('click', () => { step = steps.length; show(); });
  // Uma jogada pode responder ao motor várias vezes seguidas (invocar + posição): conta uma só.
  tipActed = () => { if (performance.now() - shownAt > 1200) { step += 1; show(); } };
  addEventListener('resize', place);
  show();
}

/* ---------- Desistir: segurar o próprio Deck ---------- */

export const SURRENDER_MS = 1200;
/**
 * Segurar o seu Main Deck (data-pile="0:deck") enche um anel; ao completar chama onHold().
 * Soltar, sair do deck ou o navegador assumir (rolagem/zoom) cancela. O toque simples segue sendo do deck (a página o trata).
 * enabled(): só inicia quando devolve true.
 */
export function bindSurrender({ enabled, onHold }) {
  const sel = '[data-pile="0:deck"]';
  let hold = null;
  let doneAt = -1e9;
  const stop = () => { if (hold) { clearTimeout(hold.timer); hold.ring.remove(); hold = null; } };
  document.addEventListener('pointerdown', (event) => {
    const pile = event.target.closest(sel);
    if (!pile || !enabled() || (event.pointerType === 'mouse' && event.button !== 0)) return;
    stop();
    const rect = pile.getBoundingClientRect();
    const size = Math.max(44, Math.min(rect.width, rect.height));
    const ring = document.createElement('div');
    ring.className = 'surrender-ring';
    ring.setAttribute('aria-hidden', 'true');
    ring.style.cssText = `left:${rect.left + rect.width / 2}px;top:${rect.top + rect.height / 2}px;width:${size}px;height:${size}px;--hold:${SURRENDER_MS}ms`;
    ring.innerHTML = '<svg viewBox="0 0 36 36"><circle cx="18" cy="18" r="16" pathLength="100"/></svg>';
    (pile.closest('dialog[open]') || document.body).append(ring); // dentro do diálogo modal, senão ele cobre o anel
    hold = { rect, ring, timer: setTimeout(() => { stop(); doneAt = performance.now(); onHold(); }, SURRENDER_MS) };
  });
  document.addEventListener('pointermove', (event) => {
    if (!hold) return;
    const { left, right, top, bottom } = hold.rect;
    if (event.clientX < left - 6 || event.clientX > right + 6 || event.clientY < top - 6 || event.clientY > bottom + 6) stop();
  });
  for (const type of ['pointerup', 'pointercancel']) document.addEventListener(type, stop);
  // O soltar depois do anel cheio não deve contar como toque no deck, nem abrir o menu de contexto do toque longo.
  document.addEventListener('click', (event) => {
    if (performance.now() - doneAt < 600 && event.target.closest(sel)) { event.stopImmediatePropagation(); event.preventDefault(); }
  }, true);
  document.addEventListener('contextmenu', (event) => { if (event.target.closest(sel)) event.preventDefault(); });
}
