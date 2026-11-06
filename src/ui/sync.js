// Cliente da sincronização entre aparelhos (servidor em server/server.mjs, desenho em docs/sync/README.md).
// Importar este módulo liga o gancho: gravar uma chave de progresso (writeJson) agenda um sync.
import { SchemaError, canonical, hasProgress, isProgressKey, mergeProgress, normalize, readProgress, trimReplays, writeProgress } from './sync-merge.js';
import { getPlayerKey, newPlayerKey, readJson, setWriteHook, writeJson } from './common.js';

const SECRET = /^[A-Za-z0-9_-]{22,128}$/;
const GZIP_MIN = 8 * 1024; // corpo do PUT acima disso vai comprimido (Content-Encoding: gzip)
const SOFT_MAX = 800 * 1024; // acima disso corta os replays PvP mais antigos antes de enviar (o servidor recusa > 1 MiB)
let gzipOk = typeof CompressionStream === 'function'; // servidor antigo recusou o gzip: manda cru até recarregar a página
export const credKey = (playerKey) => `rushdaily-sync:${playerKey}`;
/** Resumo (64 bits + tamanho) do progresso que o servidor tem: com o 304 do GET, diz se o local mudou desde então.
 * FNV-1a e não crypto.subtle, que não existe fora de contexto seguro (http na LAN). */
const sumOf = (data) => {
  const text = canonical(data);
  let a = 2166136261, b = 3735928559;
  for (let i = 0; i < text.length; i += 1) { const c = text.charCodeAt(i); a = Math.imul(a ^ c, 16777619); b = Math.imul(b ^ c ^ (i & 255), 16777619); }
  return `${text.length}.${(a >>> 0).toString(36)}.${(b >>> 0).toString(36)}`;
};
/** { secret, rev, sum, status: 'on' | 'off' | 'taken', at } deste aparelho. Nunca vai no corpo nem em log. */
export const credOf = (playerKey) => {
  const cred = readJson(credKey(playerKey), null);
  return cred && SECRET.test(cred.secret || '') ? cred : null;
};
const saveCred = (playerKey, cred) => writeJson(credKey(playerKey), cred);

function newSecret() {
  const bytes = crypto.getRandomValues(new Uint8Array(32)); // 256 bits
  return btoa(String.fromCharCode(...bytes)).replaceAll('+', '-').replaceAll('/', '_').replace(/=+$/, '');
}

// body: objeto (vira JSON), string ou ArrayBuffer (já pronto, ex.: gzip).
const api = (playerKey, secret, method, body, signal, path = '', headers = {}) => fetch(`api/sync/${playerKey}${path}`, {
  method,
  signal,
  cache: 'no-store',
  headers: { Authorization: `Bearer ${secret}`, ...(body ? { 'Content-Type': 'application/json' } : {}), ...headers },
  body: !body ? undefined : typeof body === 'string' || body instanceof ArrayBuffer ? body : JSON.stringify(body),
});
const gzip = (text) => new Response(new Blob([text]).stream().pipeThrough(new CompressionStream('gzip'))).arrayBuffer();

let running = null;
let dirty = false; // progresso gravado durante um sync em andamento: roda mais uma vez no fim
/**
 * Busca, junta, grava e envia. Na primeira vez com internet gera o segredo; reivindica a chave no primeiro sync com
 * progresso (ou com { claim: true }).
 * Nunca lança: devolve { status: 'on' | 'off' | 'taken' | 'offline' | 'error' | 'schema', changed }.
 */
export function syncNow(options) {
  running ||= (async () => {
    let result;
    // finally aqui dentro: running zera no mesmo passo em que dirty é conferido (nenhuma gravação cai entre os dois).
    try { do { dirty = false; result = await run(options); } while (dirty && result.status === 'on'); } finally { running = null; }
    return result;
  })();
  return running;
}

async function run({ timeout = 4000, promoted = false, claim = false } = {}) {
  const playerKey = getPlayerKey();
  let cred = credOf(playerKey);
  if (cred && cred.status !== 'on') return { status: cred.status };
  if (navigator.onLine === false) return { status: 'offline' };
  if (!cred) { cred = { secret: newSecret(), rev: 0, status: 'on' }; saveCred(playerKey, cred); } // grava antes: uma queda não troca o segredo
  const signal = AbortSignal.timeout(timeout);
  const call = (method, body, path, headers) => api(playerKey, cred.secret, method, body, signal, path, headers);
  const put = async (data, baseRev) => {
    const text = JSON.stringify({ data, baseRev });
    if (gzipOk && text.length > GZIP_MIN) {
      const res = await call('PUT', await gzip(text), '', { 'Content-Encoding': 'gzip' });
      if (res.status !== 400 && res.status !== 415) return res;
      gzipOk = false; // servidor de antes do gzip (JSON inválido): repete cru
    }
    return call('PUT', text);
  };
  // Grava por cima da credencial atual (não da lida no início): a troca de segredo pode ter acontecido no meio.
  const update = (fields) => saveCred(playerKey, { ...(credOf(playerKey) ?? cred), ...fields });
  // Erro que a tela de Ajustes mostra (413, 429, 503, esquema...); some no próximo sync bem-sucedido.
  const fail = (code, result) => { update({ lastError: { code, at: Date.now() } }); return result; };
  const error = (code) => fail(code, { status: 'error', code });
  const taken = async () => {
    // Troca de segredo cuja resposta se perdeu: o servidor pode já ter o next. Tenta com ele antes de desistir.
    if (cred.next && !promoted) {
      const { next, ...rest } = credOf(playerKey) ?? cred;
      saveCred(playerKey, { ...rest, secret: next || cred.next });
      return run({ timeout, promoted: true, claim });
    }
    // Já sincronizou (ou veio de um link) e agora o segredo não confere: trocaram o segredo em outro aparelho.
    update({ status: 'taken', ...(cred.at || cred.linkedAt ? { lastError: { code: 403, at: Date.now() } } : {}) });
    return { status: 'taken' };
  };
  try {
    const before = canonical(readProgress(localStorage, playerKey));
    // Já sincronizou: o servidor responde 304 sem corpo se a rev não mudou (servidor antigo ignora e manda 200).
    let res = await call('GET', null, '', cred.rev ? { 'If-None-Match': `"${cred.rev}"` } : {});
    if (res.status === 403) return taken();
    if (res.status === 503 || res.status === 429) return error(res.status); // servidor cheio / muitos pedidos
    if (res.status >= 500) return { status: 'offline' }; // proxy sem o servidor de sync (502)
    if (res.status !== 200 && res.status !== 304 && res.status !== 404) return error(res.status);
    // 304: o servidor ainda tem o que este aparelho viu por último (resumido em cred.sum). Sem o resumo
    // (credencial de antes do 304), não dá para saber: reenvia o local sobre a mesma rev.
    let remote = res.status === 200 ? await res.json() : res.status === 304 ? { rev: cred.rev, sum: cred.sum } : null;
    let synced;
    let trimmed = 0;
    for (let tries = 0; ; tries += 1) {
      if (tries === 3) return error(409);
      const local = readProgress(localStorage, playerKey);
      let merged = remote?.data ? mergeProgress(local, remote.data) : local;
      // Grande demais: corta replays antigos aqui também (senão a próxima junção os traz de volta e envia de novo).
      if (JSON.stringify(merged).length > SOFT_MAX) ({ data: merged, dropped: trimmed } = trimReplays(merged, SOFT_MAX));
      if (canonical(merged) !== canonical(local)) writeProgress(localStorage, playerKey, merged);
      if (remote && (remote.data ? canonical(merged) === canonical(normalize(remote.data)) : remote.sum === sumOf(merged))) { cred.rev = remote.rev; synced = merged; break; }
      // Chave livre e nada além da coleção inicial: só reivindica quando houver progresso (teto de chaves do servidor)
      // ou quando a chave vai aparecer num link de desafio (claim: ninguém a reivindica antes do dono).
      if (!remote && !claim && !hasProgress(merged)) { update({ rev: 0 }); return { status: 'on', changed: false }; }
      res = await put(merged, remote ? remote.rev : 0);
      if (res.ok) { cred.rev = (await res.json()).rev; synced = merged; break; }
      if (res.status === 403) return taken();
      if (res.status !== 409) return error(res.status);
      // Mudou no meio do caminho: o 409 traz o atual (ou, na corrida de reivindicação, buscamos de novo).
      const body = await res.json();
      if (body.data) remote = body;
      else {
        res = await call('GET');
        if (res.status === 403) return taken();
        if (res.status !== 200) return error(res.status);
        remote = await res.json();
      }
    }
    // Replays cortados: aviso em lastError 'trimmed'. Eles saem do local junto (os syncs seguintes não cortam de novo),
    // então o aviso fica 7 dias em vez de sumir no próximo sync.
    const prev = credOf(playerKey)?.lastError;
    const notice = trimmed ? { code: 'trimmed', count: trimmed, at: Date.now() } : prev?.code === 'trimmed' && Date.now() - prev.at < 7 * 86400e3 ? prev : undefined;
    update({ rev: cred.rev, sum: sumOf(synced), at: Date.now(), lastError: notice });
    return { status: 'on', changed: canonical(readProgress(localStorage, playerKey)) !== before };
  } catch (thrown) {
    if (thrown instanceof SchemaError) return fail('schema', { status: 'schema', message: thrown.message });
    return { status: 'offline' }; // rede, tempo esgotado ou servidor fora: tenta no próximo evento
  }
}

let timer = null;
/** Agenda um sync (espera 2 s de calma: abrir um booster grava várias chaves seguidas). */
export function queueSync(delay = 2000) {
  clearTimeout(timer);
  timer = null;
  if (running) { dirty = true; return; } // o sync em andamento roda de novo ao terminar
  timer = setTimeout(() => { timer = null; syncNow(); }, delay);
}
setWriteHook((key) => { if (isProgressKey(key)) queueSync(); });

const KEEPALIVE_MAX = 60 * 1024; // teto do fetch keepalive (64 KiB somando os pedidos pendentes)
/** Página fechando com gravação pendente: envia já. Progresso pequeno vai num PUT keepalive (sobrevive ao fechar);
 * grande demais, só tenta o sync normal. O PUT usa o rev do último sync: se o servidor mudou, o 409 é ignorado
 * e a próxima abertura junta tudo. */
function flush() {
  if (!timer) return;
  clearTimeout(timer);
  timer = null;
  const playerKey = getPlayerKey();
  const cred = credOf(playerKey);
  if (!cred || cred.status !== 'on' || !cred.rev) { syncNow(); return; }
  const data = readProgress(localStorage, playerKey);
  const body = JSON.stringify({ data, baseRev: cred.rev });
  if (body.length > KEEPALIVE_MAX) { syncNow(); return; }
  fetch(`api/sync/${playerKey}`, { method: 'PUT', keepalive: true, cache: 'no-store', headers: { Authorization: `Bearer ${cred.secret}`, 'Content-Type': 'application/json' }, body })
    .then(async (res) => { if (res.ok) saveCred(playerKey, { ...(credOf(playerKey) ?? cred), rev: (await res.json()).rev, sum: sumOf(data), at: Date.now() }); })
    .catch(() => {});
}
if (typeof document !== 'undefined') {
  addEventListener('pagehide', flush);
  document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'hidden') flush(); });
}

/** Link de ligação: o segredo vai no fragmento (#), que não chega ao servidor, aos logs nem ao Referer. */
export function syncLink(playerKey) {
  const cred = credOf(playerKey);
  if (!cred || cred.status !== 'on') return null;
  return `${location.origin}${location.pathname.replace(/[^/]*$/, '')}index.html?player=${playerKey}#sync=${cred.secret}`;
}

/** Liga de novo (depois de desligar) ou pela primeira vez. */
export function enableSync(playerKey) {
  const cred = credOf(playerKey);
  if (cred && cred.status === 'off') saveCred(playerKey, { ...cred, status: 'on' });
  return syncNow();
}

/** Desliga neste aparelho; com wipeServer, apaga também a cópia do servidor (os outros aparelhos recriam se continuarem ligados). */
export async function disableSync(playerKey, { wipeServer = false } = {}) {
  const cred = credOf(playerKey);
  if (!cred) return true;
  if (wipeServer && cred.status === 'on') {
    try {
      const res = await api(playerKey, cred.secret, 'DELETE', null, AbortSignal.timeout(4000));
      if (!res.ok && res.status !== 404) return false;
    } catch { return false; }
  }
  saveCred(playerKey, { ...cred, status: 'off', rev: 0 });
  return true;
}

/** Troca o segredo (link vazou). Os outros aparelhos precisam abrir o link novo. */
export async function rotateSecret(playerKey) {
  let cred = credOf(playerKey);
  if (!cred || cred.status !== 'on') return false;
  // Troca anterior sem resposta: sincroniza antes (o 403 do segredo antigo promove o next), senão o next se perde.
  if (cred.next) {
    if ((await syncNow()).status !== 'on') return false;
    cred = credOf(playerKey);
    if (!cred || cred.status !== 'on') return false;
  }
  const secret = newSecret();
  // Grava o next antes do POST: se o servidor trocar e a resposta se perder, o próximo sync tenta com ele.
  saveCred(playerKey, { ...cred, next: secret });
  const settle = (fields) => { const { next, ...rest } = credOf(playerKey) ?? cred; saveCred(playerKey, { ...rest, ...fields }); };
  try {
    const res = await api(playerKey, cred.secret, 'POST', { secret }, AbortSignal.timeout(4000), '/rotate');
    if (res.status !== 204) { settle({}); return false; } // resposta do servidor: não trocou
  } catch { return false; } // sem resposta: o next fica guardado
  settle({ secret });
  return true;
}

/** Chave tomada por outro segredo: copia o progresso local para uma chave nova (que este aparelho reivindica). */
export function moveToNewKey(playerKey) {
  const next = newPlayerKey();
  writeProgress(localStorage, next, readProgress(localStorage, playerKey));
  // Direto no localStorage (sem o gancho do writeJson): nada de sync agendado para a chave antiga.
  try {
    const settings = localStorage.getItem(`rushdaily-settings:${playerKey}`);
    if (settings) localStorage.setItem(`rushdaily-settings:${next}`, settings);
    localStorage.setItem('rushdaily-player-key', next);
  } catch { /* sem armazenamento */ }
  return next;
}
