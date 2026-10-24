// Valida os puzzles candidatos no motor (chamado por "import_cards.py puzzles").
//   node tools/classic/puzzle-check.mjs entrada.json saida.json [threads]
// Para cada puzzle: carrega sem erro de script? chega à primeira pergunta do jogador? Depois procura uma
// sequência de respostas que vença no turno (busca em profundidade; o rival responde com a IA da arena).
// Também exporta runPuzzle() para o teste do npm (refaz a solução gravada).
import { appendFileSync, readFileSync, writeFileSync } from 'node:fs';
import { Worker, isMainThread, parentPort, workerData } from 'node:worker_threads';
import createCore, { OcgMessageType as M, OcgPosition as P, OcgResponseType as R } from '../../src/vendor/ocgcore/index.js';
import { FORMATS, createDuel } from '../../src/engine/ocg.mjs';
import { decide } from '../../src/engine/ocg-ai.mjs';

const big = (key, value) => (typeof value === 'bigint' ? `${value}n` : value);

/**
 * Duelo de puzzle vivo, parado na próxima pergunta do jogador 0 (a IA responde pelo 1).
 * feed(response) responde e anda; o estado fica em .winner / .invalid / .prompt (+ key, view, state).
 */
function openPuzzle(lib, puzzle, { cards, readScript }, errors) {
  const duel = createDuel(lib, { seed: `puzzle:${puzzle.id}`, format: FORMATS.puzzle, puzzle: { name: `${puzzle.id}.lua`, script: puzzle.script }, cards, readScript, onError: (text) => errors.push(text) });
  const memory = {};
  const live = {
    destroy() { if (!live.done) { live.done = true; duel.destroy(); } },
    advance() {
      for (let guard = 0; guard < 2000; guard += 1) {
        const result = duel.next();
        if (result.winner !== null) { live.winner = result.winner; live.destroy(); return live; }
        if (result.retry) break;
        const { prompt } = result;
        if (prompt.player === 1) { duel.respond(decide(prompt, { view: duel.snapshot(), me: 1, cards, state: duel.state, memory })); continue; }
        const view = duel.snapshot();
        Object.assign(live, { prompt, view, state: { ...duel.state }, key: JSON.stringify([view, duel.state.phase, prompt], big) });
        return live;
      }
      live.invalid = true;
      live.destroy();
      return live;
    },
    feed(response) { duel.respond(response); return live.advance(); },
  };
  return live.advance();
}

/** Roda o puzzle respondendo `prefix` pelo jogador 0. Devolve { winner } | { invalid } | { prompt, key, view, state }. */
export function runPuzzle(lib, puzzle, env, prefix, errors = []) {
  let live = openPuzzle(lib, puzzle, env, errors);
  for (const response of prefix) { if (live.done) break; live = live.feed(response); }
  const { winner, invalid, prompt, key, view, state } = live;
  live.destroy();
  return live.winner !== undefined ? { winner } : invalid || live.done && !prompt ? { invalid: true } : { prompt, key, view, state };
}

function combos(n, min, max, limit = 40) {
  const out = [];
  const walk = (start, pick) => {
    if (out.length >= limit) return;
    if (pick.length >= min && pick.length) out.push([...pick]);
    if (pick.length === max) return;
    for (let i = start; i < n; i += 1) { pick.push(i); walk(i + 1, pick); pick.pop(); }
  };
  walk(0, []);
  return out.sort((a, b) => a.length - b.length);
}

/** Respostas a tentar para uma pergunta (as que não mudam o resultado ficam com a escolha da IA). */
export function options(prompt, ctx) {
  const ai = () => [decide(prompt, { ...ctx, me: 0, memory: {} })];
  switch (prompt.type) {
    case M.SELECT_IDLECMD: {
      const out = [];
      // Baixar cartas não ajuda a vencer no mesmo turno: a busca ignora (o jogador pode, claro).
      for (const [action, list] of [[5, prompt.activates], [1, prompt.special_summons], [0, prompt.summons], [2, prompt.pos_changes]]) list.forEach((_, index) => out.push({ type: R.SELECT_IDLECMD, action, index }));
      if (prompt.to_bp) out.push({ type: R.SELECT_IDLECMD, action: 6, index: null });
      return out;
    }
    case M.SELECT_BATTLECMD: {
      const out = prompt.attacks.map((_, index) => ({ type: R.SELECT_BATTLECMD, action: 1, index }));
      prompt.chains.forEach((_, index) => out.push({ type: R.SELECT_BATTLECMD, action: 0, index }));
      if (prompt.to_m2) out.push({ type: R.SELECT_BATTLECMD, action: 2, index: null });
      return out;
    }
    case M.SELECT_CHAIN: return [...prompt.selects.map((_, index) => ({ type: R.SELECT_CHAIN, index })), ...(prompt.forced ? [] : [{ type: R.SELECT_CHAIN, index: null }])];
    case M.SELECT_EFFECTYN: return [true, false].map((yes) => ({ type: R.SELECT_EFFECTYN, yes }));
    case M.SELECT_YESNO: return [true, false].map((yes) => ({ type: R.SELECT_YESNO, yes }));
    case M.SELECT_OPTION: return prompt.options.map((_, index) => ({ type: R.SELECT_OPTION, index }));
    case M.SELECT_CARD: case M.SELECT_TRIBUTE: {
      const type = prompt.type === M.SELECT_CARD ? R.SELECT_CARD : R.SELECT_TRIBUTE;
      return combos(prompt.selects.length, Math.max(prompt.min, 1), prompt.max).map((indicies) => ({ type, indicies }));
    }
    case M.SELECT_UNSELECT_CARD: return [...prompt.select_cards.map((_, index) => ({ type: R.SELECT_UNSELECT_CARD, index })), ...(prompt.can_finish ? [{ type: R.SELECT_UNSELECT_CARD, index: null }] : [])];
    case M.SELECT_POSITION: return [P.FACEUP_ATTACK, P.FACEDOWN_DEFENSE].filter((bit) => prompt.positions & bit).map((position) => ({ type: R.SELECT_POSITION, position }));
    case M.SELECT_SUM: return combos(prompt.selects.length, 1, prompt.selects.length, 30).map((indicies) => ({ type: R.SELECT_SUM, indicies }));
    case M.ANNOUNCE_NUMBER: return prompt.options.map((_, value) => ({ type: R.ANNOUNCE_NUMBER, value }));
    default: return ai();
  }
}

/** Busca em profundidade com memória de estados já vistos. Devolve a lista de respostas que vence, ou null. */
export function solve(lib, puzzle, env, { budget = 6000, ms = 20000 } = {}) {
  const seen = new Set();
  const stop = Date.now() + ms;
  let nodes = 0;
  // live: duelo já parado em `prefix`. O último filho reaproveita o duelo; os outros refazem do começo
  // (criar um duelo custa ~20 ms, quase tudo carregando os scripts).
  const walk = (prefix, live) => {
    if (nodes++ > budget || Date.now() > stop) { live.destroy(); return null; }
    if (live.winner === 0) return prefix;
    if (live.winner !== undefined || live.invalid || live.state.turn > 1) { live.destroy(); return null; }
    // Só compara estados com a corrente vazia (o alvo de um efeito na corrente não aparece no campo).
    if (live.prompt.type === M.SELECT_IDLECMD || live.prompt.type === M.SELECT_BATTLECMD) {
      if (seen.has(live.key)) { live.destroy(); return null; }
      seen.add(live.key);
    }
    const list = options(live.prompt, { view: live.view, cards: env.cards, state: live.state });
    for (const [index, response] of list.entries()) {
      const next = [...prefix, response];
      const child = index === list.length - 1 ? live.feed(response) : (() => { let fresh = openPuzzle(lib, puzzle, env, []); for (const item of next) { if (fresh.done) break; fresh = fresh.feed(item); } return fresh; })();
      const found = walk(next, child);
      if (found) { live.destroy(); return found; }
    }
    live.destroy();
    return null;
  };
  return { solution: walk([], openPuzzle(lib, puzzle, env, [])), nodes };
}

function checkAll(puzzles, rows, log, { known = {}, search = false, budget = 12000, ms = 120000 } = {}) {
  const root = new URL('../../', import.meta.url);
  const tokens = JSON.parse(readFileSync(new URL('src/data/classic/tokens.json', root)));
  const cards = new Map([...tokens, ...Object.values(rows)].map((card) => [card.id, card]));
  const scripts = new URL('cache/CardScripts/', import.meta.url);
  const cache = new Map(); // o motor pede os mesmos scripts a cada duelo refeito
  const readScript = (name) => {
    if (!cache.has(name)) { try { cache.set(name, readFileSync(new URL(name, scripts), 'utf-8')); } catch { cache.set(name, null); } }
    return cache.get(name);
  };
  return createCore({ sync: true }).then((lib) => {
    const results = {};
    for (const puzzle of puzzles) {
      const errors = [];
      let first;
      try { first = runPuzzle(lib, puzzle, { cards, readScript }, [], errors); } catch (error) { errors.push(String(error)); }
      const loads = Boolean(first?.prompt) && !errors.length;
      // Solução já conhecida (tools/classic/puzzle-solutions.json) só é conferida: a segunda execução é rápida.
      const revive = (key, value) => (typeof value === 'string' && /^\d+n$/.test(value) ? BigInt(value.slice(0, -1)) : value);
      const cached = known[puzzle.id] && JSON.parse(JSON.stringify(known[puzzle.id]), revive);
      const reused = loads && cached && runPuzzle(lib, puzzle, { cards, readScript }, cached).winner === 0;
      const found = reused ? { solution: cached, nodes: 0 } : loads && search ? solve(lib, puzzle, { cards, readScript }, { budget, ms }) : { solution: null, nodes: 0 };
      // Só vale se a solução vencer de novo sem nenhum erro de script.
      const check = [];
      const solved = Boolean(found.solution) && runPuzzle(lib, puzzle, { cards, readScript }, found.solution, check).winner === 0 && !check.length;
      results[puzzle.id] = { loads, errors: errors.slice(0, 3), solved, nodes: found.nodes, solution: solved ? JSON.parse(JSON.stringify(found.solution, big)) : null };
      log({ result: puzzle.id, data: results[puzzle.id], fresh: solved && !reused });
      log(`${solved ? 'OK ' : loads ? '-- ' : 'ERR'} ${puzzle.id} (${found.nodes} nós${solved ? `, ${found.solution.length} respostas` : ''})${errors.length ? ` ${errors[0].slice(0, 80)}` : ''}`);
    }
    return results;
  });
}

// Linha de comando: divide os puzzles entre threads (cada duelo refeito custa ~20 ms; a busca é o gargalo).
// opts.meta: para tudo ao juntar tantos puzzles com vitória (os já conhecidos vêm primeiro na entrada).
if (isMainThread && import.meta.url === `file://${process.argv[1]}`) {
  const [input, output, threads = '8'] = process.argv.slice(2);
  const { puzzles, cards: rows, options: opts = {} } = JSON.parse(readFileSync(input, 'utf-8'));
  const parts = Array.from({ length: Number(threads) }, (_, n) => puzzles.filter((_, i) => i % Number(threads) === n));
  const results = {};
  const workers = [];
  await new Promise((resolve, reject) => {
    let running = parts.length;
    const stop = () => { workers.forEach((worker) => worker.terminate()); resolve(); };
    for (const part of parts) {
      const worker = new Worker(new URL(import.meta.url), { workerData: { puzzles: part, rows, opts } });
      workers.push(worker);
      worker.on('message', (message) => {
        if (typeof message === 'string') { console.log(message); return; }
        if (message.done) { if (--running === 0) resolve(); return; }
        results[message.result] = message.data;
        // Cada vitória nova vai para o disco na hora: busca interrompida não perde o que achou.
        if (message.fresh) appendFileSync(new URL('cache/puzzle-found.jsonl', import.meta.url), `${JSON.stringify({ found: message.result, solution: message.data.solution })}\n`);
        if (opts.meta && Object.values(results).filter((item) => item.solved).length >= opts.meta) { console.log(`meta de ${opts.meta} puzzles atingida`); stop(); }
      });
      worker.on('error', reject);
    }
  });
  writeFileSync(output, JSON.stringify(results));
} else if (!isMainThread) {
  await checkAll(workerData.puzzles, workerData.rows, (line) => parentPort.postMessage(line), workerData.opts);
  parentPort.postMessage({ done: true });
}
