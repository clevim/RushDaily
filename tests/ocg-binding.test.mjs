import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import createCore, { OcgLocation, OcgQueryFlags as Q } from '../src/vendor/ocgcore/index.js';
import { FORMATS, createDuel } from '../src/engine/ocg.mjs';
import { PATCHES, aplicar } from '../tools/setup/patch-ocgcore.mjs';

const root = new URL('../', import.meta.url);
const readScript = (name) => { try { return readFileSync(new URL(`src/vendor/card-scripts/${name}`, root), 'utf-8'); } catch { return null; } };
const lib = await createCore({ sync: true });

test('patch do ocgcore: todas as correções (TYPE, campo desconhecido, COUNTERS, eof, SORT_CARD) estão no vendor', () => {
  const { log } = aplicar(readFileSync(new URL('src/vendor/ocgcore/index.js', root), 'utf8'));
  assert.equal(log.length, PATCHES.length);
  assert.ok(log.every((linha) => linha.endsWith('já aplicado')), log.join('; '));
});

test('patch do ocgcore: falha alto quando a âncora some (pacote em outra versão)', () => {
  assert.throws(() => aplicar('código qualquer'), /âncora/);
});

test('COUNTERS: o motor devolve { tipo: quantidade } e não o contrário', () => {
  // Marcador de Magia (0x1) com 3 unidades num monstro: a consulta troca chave e valor se o patch faltar.
  const script = `Debug.ReloadFieldBegin(DUEL_ATTACK_FIRST_TURN+DUEL_SIMPLE_AI,2)
Debug.SetPlayerInfo(0,8000,0,0)
Debug.SetPlayerInfo(1,8000,0,0)
local c=Debug.AddCard(89631139,0,0,LOCATION_MZONE,0,POS_FACEUP_ATTACK)
c:EnableCounterPermit(0x1)
c:AddCounter(0x1,3)
Debug.ReloadFieldEnd()
aux.BeginPuzzle()`;
  const cards = new Map([[89631139, { id: 89631139, alias: 0, setcode: '0', type: 17, atk: 3000, def: 2500, level: 8, race: 1n, attribute: 16, name: 'Dragão', desc: '' }]]);
  const duel = createDuel(lib, { seed: 'contadores', format: FORMATS.puzzle, puzzle: { name: 'contadores.lua', script }, cards, readScript });
  duel.next();
  const [monstro] = lib.duelQueryLocation(duel.handle, { flags: Q.CODE | Q.COUNTERS, controller: 0, location: OcgLocation.MZONE });
  assert.deepEqual(monstro.counters, { 1: 3 });
  duel.destroy();
});
