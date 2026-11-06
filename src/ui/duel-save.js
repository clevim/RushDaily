// Partida salva do desafio do dia e tentativas: regras puras (sem DOM), usadas por duel.js, home.js e testes.
import { GEN_VERSION } from '../engine/daily-generator.mjs';

/**
 * Save do duelo (v2: respostas do motor; gen: versão do gerador de decks).
 * Sem "gen" ou com outro valor, o deck do dia já não é o mesmo: descarta. stale = havia partida em andamento perdida.
 */
export function resumable(raw, gen = GEN_VERSION) {
  if (!raw || typeof raw !== 'object') return { saved: null, stale: false };
  if (raw.v === 2 && raw.gen === gen) return { saved: raw, stale: false };
  return { saved: null, stale: Boolean(raw.responses?.length) && !raw.done };
}

/** A tela inicial oferece "Continuar o duelo" só para partida válida, começada e não terminada. */
export const canContinue = (raw, gen = GEN_VERSION) => {
  const { saved } = resumable(raw, gen);
  return Boolean(saved?.responses?.length) && !saved.done;
};

/**
 * Tentativas do dia por "dia~dificuldade": { tries, winTurn } (winTurn = turno da 1ª vitória).
 * Fica numa chave só do aparelho (rushdaily-attempts:<jogador>), fora do histórico sincronizado.
 */
export function recordAttempt(attempts, slot, won, turn) {
  const old = attempts?.[slot] || {};
  const entry = { tries: (old.tries || 0) + 1, ...(old.winTurn ? { winTurn: old.winTurn } : won ? { winTurn: turn } : {}) };
  return { ...(attempts || {}), [slot]: entry };
}
