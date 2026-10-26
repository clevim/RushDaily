/* Interação com as cartas, comum às arenas Rush (duel.js) e Clássica (arena.js).
 * Sem efeitos ao importar: cada arena chama bindCardGestures() com os seus ganchos.
 *
 * Modelo: tocar numa carta sua com ações abre a barra de ações ao lado dela (sem espera);
 * nas outras, abre a leitura. Tocar duas vezes = atalho (mudar posição / alternar jogar-baixar),
 * segurar = baixar/virar, arrastar = jogar na zona acesa (ou atacar o alvo aceso).
 * "Atacar" na barra acende os alvos: tocar num deles ataca, tocar fora cancela.
 * As respostas ao motor saem sempre das ações que o motor ofereceu (actions/targets da arena). */
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
  if (item.action === 3) return 'Defesa'; // monstro baixado: virado em defesa
  if (item.action === 4) return 'Baixar';
  if (item.action === 'attack') return 'Atacar';
  if (item.action === 2) return /^Mudar para /.test(item.label) ? item.label.slice(11) : /Virad|Virar/.test(item.label) ? 'Virar' : 'Posição';
  return 'Ativar';
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
 *  ({ html, name, stats, text, hidden }) ou null; paint(el); doubleTap(key); hold(key); dragHint?(key); beforeDown?(event)
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
  const cardNode = (key) => document.querySelector(`[data-gesture][data-loc="${key}"]`);

  function setHint(text) {
    if (!hint) return;
    if (text) { savedHint ??= hint.textContent; hint.textContent = text; } else if (savedHint !== null) { hint.textContent = savedHint; savedHint = null; }
  }
  function mark(key = marked) {
    marked = key;
    document.querySelectorAll('.drop-ok, .drop-hover').forEach((node) => node.classList.remove('drop-ok', 'drop-hover'));
    if (key) for (const target of a.targets(key)) document.querySelector(target.node)?.classList.add('drop-ok');
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
      setHint(`Toque no alvo aceso${direct ? ' (ou no rival para ataque direto)' : ''}. Toque fora para cancelar.`);
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
  function showInfo(key, { focus = false } = {}) {
    const info = a.describe(key);
    if (!info || !zoom) return;
    closeBar();
    const actions = info.hidden || !a.live() ? [] : a.actions(key);
    const { meta, power } = splitStats(info.stats);
    zoom.innerHTML = `<div class="zoom-panel" role="dialog" aria-modal="true" aria-labelledby="zoom-name" tabindex="-1">
      <span class="zoom-grab" aria-hidden="true"></span>
      <div class="zoom-art"><div class="card">${info.html}</div></div>
      <div class="zoom-copy">
        <h2 id="zoom-name">${escape(info.hidden ? 'Carta virada' : info.name)}</h2>
        ${info.hidden ? '<p class="zoom-text">Você ainda não sabe qual é.</p>' : `${meta ? `<p class="zoom-meta">${escape(meta)}</p>` : ''}${power ? `<p class="zoom-power">${escape(power)}</p>` : ''}<p class="zoom-text">${escape(info.text || '')}</p>`}
      </div>
      <div class="zoom-actions">${actions.map((item, index) => `<button class="zoom-act ${index ? '' : 'primary'}" type="button" data-act="${index}">${icon(kindOf(item))}<span>${escape(item.label)}</span></button>`).join('')}<button class="zoom-act" type="button" data-close>Fechar</button></div>
    </div>`;
    zoom.classList.add('show');
    zoom.setAttribute('aria-hidden', 'false');
    a.paint?.(zoom);
    zoomReturn = document.activeElement;
    const panel = zoom.querySelector('.zoom-panel');
    (focus ? panel.querySelector('button') : panel).focus({ preventScroll: true });
    const openedAt = performance.now();
    zoom.onclick = (event) => {
      if (performance.now() - openedAt < 350 && event.detail !== 0) return; // o clique sintético do próprio toque que abriu
      const button = event.target.closest('button');
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
    if (!zoom?.classList.contains('show')) return;
    zoom.classList.remove('show');
    zoom.setAttribute('aria-hidden', 'true');
    zoom.innerHTML = '';
    if (zoomReturn?.isConnected) zoomReturn.focus({ preventScroll: true });
    zoomReturn = null;
  }

  /* ---------- Ponteiro: toque, toque duplo, segurar, arrastar ---------- */
  document.addEventListener('pointerdown', (event) => {
    a.beforeDown?.(event);
    if (event.button > 0 || event.target.closest('.card-bar, .zoom')) return;
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
    // Segurar troca a pose e redesenha a mão: se o dedo seguir arrastando, o fantasma sai da carta nova.
    if (!press.idle) press.timer = setTimeout(() => { pressed.held = true; closeBar(); a.hold(key); pressed.node = document.querySelector(`.hand-card[data-loc="${key}"]`) || pressed.node; }, HOLD_MS);
  });
  document.addEventListener('pointermove', (event) => {
    if (!press || press.idle) return;
    if (!press.moved && Math.hypot(event.clientX - press.x, event.clientY - press.y) > DRAG_PX) {
      if (!a.targets(press.key).length) return;
      clearTimeout(press.timer);
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
    if (held) return;
    const now = performance.now();
    if (a.live() && lastTap.key === key && now - lastTap.at < DOUBLE_TAP_MS) { lastTap = { key: null, at: 0 }; closeBar(); a.doubleTap(key); return; }
    lastTap = { key, at: now };
    if (bar?.key === key) { closeBar(); return; } // tocar de novo fecha
    openBar(key);
  });
  document.addEventListener('pointercancel', () => { if (!press) return; clearTimeout(press.timer); if (press.moved) endDrag(); press = null; });
  // Segurar no celular não deve abrir o menu do navegador sobre as cartas.
  document.addEventListener('contextmenu', (event) => { if (event.target.closest('[data-gesture]')) event.preventDefault(); });
  addEventListener('resize', () => closeBar());

  /* ---------- Teclado ---------- */
  // Enter/Espaço numa carta (clique sem ponteiro) abre a barra com foco; sem ações, a leitura.
  document.addEventListener('click', (event) => {
    if (event.detail !== 0) return;
    const node = event.target.closest('[data-gesture]');
    if (node) openBar(node.dataset.loc, true);
  });
  document.addEventListener('keydown', (event) => {
    if (zoom?.classList.contains('show')) {
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
    reset() { closeBar(); aiming = false; savedHint = null; mark(null); hideInfo(); },
    info: showInfo,
    hideInfo,
    isOpen: () => Boolean(zoom?.classList.contains('show')),
  };
}
