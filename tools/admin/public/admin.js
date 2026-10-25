// RushDaily Admin (navegador). Tudo que vem da API entra por textContent/atributos: nada vira HTML.
const $ = (id) => document.getElementById(id);
const url = new URL(location.href);
let token = url.searchParams.get('t');
try { if (token) sessionStorage.setItem('t', token); else token = sessionStorage.getItem('t'); } catch { /* sem storage */ }
if (url.searchParams.has('t')) history.replaceState(null, '', location.pathname + location.hash); // tira o token da barra de endereço
const H = { 'x-admin-token': token || '', 'content-type': 'application/json' };
const api = async (rota, metodo = 'GET', corpo) => {
  const r = await fetch('/api/' + rota, { method: metodo, headers: H, body: corpo ? JSON.stringify(corpo) : undefined });
  const j = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(r.status === 401 ? 'Token inválido: abra de novo a URL com ?t=…' : j.erro || r.statusText);
  return j;
};

// ---- utilidades ----
const el = (tag, props = {}, ...filhos) => {
  const e = document.createElement(tag);
  for (const [k, v] of Object.entries(props)) {
    if (v === undefined || v === null || v === false) continue;
    if (k.startsWith('aria-') || k.startsWith('data-') || k === 'role' || k === 'for') e.setAttribute(k, v === true ? '' : v);
    else e[k] = v;
  }
  e.append(...filhos.flat().filter((f) => f !== null && f !== undefined && f !== false));
  return e;
};
const fmtB = (b) => b >= 1e9 ? (b / 1e9).toFixed(2) + ' GB' : b >= 1e6 ? (b / 1e6).toFixed(1) + ' MB' : b >= 1e3 ? (b / 1e3).toFixed(0) + ' KB' : (b || 0) + ' B';
const fmtD = (ms) => { const s = Math.round(ms / 1000); return s >= 3600 ? `${Math.floor(s / 3600)}h${String(Math.floor(s % 3600 / 60)).padStart(2, '0')}` : s >= 60 ? `${Math.floor(s / 60)}min${String(s % 60).padStart(2, '0')}s` : s + 's'; };
const fmtT = (t) => t ? new Date(t).toLocaleString('pt-BR', { dateStyle: 'short', timeStyle: 'short' }) : 'nunca';
const fmtN = (n) => Number(n || 0).toLocaleString('pt-BR');
const pct = (n, m) => (m > 0 ? Math.min(100, Math.round(n / m * 100)) : 0);
const hojeLocal = () => { const d = new Date(); return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`; };
const barraEl = (n, m, ok) => { const b = el('div', { className: 'barra' + (ok ? ' ok' : ''), role: 'progressbar', 'aria-valuemin': 0, 'aria-valuemax': 100, 'aria-valuenow': pct(n, m) }, el('i')); b.firstChild.style.width = pct(n, m) + '%'; return b; };
const chip = (classe, texto) => el('span', { className: 'chip ' + classe }, texto);
let msgT;
const aviso = (t, erro = false) => { $('msg').textContent = t; $('msg').className = erro ? 'erro' : ''; $('msg').hidden = false; clearTimeout(msgT); msgT = setTimeout(() => { $('msg').hidden = true; }, 6000); };
const falha = (e) => aviso(e.message, true);
const confirmar = (txt) => new Promise((ok) => { $('dlgTxt').textContent = txt; $('dlg').onclose = () => ok($('dlg').returnValue === 'sim'); $('dlg').returnValue = ''; $('dlg').showModal(); });

// ---- navegação ----
const SECOES = ['visao', 'dados', 'tarefas', 'cartas', 'desafio', 'jogadores', 'historico', 'config'];
const aoMostrar = {};
let secao = null, pronto = false;
function mostra(s, foco = true) {
  if (!SECOES.includes(s)) s = 'visao';
  secao = s;
  for (const id of SECOES) $('s-' + id).hidden = id !== s;
  for (const a of document.querySelectorAll('#nav a')) { if (a.dataset.s === s) a.setAttribute('aria-current', 'page'); else a.removeAttribute('aria-current'); }
  document.querySelector(`#nav a[data-s="${s}"]`)?.scrollIntoView({ block: 'nearest', inline: 'nearest' });
  if (foco) $('h-' + { visao: 'visao', dados: 'dados', tarefas: 'tarefas', cartas: 'cartas', desafio: 'desafio', jogadores: 'jog', historico: 'hist', config: 'cfg' }[s]).focus({ preventScroll: true });
  window.scrollTo(0, 0);
  if (pronto) aoMostrar[s]?.();
}
const ir = (s) => { if (location.hash === '#' + s) mostra(s); else location.hash = s; };
addEventListener('hashchange', () => mostra(location.hash.slice(1)));

// ---- visualizador de log (ao vivo nas Tarefas, estático no Histórico) ----
const RE_ERRO = /(\berro\b|\berros?:|error|exception|traceback|\bfalh(ou|a)\b|failed|fatal|^not ok\b|# fail [1-9]|RECUSADO)/i;
const RE_AVISO = /(\baviso\b|\bwarn(ing)?\b|atenção|deprecat)/i;
const tipoLinha = (l) => (RE_ERRO.test(l) && !/erros de script: nenhum|\b0 erros?\b/i.test(l) ? 'e' : RE_AVISO.test(l) ? 'w' : /^\s*\$ /.test(l) ? 'c' : '');
class LogView {
  constructor(raiz, { vivo = false, nome = 'log' } = {}) {
    this.linhas = []; this.vivo = vivo; this.nome = nome; this.pausado = false;
    this.filtro = el('input', { type: 'search', placeholder: 'Filtrar o log', autocomplete: 'off', 'aria-label': 'Filtrar o log' });
    this.soAlertas = el('input', { type: 'checkbox' });
    this.pausa = el('button', { className: 'btn sec pequeno', type: 'button', 'aria-pressed': 'false' }, 'Pausar rolagem');
    this.caixa = el('div', { className: 'log', tabIndex: 0, role: 'log', 'aria-label': 'Saída da tarefa' });
    this.rodape = el('p', { className: 'log-rodape' });
    const copiar = el('button', { className: 'btn sec pequeno', type: 'button' }, 'Copiar');
    const baixar = el('button', { className: 'btn sec pequeno', type: 'button' }, 'Baixar');
    raiz.replaceChildren(el('div', { className: 'log-barra' }, this.filtro, el('label', { className: 'chk' }, this.soAlertas, 'só erros e avisos'), vivo ? this.pausa : null, copiar, baixar), this.caixa, this.rodape);
    let t;
    this.filtro.oninput = () => { clearTimeout(t); t = setTimeout(() => this.render(), 150); };
    this.soAlertas.onchange = () => this.render();
    this.pausa.onclick = () => { this.pausado = !this.pausado; this.pausa.setAttribute('aria-pressed', String(this.pausado)); this.pausa.textContent = this.pausado ? 'Retomar rolagem' : 'Pausar rolagem'; if (!this.pausado) this.fim(); };
    copiar.onclick = async () => { try { await navigator.clipboard.writeText(this.visiveis().join('\n')); aviso('Log copiado.'); } catch { aviso('Não consegui copiar (permissão do navegador).', true); } };
    baixar.onclick = () => {
      const a = el('a', { href: URL.createObjectURL(new Blob([this.linhas.join('\n') + '\n'], { type: 'text/plain' })), download: `${this.nome}.log` });
      document.body.append(a); a.click(); a.remove(); setTimeout(() => URL.revokeObjectURL(a.href), 2000);
    };
  }
  passa(l) { const f = this.filtro.value.trim().toLowerCase(); return (!f || l.toLowerCase().includes(f)) && (!this.soAlertas.checked || ['e', 'w'].includes(tipoLinha(l))); }
  visiveis() { return this.linhas.filter((l) => this.passa(l)); }
  linhaEl(l) {
    const d = el('div', { className: tipoLinha(l) });
    const f = this.filtro.value.trim();
    if (!f) { d.textContent = l; return d; }
    const i = l.toLowerCase().indexOf(f.toLowerCase());
    d.append(l.slice(0, i), el('mark', {}, l.slice(i, i + f.length)), l.slice(i + f.length));
    return d;
  }
  render() { this.caixa.replaceChildren(...this.visiveis().slice(-3000).map((l) => this.linhaEl(l))); this.conta(); this.fim(true); }
  conta() { const v = this.filtro.value || this.soAlertas.checked ? `${this.visiveis().length} de ` : ''; const e = this.linhas.filter((l) => tipoLinha(l) === 'e').length; this.rodape.textContent = `${v}${fmtN(this.linhas.length)} linhas${e ? ` · ${e} com erro` : ''}`; }
  set(linhas, nome) { this.linhas = [...linhas]; if (nome) this.nome = nome; this.render(); }
  add(novas) {
    const perto = this.caixa.scrollTop + this.caixa.clientHeight >= this.caixa.scrollHeight - 40;
    this.linhas.push(...novas); if (this.linhas.length > 6000) this.linhas.splice(0, 2000);
    const f = document.createDocumentFragment();
    for (const l of novas) if (this.passa(l)) f.append(this.linhaEl(l));
    this.caixa.append(f);
    while (this.caixa.childElementCount > 3000) this.caixa.firstChild.remove();
    this.conta();
    if (perto) this.fim();
  }
  fim(forcar = false) { if (!this.pausado || forcar) this.caixa.scrollTop = this.caixa.scrollHeight; }
}
const logVivo = new LogView($('logVivo'), { vivo: true, nome: 'tarefa' });
const logHist = new LogView($('logHist'), { nome: 'historico' });

// ---- resumo de testes e simulações ----
function resumoEl(r, h) {
  if (!r) return null;
  const ok = h ? h.codigo === 0 && !h.cancelada : true;
  if (r.tipo === 'testes') {
    return el('div', { className: 'resumo' }, el('h3', {}, 'Resumo dos testes', chip(r.falhas ? 'erro' : 'ok', r.falhas ? `${r.falhas} falha(s)` : 'tudo passou')),
      el('p', {}, `${fmtN(r.testes)} testes · ${fmtN(r.ok)} ok · ${fmtN(r.falhas)} falhas${r.ignorados ? ` · ${r.ignorados} ignorados` : ''}`),
      r.falhando?.length ? el('p', {}, 'Falhando: ' + r.falhando.join(' · ')) : null);
  }
  if (r.tipo === 'simulacao') {
    return el('div', { className: 'resumo' },
      el('h3', {}, 'Resumo da simulação', chip(r.errosScript ? 'erro' : 'ok', r.errosScript ? 'erros de script' : 'sem erros de script'), r.grupos.some((g) => g.travados) ? chip('erro', 'travamentos') : null, ok ? null : chip('erro', 'saiu com erro')),
      el('div', { className: 'tabela' }, el('table', {}, el('thead', {}, el('tr', {}, el('th', {}, 'Grupo'), el('th', { className: 'num' }, 'Duelos'), el('th', { className: 'num' }, 'Turnos (mediana / p90)'), el('th', {}, 'Resultado'), el('th', { className: 'num' }, 'Travados'))),
        el('tbody', {}, r.grupos.map((g) => el('tr', {}, el('td', {}, g.nome), el('td', { className: 'num' }, g.duelos ? fmtN(g.duelos) : '—'), el('td', { className: 'num' }, `${g.mediana ?? '—'} / ${g.p90 ?? '—'}`), el('td', {}, g.resultado || '—'), el('td', { className: 'num' }, String(g.travados))))))),
      r.geral ? el('p', {}, r.geral) : null, r.alertas?.length ? el('p', {}, 'Atenção: ' + r.alertas.join(', ') + ' (veja o log).') : null);
  }
  return null;
}

// ---- estado global ----
let meta = null, etapas = [], ultimoStatus = null, jogResumoCache = null, histAtual = [];
let atual = null, filaAtual = [], ultimoId = null;
const TITULO = 'RushDaily Admin';
let tituloFim = '';

// ---- topo: tarefa em andamento (em qualquer seção) ----
function pintaTopo() {
  const p = atual?.progresso;
  $('tarefaTopo').classList.toggle('ativa', !!atual);
  $('ttTitulo').textContent = atual ? atual.titulo : filaAtual.length ? 'Na fila' : 'Nada em execução';
  $('ttSub').textContent = atual ? (p ? `${p.n}/${p.m} (${pct(p.n, p.m)}%)` : `desde ${fmtT(atual.inicio)}`) + (filaAtual.length ? ` · ${filaAtual.length} na fila` : '') : '';
  const b = $('ttBarra');
  b.hidden = !atual; b.classList.toggle('indet', !p);
  b.firstElementChild.style.width = (p ? pct(p.n, p.m) : 0) + '%';
  if (p) b.setAttribute('aria-valuenow', pct(p.n, p.m)); else b.removeAttribute('aria-valuenow');
  $('ttCancelar').hidden = !atual;
  document.title = atual ? `${p ? pct(p.n, p.m) + '% · ' : ''}${atual.titulo} · ${TITULO}` : tituloFim || TITULO;
}
$('ttCancelar').onclick = async () => {
  if (atual && await confirmar(`Cancelar "${atual.titulo}"? O processo e os filhos serão encerrados.`)) try { await api('cancelar', 'POST', { id: atual.id }); } catch (e) { falha(e); }
};
document.addEventListener('visibilitychange', () => { if (!document.hidden && tituloFim) { tituloFim = ''; pintaTopo(); } });

function pintaEstado(s) {
  if (s.atual && s.atual.id !== ultimoId) { ultimoId = s.atual.id; logVivo.set([], `${s.atual.tarefa}-${s.atual.id}`); $('resumoAtual').replaceChildren(); }
  atual = s.atual; filaAtual = s.fila; histAtual = s.historico;
  pintaTopo();
  $('logTitulo').textContent = atual ? '· ao vivo: ' + atual.linha : ultimoId ? '· última tarefa desta sessão' : '';
  $('fila').replaceChildren(...filaAtual.map((j) => el('div', {}, el('span', {}, `Na fila: ${j.titulo}`), el('button', { className: 'btn sec pequeno', onclick: () => api('cancelar', 'POST', { id: j.id }).catch(falha) }, 'Remover'))));
  pintaHistorico();
  pintaUltima();
}

// ---- SSE via fetch (EventSource não manda o cabeçalho do token) ----
async function eventos() {
  for (;;) {
    try {
      const r = await fetch('/api/eventos', { headers: H });
      if (!r.ok) throw new Error(String(r.status));
      const rd = r.body.pipeThrough(new TextDecoderStream()).getReader();
      let buf = '';
      for (;;) {
        const { value, done } = await rd.read(); if (done) break;
        buf += value;
        let i;
        while ((i = buf.indexOf('\n\n')) >= 0) {
          const bloco = buf.slice(0, i); buf = buf.slice(i + 2);
          if (!bloco.startsWith('data: ')) continue;
          const ev = JSON.parse(bloco.slice(6));
          if (ev.tipo === 'estado') pintaEstado(ev);
          else if (ev.tipo === 'log') { logVivo.set(ev.linhas); if (atual) { atual.progresso = ev.progresso; pintaTopo(); } }
          else if (ev.tipo === 'linha') { logVivo.add([ev.texto]); if (atual) { atual.progresso = ev.progresso; pintaTopo(); } }
          else if (ev.tipo === 'fim') terminou(ev);
        }
      }
    } catch (e) { if (e.message === '401') { aviso('Token inválido.', true); return; } }
    await new Promise((r) => setTimeout(r, 2000));
  }
}
function terminou(ev) {
  const txt = ev.cancelada ? `Cancelada: ${ev.titulo}` : ev.codigo === 0 ? `Concluída: ${ev.titulo}` : `Erro (${ev.codigo}): ${ev.titulo}`;
  aviso(txt, !ev.cancelada && ev.codigo !== 0);
  $('resumoAtual').replaceChildren(resumoEl(ev.resumo, { codigo: ev.codigo, cancelada: ev.cancelada }) ?? '');
  if (document.hidden) {
    tituloFim = `${txt} · ${TITULO}`;
    try { if ('Notification' in window && Notification.permission === 'granted') new Notification('RushDaily Admin', { body: txt, tag: 'rushdaily-admin' }); } catch { /* sem notificação */ }
  }
  carregaStatus();
}

// ---- status: visão geral e dados/setup ----
async function carregaStatus() {
  try { ultimoStatus = await api('status'); pintaStatus(); } catch (e) { $('etapas').replaceChildren(el('li', { className: 'vazio' }, e.message)); }
}
const disponivel = (t) => meta?.tarefas[t] && !meta.tarefas[t].indisponivel;
const temporadasAtivas = () => Math.max(1, ultimoStatus?.contagens?.temporadas || 1);
const rodaEtapa = (nome, force) => executar('setup-etapa', { etapa: nome, force, temporadas: temporadasAtivas() }, force ? `Refazer a etapa "${nome}" (--force)? Apaga e gera de novo o que ela produz.` : `Rodar a etapa "${nome}" do setup?`);
function pintaStatus() {
  const s = ultimoStatus, c = s.contagens, prontas = s.etapas.filter((e) => e.pronto).length, total = s.etapas.length;
  const kpi = (valor, rotulo, extra, barra) => el('div', { className: 'kpi' }, el('b', {}, ...[valor].flat()), el('span', {}, rotulo), extra ? el('span', {}, extra) : null, barra ?? null);
  const de = (n, m) => [fmtN(n), el('small', {}, ` / ${fmtN(m)}`)];
  const jr = jogResumoCache;
  $('kpis').replaceChildren(
    total ? kpi(de(prontas, total), 'etapas do setup prontas', null, barraEl(prontas, total, prontas === total)) : kpi('—', 'setup não disponível aqui'),
    kpi(fmtN(c.rush), 'cartas Rush', `${fmtN(c.rushPt)} em PT · ${fmtN(c.scriptsRush)} scripts`),
    kpi(de(c.rushArte, c.rush), 'artes Rush', null, barraEl(c.rushArte, c.rush, c.rush && c.rushArte >= c.rush)),
    kpi(de(c.rushCartas, c.rush), 'cartas Rush montadas', `miniaturas ${fmtN(c.rushSm)}`, barraEl(c.rushCartas, c.rush, c.rush && c.rushCartas >= c.rush)),
    kpi(fmtN(c.classicas), 'cartas clássicas', `${c.temporadas} temporada(s) · ${fmtN(c.scriptsClassicos)} scripts`),
    kpi(de(c.classicCartas, c.classicArte), 'clássicas desenhadas', `${fmtN(c.classicArte)} artes`),
    kpi(fmtN(c.puzzles), 'puzzles validados'),
    kpi(fmtB(s.cacheTotal), 'nos caches das ferramentas'),
    jr?.configurado ? kpi(fmtN(jr.ativosHoje), 'jogadores ativos hoje', `${fmtN(jr.ativos7d)} em 7 dias · ${fmtN(jr.totalChaves)} chaves`) : kpi('—', 'jogadores', 'estatísticas não configuradas'),
  );
  // saúde do setup: o que falta
  const faltam = s.etapas.filter((e) => !e.pronto);
  $('saude').replaceChildren(
    total ? el('p', { className: 'sub' }, `${prontas} de ${total} etapas prontas.`) : el('p', { className: 'vazio' }, 'O setup não existe nesta instalação.'),
    faltam.length ? el('ul', { className: 'lista-curta' }, faltam.map((e) => el('li', {}, el('span', {}, chip(e.parcial ? 'parcial' : 'falta', e.parcial ? 'parcial' : 'falta'), ' ', e.nome),
      disponivel('setup-etapa') ? el('button', { className: 'btn sec pequeno', onclick: () => rodaEtapa(e.nome, false) }, 'Rodar') : null))) : total ? el('p', {}, chip('ok', 'tudo pronto')) : null);
  // etapas detalhadas
  $('etapas').replaceChildren(...s.etapas.map((e) => el('li', { className: 'etapa ' + (e.pronto ? 'ok' : e.parcial ? 'parcial' : '') },
    el('div', {}, el('h3', {}, e.nome, chip(e.pronto ? 'ok' : e.parcial ? 'parcial' : 'falta', e.pronto ? 'pronta' : e.parcial ? 'parcial' : 'faltando')), el('p', {}, e.desc), e.contagem ? el('p', { className: 'cont' }, e.contagem) : null),
    el('div', { className: 'lado' }, el('span', {}, `${fmtB(e.bytes)} · ${fmtT(e.geradoEm)}`),
      el('div', { className: 'acoes-linha' }, el('button', { className: 'btn sec pequeno', disabled: !disponivel('setup-etapa'), onclick: () => rodaEtapa(e.nome, false) }, 'Rodar'),
        el('button', { className: 'btn fantasma pequeno', disabled: !disponivel('setup-etapa'), onclick: () => rodaEtapa(e.nome, true) }, 'Refazer'))))));
  if (!s.etapas.length) $('etapas').replaceChildren(el('li', { className: 'vazio' }, 'Sem a lista de etapas (tools/setup/setup.mjs não está aqui).'));
  const maior = Math.max(1, ...s.caches.map((x) => x.bytes));
  $('caches').replaceChildren(el('p', { className: 'sub' }, `Total: ${fmtB(s.cacheTotal)}`), el('div', { className: 'caches' }, s.caches.map((x) => el('div', { className: 'cache-linha' }, el('code', {}, x.nome), el('span', { className: 'num' }, fmtB(x.bytes)), barraEl(x.bytes, maior)))));
  $('setupTudo').disabled = !disponivel('setup');
  pintaIni(s.inicializacao);
  pintaProxima();
}
function pintaIni(ini) {
  $('iniPainel').hidden = !ini;
  if (!ini) return;
  const classe = { rodando: 'parcial', ok: 'ok', erro: 'erro', interrompida: 'erro' }[ini.estado] ?? 'neutro';
  const pre = el('div', { className: 'log' }); pre.style.height = '180px';
  pre.append(...ini.log.slice(-40).map((l) => el('div', { className: tipoLinha(l) }, l)));
  $('ini').replaceChildren(
    el('p', {}, chip(classe, ini.estado), ' ', `Serviço rushdaily-dados · início ${fmtT(ini.inicio)}${ini.fim ? ` · fim ${fmtT(ini.fim)}` : ''}${ini.codigo !== undefined && ini.codigo !== null ? ` · saída ${ini.codigo}` : ''}`),
    ini.args ? el('p', { className: 'desc' }, el('code', {}, ini.args.join(' '))) : null,
    ini.viva ? (ini.progresso ? barraEl(ini.progresso.n, ini.progresso.m) : el('div', { className: 'barra indet' }, el('i'))) : null,
    pre, el('p', { className: 'desc' }, 'Log completo no homelab: docker compose logs -f rushdaily-dados'));
  pre.scrollTop = pre.scrollHeight;
}
function pintaProxima() {
  const s = ultimoStatus; if (!s || !meta) return;
  const caixa = $('proxima');
  const mostra = (titulo, texto, botao) => { caixa.hidden = false; caixa.replaceChildren(el('p', {}, el('strong', {}, titulo), el('span', { className: 'desc' }, texto)), botao ?? ''); };
  const faltam = s.etapas.filter((e) => !e.pronto);
  const ult = histAtual[0];
  if (s.inicializacao?.viva) return mostra('Inicialização dos dados em andamento', 'O serviço rushdaily-dados está gerando os dados no volume. As tarefas ficam bloqueadas até ele terminar.');
  if (atual) return mostra(`Rodando: ${atual.titulo}`, 'Acompanhe o log na seção Tarefas.', el('button', { className: 'btn sec', onclick: () => ir('tarefas') }, 'Ver o log'));
  if (faltam.length > 2 && disponivel('setup')) return mostra(`Faltam ${faltam.length} etapas do setup`, faltam.map((e) => e.nome).join(', '), el('button', { className: 'btn', onclick: () => executar('setup', { temporadas: temporadasAtivas() }, 'Rodar o setup completo? Baixa e gera tudo o que falta (pode levar bastante tempo).') }, 'Rodar o setup completo'));
  if (faltam.length && disponivel('setup-etapa')) return mostra(`Etapa pendente: ${faltam[0].nome}`, faltam[0].desc, el('button', { className: 'btn', onclick: () => rodaEtapa(faltam[0].nome, false) }, `Rodar ${faltam[0].nome}`));
  if (ult && !ult.cancelada && ult.codigo !== 0) return mostra(`A última tarefa terminou com erro: ${ult.titulo}`, `Saída ${ult.codigo ?? ult.sinal} em ${fmtT(ult.inicio)}.`, el('button', { className: 'btn sec', onclick: () => { ir('historico'); verLog(ult.id); } }, 'Ver o log'));
  const teste = histAtual.find((h) => h.tarefa === 'teste');
  if (disponivel('teste') && (!teste || Date.now() - teste.inicio > 7 * 86400000)) return mostra('Tudo pronto. Que tal conferir?', teste ? `Os testes rodaram pela última vez em ${fmtT(teste.inicio)}.` : 'Os testes ainda não rodaram por aqui.', el('button', { className: 'btn sec', onclick: () => executar('teste', {}, 'Rodar os testes (npm test)?') }, 'Rodar os testes'));
  return mostra('Tudo em dia', faltam.length ? 'Há etapas pendentes, mas o setup não está disponível aqui.' : 'Dados prontos e nenhuma pendência.');
}
function pintaUltima() {
  const h = histAtual[0];
  if (!h) { $('ultima').replaceChildren(el('p', { className: 'vazio' }, 'Nenhuma execução ainda.')); return; }
  $('ultima').replaceChildren(el('p', {}, resultadoChip(h), ' ', el('b', {}, h.titulo)), el('p', { className: 'desc' }, `${fmtT(h.inicio)} · ${fmtD(h.duracaoMs)}`), el('p', { className: 'desc' }, el('code', {}, h.linha)),
    resumoEl(h.resumo, h) ?? '', el('button', { className: 'btn sec pequeno', onclick: () => { ir('historico'); verLog(h.id); } }, 'Ver o log'));
  pintaProxima();
}
const resultadoChip = (h) => h.cancelada ? chip('neutro', 'cancelada') : h.codigo === 0 ? chip('ok', 'ok') : chip('erro', `erro (${h.codigo ?? h.sinal})`);
$('setupTudo').onclick = () => executar('setup', { temporadas: temporadasAtivas(), semRender: $('setupSemRender').checked }, 'Rodar o setup completo? Baixa e gera tudo o que falta (pode levar bastante tempo).');

// ---- tarefas ----
const CAMPOS = {
  temporadas: () => num('temporadas', 'Temporadas liberadas (1..5)', 1, 5, temporadasAtivas()),
  semRender: () => chk('semRender', 'Não desenhar as imagens (--sem-render)'),
  etapa: () => sel('etapa', 'Etapa', etapas.map((e) => [e.nome, `${e.nome}: ${e.desc}`])),
  force: () => chk('force', 'Refazer mesmo se já existir (--force)'),
  comando: () => sel('comando', 'Comando', ['fetch', 'decks', 'build', 'art', 'puzzles'].map((c) => [c, c])),
  comandoRush: () => sel('comandoRush', 'Comando', [['fetch', 'fetch (baixa BabelCDB e CardScripts)'], ['build', 'build (gera cards.json e copia os scripts)']]),
  modoRush: () => sel('modoRush', 'Modo', [['todos', 'todos (metade IA, metade aleatório)'], ['ia', 'IA x IA com decks gerados'], ['aleatorio', 'bot aleatório com decks sorteados'], ['diario', 'diario (N dias do desafio do dia)'], ['niveis', 'niveis (cada nível da IA contra a gulosa)']]),
  ate: () => num('ate', 'Temporadas (só para build --ate N)', 1, 5, 1),
  nos: () => num('nos', 'Teto de nós (vazio = configuração salva)', 100, 1000000, ''),
  meta: () => num('meta', 'Meta de puzzles validados (vazio = configuração salva)', 1, 200, ''),
  ids: () => txt('ids', 'Só estes ids (opcional, separados por vírgula)'),
  refazerArte: () => chk('refazerArte', 'Refazer as artes antigas de 320px em alta resolução (--hd)'),
  limiteArtes: () => num('limiteArtes', 'Limite de artes a baixar (0 = sem limite)', 0, 5000, 0),
  duelos: () => num('duelos', 'Duelos (ou dias, no modo diario)', 1, 5000, 20),
  temporada: () => num('temporada', 'Temporada', 1, 5, 1),
};
const num = (n, rot, min, max, v) => el('label', { className: 'campo' }, rot, el('input', { name: n, type: 'number', min, max, value: v, inputMode: 'numeric' }));
const txt = (n, rot) => el('label', { className: 'campo' }, rot, el('input', { name: n, type: 'text', autocomplete: 'off' }));
const chk = (n, rot) => el('label', { className: 'chk' }, el('input', { name: n, type: 'checkbox' }), rot);
const sel = (n, rot, ops) => el('label', { className: 'campo' }, rot, el('select', { name: n }, ops.map(([v, t]) => el('option', { value: v }, t))));
function montaParams() {
  const t = meta.tarefas[$('tarefa').value];
  $('desc').textContent = t.desc;
  $('indisp').hidden = !t.indisponivel; $('indisp').textContent = t.indisponivel ? `Indisponível aqui: ${t.indisponivel}.` : '';
  $('params').replaceChildren(...t.params.map((p) => CAMPOS[p]()));
  $('rodar').disabled = !!t.indisponivel;
}
function lerParams() {
  const o = {};
  for (const i of $('params').querySelectorAll('input,select')) o[i.name] = i.type === 'checkbox' ? i.checked : i.value;
  return o;
}
async function executar(tarefa, params, texto) {
  if (!(await confirmar(texto))) return;
  try { await api('executar', 'POST', { tarefa, params }); aviso('Tarefa enviada. Acompanhe no topo ou em Tarefas.'); } catch (e) { falha(e); }
}
$('rodar').onclick = () => { const t = $('tarefa').value; executar(t, lerParams(), `Executar "${meta.tarefas[t].titulo}"?`); };

// ---- cartas ----
const TIPOS_RACA = { 0x1: 'Guerreiro', 0x2: 'Mago', 0x4: 'Fada', 0x8: 'Demônio', 0x10: 'Zumbi', 0x20: 'Máquina', 0x40: 'Aqua', 0x80: 'Piro', 0x100: 'Rocha', 0x200: 'Besta Alada', 0x400: 'Planta', 0x800: 'Inseto', 0x1000: 'Trovão', 0x2000: 'Dragão', 0x4000: 'Besta', 0x8000: 'Besta-Guerreira', 0x10000: 'Dinossauro', 0x20000: 'Peixe', 0x40000: 'Serpente Marinha', 0x80000: 'Réptil', 0x100000: 'Psíquico', 0x800000: 'Wyrm', 0x1000000: 'Ciberso', 0x4000000: 'Ciborgue', 0x8000000: 'Cavaleiro Mágico', 0x10000000: 'Dragão Supremo', 0x40000000: 'Guerreiro Celestial', 0x80000000: 'Galáxia' };
const ATRIBUTOS = { 0x1: 'Terra', 0x2: 'Água', 0x4: 'Fogo', 0x8: 'Vento', 0x10: 'Luz', 0x20: 'Trevas', 0x40: 'Divino' };
const ehMonstro = (t) => (t & 1) !== 0;
const tipoCarta = (t) => t & 2 ? 'Magia' : t & 4 ? 'Armadilha' : t & 0x40 ? 'Monstro de Fusão' : t & 0x80 ? 'Monstro de Ritual' : t & 0x20 ? 'Monstro de Efeito' : 'Monstro Normal';
const blobs = new Map();
async function imagem(pasta, id) { // imagem com o cabeçalho do token -> URL blob: (o token não vai para a URL)
  const k = `${pasta}/${id}`;
  if (!blobs.has(k)) {
    blobs.set(k, fetch(`/arquivo/${pasta}/${id}.webp`, { headers: { 'x-admin-token': token } }).then((r) => (r.ok ? r.blob() : null)).then((b) => (b ? URL.createObjectURL(b) : null)).catch(() => null));
    if (blobs.size > 300) { const [velha, pr] = blobs.entries().next().value; blobs.delete(velha); pr.then((u) => u && URL.revokeObjectURL(u)); }
  }
  return blobs.get(k);
}
let cartas = [];
async function buscar(q, abrirPrimeira = false) {
  $('cartasInfo').textContent = 'Buscando…';
  try {
    const r = await api('carta?q=' + encodeURIComponent(q));
    cartas = r.cartas;
    const falt = [!r.rushDisponivel && 'sem dados do Rush (rode rush-ocg)', !r.classicoDisponivel && 'sem dados do clássico (rode classico)'].filter(Boolean);
    $('cartasInfo').textContent = `${cartas.length === 40 ? '40+' : cartas.length} resultado(s)${falt.length ? ' · ' + falt.join(' · ') : ''}.`;
    $('resultados').replaceChildren(...cartas.map((c, i) => {
      const mini = el('img', { className: 'mini', alt: '', width: 44, height: 64 });
      if (c.mini) imagem(c.fonte === 'rush' ? 'rush-cards-sm' : 'classic-cards-sm', c.id).then((u) => { if (u) mini.src = u; });
      return el('li', {}, el('button', { type: 'button', 'aria-pressed': 'false', onclick: (ev) => detalheCarta(i, ev.currentTarget) }, mini,
        el('span', {}, el('b', {}, c.name), el('small', {}, `${c.fonte === 'rush' ? 'Rush' : 'Clássico'} · ${c.id}${!c.arte ? ' · sem arte' : ''}${!c.montada ? ' · sem montagem' : ''}`))));
    }));
    if (!cartas.length) $('cartaDet').hidden = true;
    if (abrirPrimeira && cartas.length) detalheCarta(0, $('resultados').querySelector('button'));
  } catch (e) { $('cartasInfo').textContent = e.message; }
}
async function detalheCarta(i, botao) {
  const c = cartas[i];
  for (const b of $('resultados').querySelectorAll('button')) b.setAttribute('aria-pressed', String(b === botao));
  const rush = c.fonte === 'rush', pre = rush ? 'rush' : 'classic';
  const fig = (pasta, tem, rotulo, faltaTxt) => {
    const f = el('figure', {}, tem ? el('div', { className: 'sem-img' }, 'Carregando…') : el('div', { className: 'sem-img' }, faltaTxt), el('figcaption', {}, rotulo));
    if (tem) imagem(pasta, c.id).then((u) => f.firstChild.replaceWith(u ? el('img', { src: u, alt: `${rotulo}: ${c.name}` }) : el('div', { className: 'sem-img' }, 'Não consegui carregar.')));
    return f;
  };
  const faltas = [!c.arte && 'arte', !c.montada && (rush ? 'carta montada' : 'carta pré-desenhada'), !c.mini && 'miniatura'].filter(Boolean);
  const acao = (tarefa, params, rotulo, texto) => el('button', { className: 'btn sec pequeno', disabled: !disponivel(tarefa), title: meta.tarefas[tarefa]?.indisponivel || '', onclick: () => executar(tarefa, params, texto) }, rotulo);
  const ficha = [['Id', String(c.id)], ['Nome em inglês', c.nameEn || '—'], ['Tipo', tipoCarta(c.type)]];
  if (ehMonstro(c.type)) ficha.push(['Atributo', ATRIBUTOS[c.attribute] ?? '—'], ['Tipo de monstro', TIPOS_RACA[c.race] ?? String(c.race)], ['Nível', String(c.level & 0xff)], ['ATK / DEF', `${c.atk} / ${c.def}`]);
  $('cartaDet').hidden = false;
  $('cartaDet').replaceChildren(
    el('h2', {}, c.name, chip('neutro', rush ? 'Rush' : 'Clássico'), c.legend ? chip('parcial', 'Lenda') : null, rush ? chip(c.pt ? 'ok' : 'neutro', c.pt ? 'texto em PT' : 'sem PT') : null),
    el('dl', { className: 'dl' }, ficha.flatMap(([k, v]) => [el('dt', {}, k), el('dd', {}, v)])),
    el('div', { className: 'imgs' }, fig(`${pre}-art`, c.arte, 'Arte', rush ? 'Sem arte: a carta sai com o quadro no tom do atributo.' : 'Sem arte baixada.'), fig(`${pre}-cards`, c.montada, rush ? 'Carta montada' : 'Carta pré-desenhada', 'Ainda não montada.')),
    el('p', {}, faltas.length ? ['Falta: ', ...faltas.map((f) => chip('falta', f))] : chip('ok', 'nada falta')),
    el('div', { className: 'acoes-linha' }, rush
      ? [acao('artes-rush', { ids: String(c.id), force: c.arte }, c.arte ? 'Baixar a arte de novo' : 'Baixar a arte', `Baixar do Yugipedia a arte de ${c.name} (${c.id})?`), acao('montar-rush', { ids: String(c.id), force: c.montada }, c.montada ? 'Montar de novo' : 'Montar a carta', `Montar a carta Rush ${c.name} (${c.id})?`)]
      : [acao('artes-hd', { ids: String(c.id), refazerArte: c.arte }, c.arte ? 'Baixar a arte em HD' : 'Baixar a arte', `Baixar a arte de ${c.name} (${c.id})?`), acao('render-classico', { ids: String(c.id), force: c.montada }, c.montada ? 'Desenhar de novo' : 'Desenhar a carta', `Desenhar a carta clássica ${c.name} (${c.id})?`)]),
    c.desc ? el('p', { className: 'texto' }, c.desc) : null);
  if (matchMedia('(max-width: 900px)').matches) $('cartaDet').scrollIntoView({ block: 'start' });
}
$('buscaForm').onsubmit = (ev) => { ev.preventDefault(); buscar($('buscaCarta').value.trim()); };
const abrirCarta = (id) => { ir('cartas'); $('buscaCarta').value = String(id); buscar(String(id), true); };

// ---- desafio do dia ----
let desafioCarregado = null;
const somaDias = (iso, n) => { const d = new Date(`${iso}T12:00:00Z`); d.setUTCDate(d.getUTCDate() + n); return d.toISOString().slice(0, 10); };
const diaLongo = (iso) => new Date(`${iso}T12:00:00Z`).toLocaleDateString('pt-BR', { weekday: 'long', day: 'numeric', month: 'long', timeZone: 'UTC' });
function deckEl(deck, cartas) {
  const conta = (lista) => { const m = new Map(); for (const id of lista) m.set(id, (m.get(id) || 0) + 1); return [...m]; };
  const ordem = ([a], [b]) => { const x = cartas[a], y = cartas[b]; return (y?.lg ? 1 : 0) - (x?.lg ? 1 : 0) || (y?.a ?? 0) - (x?.a ?? 0) || String(x?.n).localeCompare(String(y?.n)); };
  const linha = ([id, q]) => { const c = cartas[id] ?? { n: String(id), t: 0 }; return el('li', {}, el('span', { className: 'q' }, `${q}×`), el('span', {}, el('button', { type: 'button', onclick: () => abrirCarta(id) }, c.n), c.lg ? el('span', { className: 'lg' }, 'LENDA') : null), el('small', {}, ehMonstro(c.t) ? `Nv ${c.l & 0xff} · ${c.a}/${c.d}` : c.t & 2 ? 'Magia' : 'Armadilha')); };
  const main = conta(deck.main);
  const grupos = [['Monstros', main.filter(([id]) => ehMonstro(cartas[id]?.t ?? 1))], ['Magias', main.filter(([id]) => (cartas[id]?.t ?? 0) & 2)], ['Armadilhas', main.filter(([id]) => (cartas[id]?.t ?? 0) & 4)], ['Deck adicional', conta(deck.extra)]];
  return el('ul', { className: 'deck' }, grupos.filter(([, l]) => l.length).flatMap(([nome, l]) => [el('h4', {}, `${nome} (${l.reduce((a, [, q]) => a + q, 0)})`), ...l.sort(ordem).map(linha)]));
}
async function carregaDesafio(data) {
  $('diaData').value = data;
  $('desafio').replaceChildren(el('p', { className: 'vazio' }, 'Gerando o desafio…'));
  try {
    const r = await api(`desafio?data=${data}&dias=7`);
    desafioCarregado = data;
    if (r.erro) { $('desafio').replaceChildren(el('p', { className: 'aviso erro' }, r.erro)); return; }
    const { dia, proximos, cartas } = r;
    let escolhido = 1;
    const painelRival = el('div');
    const abas = el('div', { className: 'abas', role: 'tablist', 'aria-label': 'Dificuldade' });
    const pintaRival = () => {
      const rv = dia.rivais[escolhido];
      for (const [i, b] of [...abas.children].entries()) { b.setAttribute('aria-selected', String(i === escolhido)); b.tabIndex = i === escolhido ? 0 : -1; }
      painelRival.replaceChildren(el('p', { className: 'desc' }, rv.modifier), el('dl', { className: 'dl' }, [['PV do rival', fmtN(rv.lp)], ['IA', rv.ai], ['Força do deck', fmtN(rv.power)], ['Cartas', `${rv.deck.main.length} + ${rv.deck.extra.length}`]].flatMap(([k, v]) => [el('dt', {}, k), el('dd', {}, v)])), deckEl(rv.deck, cartas));
    };
    abas.append(...dia.rivais.map((rv, i) => el('button', { className: 'btn sec pequeno', role: 'tab', type: 'button', onclick: () => { escolhido = i; pintaRival(); },
      onkeydown: (ev) => { if (ev.key === 'ArrowRight' || ev.key === 'ArrowLeft') { escolhido = (escolhido + (ev.key === 'ArrowRight' ? 1 : 3)) % 4; pintaRival(); abas.children[escolhido].focus(); } } }, rv.nome)));
    painelRival.setAttribute('role', 'tabpanel');
    pintaRival();
    $('desafio').replaceChildren(
      el('p', { className: 'sub' }, diaLongo(dia.data) + (dia.data === hojeLocal() ? ' (hoje)' : '')),
      el('div', { className: 'confronto' }, el('div', {}, el('span', {}, 'Você'), el('b', {}, dia.jogador.label), el('span', {}, `${fmtN(dia.jogador.lp)} PV · força ${fmtN(dia.jogador.power)}`)), el('span', { className: 'vs' }, 'contra'),
        el('div', {}, el('span', {}, 'Rival'), el('b', {}, dia.rivais[0].label), el('span', {}, `${fmtN(dia.rivais[0].lp)} a ${fmtN(dia.rivais.at(-1).lp)} PV conforme a dificuldade`))),
      el('div', { className: 'grade2' },
        el('article', { className: 'painel' }, el('h2', {}, 'Seu deck', el('span', { className: 'tag' }, `${dia.jogador.deck.main.length} + ${dia.jogador.deck.extra.length} cartas, igual em todas as dificuldades`)), deckEl(dia.jogador.deck, cartas)),
        el('article', { className: 'painel' }, el('h2', {}, 'Rival por dificuldade'), abas, painelRival)),
      el('article', { className: 'painel' }, el('h2', {}, 'Próximos dias'), el('div', { className: 'tabela' }, el('table', {}, el('thead', {}, el('tr', {}, el('th', {}, 'Dia'), el('th', {}, 'Confronto'))),
        el('tbody', {}, proximos.map((p) => el('tr', { className: 'clic', tabIndex: 0, onclick: () => carregaDesafio(p.data), onkeydown: (ev) => ev.key === 'Enter' && carregaDesafio(p.data) }, el('td', {}, diaLongo(p.data)), el('td', {}, `${p.jogador} contra ${p.rival}`))))))));
  } catch (e) { $('desafio').replaceChildren(el('p', { className: 'aviso erro' }, e.message)); }
}
$('diaAnt').onclick = () => carregaDesafio(somaDias($('diaData').value || hojeLocal(), -1));
$('diaProx').onclick = () => carregaDesafio(somaDias($('diaData').value || hojeLocal(), 1));
$('diaHoje').onclick = () => carregaDesafio(hojeLocal());
$('diaData').onchange = () => { if ($('diaData').value) carregaDesafio($('diaData').value); };
aoMostrar.desafio = () => { if (!desafioCarregado) carregaDesafio(hojeLocal()); };

// ---- jogadores ----
const NS = 'http://www.w3.org/2000/svg';
const COLS = [['key', 'Chave'], ['primeiro', 'Primeiro acesso'], ['ultimo', 'Último acesso'], ['acessos', 'Acessos'], ['dias', 'Dias ativos'], ['bytes', 'Tamanho'], ['rev', 'Rev']];
const jog = { ordem: 'ultimo', dir: 'desc', pagina: 1, busca: '', limite: 15, total: 0 };
function grafico(svg, serie, campo) {
  const W = 600, Hh = 140, base = 116, max = Math.max(1, ...serie.map((d) => d[campo])), w = W / serie.length;
  svg.setAttribute('viewBox', `0 0 ${W} ${Hh}`); svg.setAttribute('preserveAspectRatio', 'none');
  svg.replaceChildren();
  const ln = document.createElementNS(NS, 'line'); ln.setAttribute('x1', 0); ln.setAttribute('x2', W); ln.setAttribute('y1', base + .5); ln.setAttribute('y2', base + .5); svg.append(ln);
  serie.forEach((d, i) => {
    const h = d[campo] ? Math.max(2, d[campo] / max * (base - 14)) : 1.5;
    const r = document.createElementNS(NS, 'rect');
    r.setAttribute('x', i * w + 1); r.setAttribute('y', base - h); r.setAttribute('width', Math.max(1, w - 2)); r.setAttribute('height', h); r.setAttribute('rx', 1.5);
    if (!d[campo]) r.setAttribute('class', 'zero');
    const t = document.createElementNS(NS, 'title'); t.textContent = `${d.dia}: ${d[campo]}`; r.append(t); svg.append(r);
  });
  for (const [tx, x, anc] of [[serie[0].dia.slice(5), 0, 'start'], [serie.at(-1).dia.slice(5), W, 'end'], [`máx ${max}`, W / 2, 'middle']]) {
    const t = document.createElementNS(NS, 'text'); t.setAttribute('x', x); t.setAttribute('y', 134); t.setAttribute('text-anchor', anc); t.textContent = tx; svg.append(t);
  }
}
async function jogResumo() {
  const r = await api('jogadores/resumo');
  jogResumoCache = r;
  if (r.configurado === false) {
    $('jog').hidden = true; $('jogConf').hidden = false;
    $('jogConf').replaceChildren(...(r.conteiner
      ? ['Estatísticas não configuradas. No ', el('code', {}, '.env'), ' do homelab defina ', el('code', {}, 'ADMIN_TOKEN'), ' (32+ caracteres) e suba de novo: ', el('code', {}, 'docker compose --profile admin up -d'), '. O painel lê o rushdaily-sync pela rede interna.']
      : ['Estatísticas não configuradas. No homelab: defina ', el('code', {}, 'ADMIN_TOKEN'), ' no ', el('code', {}, '.env'), ' do compose, abra o túnel ', el('code', {}, 'ssh -L 4192:127.0.0.1:4192 homelab'),
        ' e suba este admin com ', el('code', {}, 'SYNC_ADMIN_TOKEN=…'), ' (ou grave ', el('code', {}, 'syncAdminToken'), ' em ', el('code', {}, 'tools/setup/cache/admin/config.json'), '). Mais simples: rode o painel no contêiner (veja tools/admin/LEIA-ME.md).']));
    return false;
  }
  $('jogConf').hidden = true; $('jog').hidden = false;
  $('cartoes').replaceChildren(...[['Chaves', r.totalChaves], ['Ativos hoje', r.ativosHoje], ['Ativos 7 dias', r.ativos7d], ['Ativos 30 dias', r.ativos30d]].map(([nome, v]) => el('div', { className: 'kpi' }, el('b', {}, fmtN(v)), el('span', {}, nome))));
  grafico($('grafAtivos'), r.ativosPorDia, 'ativos'); grafico($('grafNovas'), r.novasPorDia, 'novas');
  return true;
}
async function jogLista() {
  const q = new URLSearchParams({ ordem: jog.ordem, dir: jog.dir, pagina: jog.pagina, limite: jog.limite, ...(jog.busca ? { busca: jog.busca } : {}) });
  const r = await api('jogadores/usuarios?' + q);
  jog.total = r.total;
  $('jogCab').replaceChildren(...COLS.map(([k, nome]) => el('th', { className: 'ord', 'aria-sort': jog.ordem === k ? (jog.dir === 'asc' ? 'ascending' : 'descending') : 'none' },
    el('button', { type: 'button', onclick: () => ordena(k) }, nome + (jog.ordem === k ? (jog.dir === 'asc' ? ' ▲' : ' ▼') : '')))));
  $('jogLinhas').replaceChildren(...r.usuarios.map((u) => el('tr', { className: 'clic', tabIndex: 0, onclick: () => jogDetalhe(u.key), onkeydown: (ev) => ev.key === 'Enter' && jogDetalhe(u.key) },
    el('td', { className: 'mono' }, u.key), el('td', {}, fmtT(u.primeiroAcesso)), el('td', {}, fmtT(u.ultimoAcesso)), el('td', { className: 'num' }, fmtN(u.acessos)), el('td', { className: 'num' }, fmtN(u.diasAtivos)), el('td', { className: 'num' }, fmtB(u.bytes)), el('td', { className: 'num' }, String(u.rev)))));
  if (!r.usuarios.length) $('jogLinhas').replaceChildren(el('tr', {}, el('td', { colSpan: COLS.length }, 'Nenhuma chave.')));
  const paginas = Math.max(1, Math.ceil(r.total / jog.limite));
  $('jogPag').textContent = `Página ${jog.pagina} de ${paginas} · ${fmtN(r.total)} chaves`;
  $('jogAnt').disabled = jog.pagina <= 1; $('jogProx').disabled = jog.pagina >= paginas;
}
const ordena = (k) => { jog.dir = jog.ordem === k && jog.dir === 'desc' ? 'asc' : 'desc'; jog.ordem = k; jog.pagina = 1; jogLista().catch(falha); };
async function jogDetalhe(key) {
  try {
    const u = await api('jogadores/usuario/' + encodeURIComponent(key));
    const p = u.progresso;
    const campos = [['Primeiro acesso', fmtT(u.primeiroAcesso)], ['Último acesso', fmtT(u.ultimoAcesso)], ['Acessos', fmtN(u.acessos)], ['Dias ativos', fmtN(u.diasAtivos)], ['Tamanho do dado', fmtB(u.bytes)], ['Rev', String(u.rev)],
      ['Vitórias / derrotas', `${p.vitorias} / ${p.derrotas}`], ['Sequência atual', `${p.sequencia} dia(s)`], ['Cartas distintas (clássico)', fmtN(p.cartas)], ['Decks', fmtN(p.decks)], ['Duelos PvP', fmtN(p.pvp)], ['Peças do Enigma (mês)', fmtN(p.pecasEnigma)], ['Boosters abertos', fmtN(p.boosters)], ['Chave criada', fmtT(u.criadaEm)]];
    $('jogDet').replaceChildren(el('h2', { className: 'mono' }, `Chave ${u.key}`), el('dl', { className: 'dl' }, campos.flatMap(([k, v]) => [el('dt', {}, k), el('dd', {}, v)])),
      el('p', { className: 'desc' }, `Dias ativos (${u.dias.length}): ${u.dias.slice(0, 120).join(', ') || 'nenhum registrado'}${u.dias.length > 120 ? '…' : ''}`),
      el('button', { className: 'btn sec', onclick: () => { $('jogDet').hidden = true; } }, 'Fechar'));
    $('jogDet').hidden = false; $('jogDet').scrollIntoView({ block: 'nearest' });
  } catch (e) { falha(e); }
}
async function jogadores() { try { if (await jogResumo()) await jogLista(); } catch (e) { $('jogConf').hidden = false; $('jogConf').textContent = e.message; } if (ultimoStatus) pintaStatus(); }
let buscaT;
$('jogBusca').oninput = () => { clearTimeout(buscaT); buscaT = setTimeout(() => { jog.busca = $('jogBusca').value.trim(); jog.pagina = 1; jogLista().catch(falha); }, 300); };
$('jogAnt').onclick = () => { jog.pagina -= 1; jogLista().catch(falha); };
$('jogProx').onclick = () => { jog.pagina += 1; jogLista().catch(falha); };
$('jogAtualizar').onclick = jogadores;
aoMostrar.jogadores = jogadores;

// ---- histórico ----
let histSel = null;
function pintaHistorico() {
  const f = $('histBusca').value.trim().toLowerCase(), r = $('histFiltro').value;
  const lista = histAtual.filter((h) => (!f || `${h.titulo} ${h.linha}`.toLowerCase().includes(f)) && (!r || (r === 'cancelada' ? h.cancelada : r === 'ok' ? !h.cancelada && h.codigo === 0 : !h.cancelada && h.codigo !== 0)));
  $('hist').replaceChildren(...lista.map((h) => el('li', { className: 'hist-item' + (histSel === h.id ? ' sel' : '') },
    el('div', {}, el('h3', {}, resultadoChip(h), h.titulo), el('p', {}, `${fmtT(h.inicio)} · ${fmtD(h.duracaoMs)}`), el('p', {}, el('code', {}, h.linha)),
      h.resumo?.tipo === 'testes' ? el('p', {}, `${h.resumo.ok}/${h.resumo.testes} testes ok`) : h.resumo?.tipo === 'simulacao' ? el('p', {}, h.resumo.errosScript ? 'simulação com erros de script' : 'simulação sem erros de script') : null),
    el('div', { className: 'acoes-linha' }, el('button', { className: 'btn sec pequeno', onclick: () => verLog(h.id) }, 'Ver o log'),
      el('button', { className: 'btn fantasma pequeno', disabled: !h.params || !disponivel(h.tarefa), title: !h.params ? 'Execução antiga, sem os parâmetros guardados' : '', onclick: () => executar(h.tarefa, h.params, `Repetir "${h.titulo}" com os mesmos parâmetros?\n${h.linha}`) }, 'Repetir')))));
  if (!lista.length) $('hist').replaceChildren(el('li', { className: 'vazio' }, histAtual.length ? 'Nada com esse filtro.' : 'Nenhuma execução ainda.'));
}
async function verLog(id) {
  try {
    const h = await api('historico?id=' + id);
    histSel = h.id; pintaHistorico();
    $('histDet').hidden = false;
    $('histTitulo').textContent = `· ${h.titulo} (${h.completo ? 'completo' : `últimas ${h.log.length} linhas`})`;
    $('histResumo').replaceChildren(resumoEl(h.resumo, h) ?? '');
    logHist.set(h.log, `${h.tarefa}-${h.id}`);
    $('histDet').scrollIntoView({ block: 'start', behavior: matchMedia('(prefers-reduced-motion: reduce)').matches ? 'auto' : 'smooth' });
  } catch (e) { falha(e); }
}
$('histBusca').oninput = pintaHistorico;
$('histFiltro').onchange = pintaHistorico;

// ---- configuração ----
async function carregaConfig() {
  const c = await api('config');
  $('nos').value = c.nos; $('meta').value = c.meta;
  const ativas = c.temporadas.filter((s) => s.enabled).length;
  $('temps').replaceChildren(...c.temporadas.map((s) => el('option', { value: s.season, selected: s.season === ativas }, `${s.season} · ${s.label} (até ${s.until})`)));
  $('temps').disabled = $('aplicarTemps').disabled = !c.temporadas.length || !disponivel('classico');
  $('tempsInfo').textContent = c.temporadas.length ? `Ativas agora: 1..${ativas}. Mudar roda o importador (não edita seasons.json à mão).` : 'Sem dados do clássico (src/data/classic/seasons.json): rode a etapa classico.';
  const versao = (v, arq) => v ? ['Suba ', el('code', {}, 'CACHE_VERSION'), ` de ${v} para ${v + 1} em `, el('code', {}, arq), '.'] : ['Não encontrei ', el('code', {}, arq), ' aqui.'];
  $('invInfo').replaceChildren(el('p', { className: 'desc' }, 'Clássicas: ', ...versao(c.cacheVersion, 'src/ui/classic-render.js')), el('p', { className: 'desc' }, 'Rush: ', ...versao(c.cacheVersionRush, 'src/ui/rush-render.js')));
  $('ambiente').replaceChildren(...[['Modo', c.conteiner ? 'Contêiner (token fixo do .env)' : 'Local (token novo a cada início)'], ['Raiz dos dados', meta.modo.raiz], ['Servidor de sync', c.sync.url], ['Estatísticas', c.sync.configurado ? 'configuradas' : 'não configuradas']].flatMap(([k, v]) => [el('dt', {}, k), el('dd', {}, v)]));
}
$('aplicarTemps').onclick = () => { const n = $('temps').value; executar('classico', { comando: 'build', ate: n }, `Regerar o pool clássico com as temporadas 1..${n}? Roda "import_cards.py build --ate ${n}".`); };
$('salvarCfg').onclick = async () => {
  if (!(await confirmar('Salvar teto de nós e meta da busca de puzzles?'))) return;
  try { await api('config', 'PUT', { nos: $('nos').value, meta: $('meta').value }); aviso('Configuração salva.'); } catch (e) { falha(e); }
};
function pintaNotificacao() {
  const tem = 'Notification' in window;
  $('notificar').disabled = !tem || Notification.permission !== 'default';
  $('notInfo').textContent = !tem ? 'Este navegador não tem notificações.' : Notification.permission === 'granted' ? 'Notificações ligadas.' : Notification.permission === 'denied' ? 'Bloqueadas no navegador (libere nas permissões do site).' : '';
}
$('notificar').onclick = async () => { try { await Notification.requestPermission(); } catch { /* ok */ } pintaNotificacao(); };

// ---- início ----
(async () => {
  mostra(location.hash.slice(1) || 'visao', false);
  pintaNotificacao();
  if (!token) { $('semToken').hidden = false; return; }
  try {
    meta = await api('tarefas'); etapas = meta.etapas;
    $('modo').hidden = false; $('modo').textContent = meta.modo.conteiner ? 'Contêiner' : 'Local';
    const grupos = new Map();
    for (const [k, t] of Object.entries(meta.tarefas)) { if (!grupos.has(t.grupo)) grupos.set(t.grupo, []); grupos.get(t.grupo).push(el('option', { value: k }, t.titulo + (t.indisponivel ? ' (indisponível)' : ''))); }
    $('tarefa').replaceChildren(...[...grupos].map(([g, ops]) => el('optgroup', { label: g }, ops)));
    $('tarefa').value = Object.keys(meta.tarefas).find((k) => !meta.tarefas[k].indisponivel) ?? 'setup';
    $('tarefa').onchange = montaParams; montaParams();
    if (!meta.modo.setup) $('visaoSub').textContent = 'Sem o setup nesta instalação: o painel mostra só o que dá para ler.';
    await carregaConfig();
  } catch (e) { falha(e); }
  carregaStatus(); setInterval(carregaStatus, 5000);
  jogResumo().then(() => ultimoStatus && pintaStatus()).catch(() => {});
  eventos();
  pronto = true;
  aoMostrar[secao]?.();
})();
