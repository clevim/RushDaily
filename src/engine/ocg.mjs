// Ponte com o motor do EDOPro (ocgcore em WebAssembly).
// Não sabe de onde vêm os dados: quem chama passa as cartas e um leitor síncrono de scripts
// (fs no Node, cache pré-carregado no navegador).
import { OcgDuelMode, OcgLocation, OcgMessageType, OcgPosition, OcgProcessResult, OcgQueryFlags as Q } from '../vendor/ocgcore/index.js';

/**
 * Formato do desafio diário: campo completo do clássico (5 colunas, Pêndulo, zona extra) com o ritmo do Speed Duel.
 * Uma Invocação Normal por turno, como no clássico. Medido: mediana de 9 turnos, igual ao Speed Duel.
 */
// DUEL_EXTRA_DECK_RITUAL do constant.lua: faz parte do DUEL_MODE_RUSH, mas falta no OcgDuelMode.MODE_RUSH do binding.
// Com ela os Monstros de Ritual ficam no Deck Adicional e proc_ritual.lua invoca de lá. Flags do binding são BigInt (64 bits).
const EXTRA_DECK_RITUAL = 0x800000000n;

export const FORMATS = {
  // O motor não embaralha o deck no início (o servidor do EDOPro faz isso antes): shuffle embaralha pela seed do duelo.
  // createDuel aceita shuffle: false para repetir partidas e replays gravados antes do embaralhamento.
  rapido: { flags: OcgDuelMode.MODE_MR5 | OcgDuelMode.NO_MAIN_PHASE_2, lp: 4000, hand: 4, main: 20, extra: 5, turnLimit: 20 },
  classico: { flags: OcgDuelMode.MODE_MR5, lp: 8000, hand: 5, main: 40, extra: 15, turnLimit: 40, shuffle: true }, // 40: corta a cauda longa (mediana 16)
  puzzle: { flags: OcgDuelMode.MODE_MR5, lp: 8000, hand: 0, main: 0, extra: 0, turnLimit: 0 }, // o script do puzzle troca regras, PV e campo
  // Rush Duel oficial: deck de 40 a 60, adicional até 15 (Fusão e Ritual), mão inicial 4 e compra até ter 5 (DRAW_UNTIL_5),
  // campo de 3 colunas, sem Fase de Apoio nem Fase Principal 2, Invocações Normais ilimitadas. Scripts em card-scripts/rush/.
  rush: { flags: OcgDuelMode.MODE_RUSH | EXTRA_DECK_RITUAL, lp: 8000, hand: 4, main: 40, extra: 15, turnLimit: 40, scripts: 'rush', shuffle: true },
};

/**
 * Zonas válidas no campo de 3 colunas (THREE_COLUMNS_FIELD, formato rush): o motor bloqueia as colunas das pontas,
 * então só as sequences 1, 2 e 3 existem em MZONE e em SZONE (as 0 e 4 ficam sempre vazias). SZONE 5 é a Magia de Campo.
 * Sem zonas extras de monstro (MZONE 5/6) nem de Pêndulo (SZONE 6/7).
 */
export const RUSH_ZONES = { monsters: [1, 2, 3], spells: [1, 2, 3], field: 5 };

export const TYPE = { MONSTER: 0x1, SPELL: 0x2, TRAP: 0x4, NORMAL: 0x10, EFFECT: 0x20, FUSION: 0x40, RITUAL: 0x80, TOKEN: 0x4000, SYNCHRO: 0x2000, XYZ: 0x800000, PENDULUM: 0x1000000, LINK: 0x4000000 };
const EXTRA_TYPES = TYPE.FUSION | TYPE.SYNCHRO | TYPE.XYZ | TYPE.LINK;
/** Vai no Deck Adicional? Com format de Rituais no Adicional (FORMATS.rush), os Monstros de Ritual também; no clássico, não. */
export const isExtra = (card, format) => Boolean(card.type & EXTRA_TYPES
  || (card.type & TYPE.MONSTER && card.type & TYPE.RITUAL && (format?.flags ?? 0n) & EXTRA_DECK_RITUAL));

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

/** Embaralha (Fisher-Yates) uma cópia da lista com um gerador fixo pela seed: mesma seed, mesma ordem nos dois aparelhos. */
export function shuffled(list, seed) {
  let value = Number(seedOf(seed)[0] & 0xffffffffn) || 1;
  const random = () => { value ^= value << 13; value ^= value >>> 17; value ^= value << 5; return (value >>> 0) / 4294967296; };
  const out = [...list];
  for (let i = out.length - 1; i > 0; i -= 1) { const j = Math.floor(random() * (i + 1)); [out[i], out[j]] = [out[j], out[i]]; }
  return out;
}

/**
 * Cria um duelo. decks: [{ main: [ids], extra: [ids] }, { ... }] (jogador 0 e 1).
 * puzzle: { name, script } no lugar dos decks: o script monta campo, mão e PV (Debug.*) e aux.BeginPuzzle dá a derrota no fim do turno.
 * lp: [PV do time 0, PV do time 1] no lugar do format.lp (ex.: rival com menos PV no desafio diário).
 * hands: [mão inicial do time 0, do time 1] no lugar do format.hand (ex.: rival do Caos com 1 carta a mais).
 * skills: [{ team, code }] cartas de Skill (proc_skill.lua) postas no deck antes do início; o script tira elas do duelo.
 * Devolve { next(), respond(response), state, destroy() }:
 *   next() roda o motor até ele precisar de uma resposta ou o duelo acabar
 *   e devolve { events, prompt, winner } — prompt é a mensagem SELECT_* a responder.
 */
export function createDuel(lib, { seed, format = FORMATS.rapido, decks = [], puzzle = null, lp = null, skills = [], hands = null, shuffle = format.shuffle, cards, readScript, onError = () => {} }) {
  const startLp = lp || [format.lp, format.lp];
  let aliases = null;
  const aliasOf = (code) => {
    if (!aliases) { aliases = new Map(); for (const card of cards.values()) if (card.alias && !cards.has(card.alias) && !aliases.has(card.alias)) aliases.set(card.alias, card); }
    return aliases.get(code);
  };
  const handle = lib.createDuel({
    flags: format.flags,
    seed: seedOf(seed),
    team1: { drawCountPerTurn: 1, startingDrawCount: hands?.[0] ?? format.hand, startingLP: startLp[0] },
    team2: { drawCountPerTurn: 1, startingDrawCount: hands?.[1] ?? format.hand, startingLP: startLp[1] },
    cardReader: (code) => {
      const card = cards.get(code);
      if (card) return toCoreCard(card);
      // Código que só existe como alias (ex.: script Rush que declara a carta clássica "X-Head Cannon"): usa a carta que aponta para ele.
      const twin = aliasOf(code);
      return twin ? { ...toCoreCard(twin), code, alias: 0 } : null;
    },
    // Script de carta (cNNN.lua) vem da pasta do formato: official/ (padrão) ou rush/.
    scriptReader: (name) => readScript(name.match(/^c\d+\.lua$/) ? `${format.scripts || 'official'}/${name}` : name),
    errorHandler: (type, text) => onError(text),
  });
  if (!handle) throw new Error('o motor não criou o duelo');
  for (const name of ['constant.lua', 'utility.lua']) lib.loadScript(handle, name, readScript(name));
  if (puzzle && !lib.loadScript(handle, puzzle.name, puzzle.script)) { lib.destroyDuel(handle); throw new Error('o motor recusou o script do puzzle'); }
  decks.forEach((deck, team) => {
    const main = shuffle ? shuffled(deck.main, `${seed}:deck:${team}`) : deck.main;
    for (const [ids, location] of [[main, OcgLocation.DECK], [deck.extra || [], OcgLocation.EXTRA]]) {
      for (const code of ids) lib.duelNewCard(handle, { team, duelist: 0, code, controller: team, location, sequence: 0, position: OcgPosition.FACEDOWN_DEFENSE });
    }
  });
  for (const { team, code } of skills) lib.duelNewCard(handle, { team, duelist: 0, code, controller: team, location: OcgLocation.DECK, sequence: 0, position: OcgPosition.FACEDOWN_DEFENSE });
  lib.startDuel(handle);

  let lastPrompt = null;
  let promptHint = 0n; // dica da pergunta respondida: volta se o motor recusar (RETRY) e repetir a mesma pergunta
  // marks: o que cada zona fez neste turno ("controlador:local:sequência"), para a interface explicar por que uma carta
  // está sem ação (Invocada/baixada agora, já mudou de posição, já atacou). source: carta cujo efeito está pedindo a escolha.
  const freshMarks = () => ({ summoned: new Set(), set: new Set(), moved: new Set(), attacked: new Set() });
  const state = { turn: 0, active: 0, phase: 0, hint: 0n, lp: [...startLp], winner: null, reason: null, marks: freshMarks(), source: null };
  const at = (loc) => `${loc.controller}:${loc.location}:${loc.sequence}`;
  const chainCodes = [];
  const track = (message) => {
    switch (message.type) {
      case OcgMessageType.NEW_TURN: state.turn += 1; state.active = message.player; state.marks = freshMarks(); break;
      case OcgMessageType.SUMMONING: case OcgMessageType.SPSUMMONING: state.marks.summoned.add(at(message)); break;
      case OcgMessageType.FLIPSUMMONING: state.marks.moved.add(at(message)); break; // Invocar por Virada conta como a mudança do turno
      case OcgMessageType.SET: state.marks.set.add(at(message)); break;
      case OcgMessageType.ATTACK: state.marks.attacked.add(at(message.card)); break;
      case OcgMessageType.MOVE: if (message.from.location !== message.to.location) for (const marks of Object.values(state.marks)) marks.delete(at(message.from)); break;
      case OcgMessageType.CHAINING: chainCodes.push(message.code); break;
      case OcgMessageType.CHAIN_SOLVING: state.source = chainCodes[message.chain_size - 1] ?? null; break;
      case OcgMessageType.CHAIN_END: chainCodes.length = 0; state.source = null; break;
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
          else state.hint = promptHint;
          return { events, prompt: lastPrompt, retry, winner: null };
        }
      }
    },
    // A dica (SELECTMSG) vale só para a pergunta seguinte, como no cliente do EDOPro: muitos scripts Rush fazem
    // Select sem Duel.Hint, e a dica velha virava o título errado (ex.: "devolver ao Deck" ao escolher o que destruir)
    // e enganava a IA sobre custo ou ganho.
    respond(response) {
      promptHint = state.hint;
      state.hint = 0n;
      const prompt = lastPrompt;
      if (prompt?.type === OcgMessageType.SELECT_IDLECMD || prompt?.type === OcgMessageType.SELECT_BATTLECMD) {
        // Ativou agora: custos e alvos são pedidos por esta carta. Invocar, atacar ou passar: ninguém.
        const idle = prompt.type === OcgMessageType.SELECT_IDLECMD;
        state.source = (idle ? response.action === 5 && prompt.activates[response.index] : response.action === 0 && prompt.chains[response.index])?.code ?? null;
        if (idle && response.action === 2 && prompt.pos_changes[response.index]) state.marks.moved.add(at(prompt.pos_changes[response.index]));
      } else if (prompt?.type === OcgMessageType.SELECT_CHAIN && response.index !== null && prompt.selects[response.index]) state.source = prompt.selects[response.index].code;
      lib.duelSetResponse(handle, response);
    },
    destroy() { lib.destroyDuel(handle); },
  };
}
