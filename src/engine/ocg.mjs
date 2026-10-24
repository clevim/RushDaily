// Ponte com o motor do EDOPro (ocgcore em WebAssembly).
// Não sabe de onde vêm os dados: quem chama passa as cartas e um leitor síncrono de scripts
// (fs no Node, cache pré-carregado no navegador).
import { OcgDuelMode, OcgLocation, OcgMessageType, OcgPosition, OcgProcessResult, OcgQueryFlags as Q } from '../vendor/ocgcore/index.js';

/**
 * Formato do desafio diário: campo completo do clássico (5 colunas, Pêndulo, zona extra) com o ritmo do Speed Duel.
 * Uma Invocação Normal por turno, como no clássico. Medido: mediana de 9 turnos, igual ao Speed Duel.
 */
export const FORMATS = {
  rapido: { flags: OcgDuelMode.MODE_MR5 | OcgDuelMode.NO_MAIN_PHASE_2, lp: 4000, hand: 4, main: 20, extra: 5, turnLimit: 20 },
  classico: { flags: OcgDuelMode.MODE_MR5, lp: 8000, hand: 5, main: 40, extra: 15, turnLimit: 40 }, // 40: corta a cauda longa (mediana 16)
  puzzle: { flags: OcgDuelMode.MODE_MR5, lp: 8000, hand: 0, main: 0, extra: 0, turnLimit: 0 }, // o script do puzzle troca regras, PV e campo
};

export const TYPE = { MONSTER: 0x1, SPELL: 0x2, TRAP: 0x4, NORMAL: 0x10, EFFECT: 0x20, FUSION: 0x40, RITUAL: 0x80, TOKEN: 0x4000, SYNCHRO: 0x2000, XYZ: 0x800000, PENDULUM: 0x1000000, LINK: 0x4000000 };
const EXTRA_TYPES = TYPE.FUSION | TYPE.SYNCHRO | TYPE.XYZ | TYPE.LINK;
export const isExtra = (card) => Boolean(card.type & EXTRA_TYPES);

/** Linha do pool (s1.json etc.) no formato que o motor lê. */
export function toCoreCard(card) {
  const setcode = BigInt(card.setcode || 0);
  const setcodes = [];
  for (let shift = 0n; shift < 64n; shift += 16n) { const code = Number((setcode >> shift) & 0xffffn); if (code) setcodes.push(code); }
  return {
    code: card.id, alias: card.alias || 0, setcodes, type: card.type, level: card.level & 0xff,
    attribute: card.attribute, race: BigInt(card.race), attack: card.atk, defense: card.def,
    lscale: (card.level >> 24) & 0xff, rscale: (card.level >> 16) & 0xff,
    link_marker: card.type & TYPE.LINK ? card.def : 0,
  };
}

function seedOf(text) {
  const words = [];
  let hash = 1469598103934665603n;
  for (let round = 0; round < 4; round += 1) {
    for (const char of `${text}#${round}`) { hash ^= BigInt(char.charCodeAt(0)); hash = (hash * 1099511628211n) & 0xffffffffffffffffn; }
    words.push(hash);
  }
  return words;
}

/**
 * Cria um duelo. decks: [{ main: [ids], extra: [ids] }, { ... }] (jogador 0 e 1).
 * puzzle: { name, script } no lugar dos decks: o script monta campo, mão e PV (Debug.*) e aux.BeginPuzzle dá a derrota no fim do turno.
 * Devolve { next(), respond(response), state, destroy() }:
 *   next() roda o motor até ele precisar de uma resposta ou o duelo acabar
 *   e devolve { events, prompt, winner } — prompt é a mensagem SELECT_* a responder.
 */
export function createDuel(lib, { seed, format = FORMATS.rapido, decks = [], puzzle = null, cards, readScript, onError = () => {} }) {
  const handle = lib.createDuel({
    flags: format.flags,
    seed: seedOf(seed),
    team1: { drawCountPerTurn: 1, startingDrawCount: format.hand, startingLP: format.lp },
    team2: { drawCountPerTurn: 1, startingDrawCount: format.hand, startingLP: format.lp },
    cardReader: (code) => { const card = cards.get(code); return card ? toCoreCard(card) : null; },
    scriptReader: (name) => readScript(name.match(/^c\d+\.lua$/) ? `official/${name}` : name),
    errorHandler: (type, text) => onError(text),
  });
  if (!handle) throw new Error('o motor não criou o duelo');
  for (const name of ['constant.lua', 'utility.lua']) lib.loadScript(handle, name, readScript(name));
  if (puzzle && !lib.loadScript(handle, puzzle.name, puzzle.script)) { lib.destroyDuel(handle); throw new Error('o motor recusou o script do puzzle'); }
  decks.forEach((deck, team) => {
    for (const [ids, location] of [[deck.main, OcgLocation.DECK], [deck.extra || [], OcgLocation.EXTRA]]) {
      for (const code of ids) lib.duelNewCard(handle, { team, duelist: 0, code, controller: team, location, sequence: 0, position: OcgPosition.FACEDOWN_DEFENSE });
    }
  });
  lib.startDuel(handle);

  let lastPrompt = null;
  const state = { turn: 0, active: 0, phase: 0, hint: 0n, lp: [format.lp, format.lp], winner: null, reason: null };
  const track = (message) => {
    switch (message.type) {
      case OcgMessageType.NEW_TURN: state.turn += 1; state.active = message.player; break;
      case OcgMessageType.NEW_PHASE: state.phase = message.phase; break;
      case OcgMessageType.HINT: if (message.hint_type === 3) state.hint = message.hint; break; // SELECTMSG: texto da próxima pergunta
      case OcgMessageType.DAMAGE: case OcgMessageType.PAY_LPCOST: state.lp[message.player] = Math.max(0, state.lp[message.player] - message.amount); break;
      case OcgMessageType.RECOVER: state.lp[message.player] += message.amount; break;
      case OcgMessageType.LPUPDATE: state.lp[message.player] = message.lp; break;
      case OcgMessageType.RELOAD_FIELD: state.lp = message.players.map((player) => player.lp); break; // puzzle: PV do script
      case OcgMessageType.WIN: state.winner = message.player; state.reason = message.reason; break;
      default:
    }
  };

  const QUERY = Q.CODE | Q.POSITION | Q.TYPE | Q.LEVEL | Q.RANK | Q.ATTACK | Q.DEFENSE | Q.BASE_ATTACK | Q.BASE_DEFENSE | Q.OVERLAY_CARD | Q.COUNTERS | Q.IS_PUBLIC | Q.LINK | Q.LSCALE | Q.RSCALE;
  const PLACES = { hand: OcgLocation.HAND, monsters: OcgLocation.MZONE, spells: OcgLocation.SZONE, grave: OcgLocation.GRAVE, banished: OcgLocation.REMOVED, extra: OcgLocation.EXTRA };

  return {
    state,
    handle,
    /**
     * Foto do campo vista pelo motor: tudo, inclusive cartas ocultas. Esconder do jogador é trabalho da interface.
     * monsters tem 7 posições (5 + 2 zonas extras); spells tem 8 (5 + campo + 2 de Pêndulo). Vazio = null.
     */
    snapshot() {
      const field = lib.duelQueryField(handle);
      return field.players.map((player, team) => {
        const side = { lp: player.lp, deck: player.deck_size };
        for (const [name, location] of Object.entries(PLACES)) {
          side[name] = lib.duelQueryLocation(handle, { flags: QUERY, controller: team, location }).map((card, sequence) => (card?.code !== undefined || card?.position ? { ...card, sequence } : null));
        }
        return side;
      });
    },
    next() {
      const events = [];
      for (;;) {
        const status = lib.duelProcess(handle);
        const messages = lib.duelGetMessage(handle);
        messages.forEach(track);
        events.push(...messages);
        // Limite de turnos: acabou o turno N, vence quem tem mais PV (empate = 2).
        if (format.turnLimit && state.turn > format.turnLimit && state.winner === null) {
          state.winner = state.lp[0] === state.lp[1] ? 2 : state.lp[0] > state.lp[1] ? 0 : 1;
          state.reason = 'turnos';
        }
        if (state.winner !== null || status === OcgProcessResult.END) return { events, prompt: null, winner: state.winner };
        if (status === OcgProcessResult.WAITING) {
          // RETRY: o motor recusou a última resposta e repete a mesma pergunta.
          const retry = messages.at(-1)?.type === OcgMessageType.RETRY;
          if (!retry) lastPrompt = messages.at(-1);
          return { events, prompt: lastPrompt, retry, winner: null };
        }
      }
    },
    respond(response) { lib.duelSetResponse(handle, response); },
    destroy() { lib.destroyDuel(handle); },
  };
}
