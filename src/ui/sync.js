// Cliente da sincronização entre aparelhos (servidor em server/server.mjs, desenho em docs/sync/README.md).
// Importar este módulo liga o gancho: gravar uma chave de progresso (writeJson) agenda um sync.
import { SchemaError, canonical, isProgressKey, mergeProgress, normalize, readProgress, writeProgress } from './sync-merge.js';
import { getPlayerKey, newPlayerKey, readJson, setWriteHook, writeJson } from './common.js';

const SECRET = /^[A-Za-z0-9_-]{22,128}$/;
export const credKey = (playerKey) => `rushdaily-sync:${playerKey}`;
/** { secret, rev, status: 'on' | 'off' | 'taken', at } deste aparelho. Nunca vai no corpo nem em log. */
export const credOf = (playerKey) => {
  const cred = readJson(credKey(playerKey), null);
  return cred && SECRET.test(cred.secret || '') ? cred : null;
};
const saveCred = (playerKey, cred) => writeJson(credKey(playerKey), cred);

function newSecret() {
  const bytes = crypto.getRandomValues(new Uint8Array(32)); // 256 bits
  return btoa(String.fromCharCode(...bytes)).replaceAll('+', '-').replaceAll('/', '_').replace(/=+$/, '');
}

const api = (playerKey, secret, method, body, signal, path = '') => fetch(`api/sync/${playerKey}${path}`, {
  method,
  signal,
  cache: 'no-store',
  headers: { Authorization: `Bearer ${secret}`, ...(body ? { 'Content-Type': 'application/json' } : {}) },
  body: body ? JSON.stringify(body) : undefined,
});

let running = null;
/**
 * Busca, junta, grava e envia. Na primeira vez com internet gera o segredo e reivindica a chave.
 * Nunca lança: devolve { status: 'on' | 'off' | 'taken' | 'offline' | 'error' | 'schema', changed }.
 */
export function syncNow(options) {
  running ||= run(options).finally(() => { running = null; });
  return running;
}

async function run({ timeout = 4000 } = {}) {
  const playerKey = getPlayerKey();
  let cred = credOf(playerKey);
  if (cred && cred.status !== 'on') return { status: cred.status };
  if (navigator.onLine === false) return { status: 'offline' };
  if (!cred) { cred = { secret: newSecret(), rev: 0, status: 'on' }; saveCred(playerKey, cred); } // grava antes: uma queda não troca o segredo
  const signal = AbortSignal.timeout(timeout);
  const call = (method, body, path) => api(playerKey, cred.secret, method, body, signal, path);
  const taken = () => { saveCred(playerKey, { ...cred, status: 'taken' }); return { status: 'taken' }; };
  try {
    const before = canonical(readProgress(localStorage, playerKey));
    let res = await call('GET');
    if (res.status === 403) return taken();
    if (res.status >= 500) return { status: 'offline' }; // proxy sem o servidor de sync (502) ou servidor cheio
    if (res.status !== 200 && res.status !== 404) return { status: 'error', code: res.status };
    let remote = res.status === 200 ? await res.json() : null;
    for (let tries = 0; ; tries += 1) {
      if (tries === 3) return { status: 'error', code: 409 };
      const local = readProgress(localStorage, playerKey);
      const merged = remote ? mergeProgress(local, remote.data) : local;
      if (canonical(merged) !== canonical(local)) writeProgress(localStorage, playerKey, merged);
      if (remote && canonical(merged) === canonical(normalize(remote.data))) { cred.rev = remote.rev; break; }
      res = await call('PUT', { data: merged, baseRev: remote ? remote.rev : 0 });
      if (res.ok) { cred.rev = (await res.json()).rev; break; }
      if (res.status === 403) return taken();
      if (res.status !== 409) return { status: 'error', code: res.status };
      // Mudou no meio do caminho: o 409 traz o atual (ou, na corrida de reivindicação, buscamos de novo).
      const body = await res.json();
      if (body.data) remote = body;
      else {
        res = await call('GET');
        if (res.status === 403) return taken();
        if (res.status !== 200) return { status: 'error', code: res.status };
        remote = await res.json();
      }
    }
    saveCred(playerKey, { ...cred, at: Date.now() });
    return { status: 'on', changed: canonical(readProgress(localStorage, playerKey)) !== before };
  } catch (error) {
    if (error instanceof SchemaError) return { status: 'schema', message: error.message };
    return { status: 'offline' }; // rede, tempo esgotado ou servidor fora: tenta no próximo evento
  }
}

let timer = null;
/** Agenda um sync (espera 2 s de calma: abrir um booster grava várias chaves seguidas). */
export function queueSync(delay = 2000) {
  clearTimeout(timer);
  timer = setTimeout(() => { syncNow(); }, delay);
}
setWriteHook((key) => { if (isProgressKey(key)) queueSync(); });

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
  const cred = credOf(playerKey);
  if (!cred || cred.status !== 'on') return false;
  const secret = newSecret();
  try {
    const res = await api(playerKey, cred.secret, 'POST', { secret }, AbortSignal.timeout(4000), '/rotate');
    if (res.status !== 204) return false;
  } catch { return false; }
  saveCred(playerKey, { ...cred, secret });
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
