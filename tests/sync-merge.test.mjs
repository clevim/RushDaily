import test from 'node:test';
import assert from 'node:assert/strict';
import { SCHEMA_VERSION, SchemaError, mergeProgress, normalize, readProgress, writeProgress } from '../src/ui/sync-merge.js';

const pack = (openedAt, tier, ...ids) => ({ openedAt, seed: 's', tier, cards: ids.map((id) => ({ id, foil: null, back: 'rubi', rare: false })) });
const base = { v: 1, history: { '2026-10-01': 'win' }, collection: { 10: 1, 20: 1 }, boosters: { '2026-10-01': pack('2026-10-01T10:00:00Z', 'common', 10, 20) }, pity: 1 };

test('pity soma o luck dos pacotes sem sorte (Ouro na Caos conta 4) e o pacote antigo sem luck vale a regra de antes', () => {
  const phone = { ...base, boosters: { ...base.boosters, '2026-10-02': { ...pack('2026-10-02T09:00:00Z', 'gold', 10), luck: 4 } } };
  const pc = { ...base, boosters: { ...base.boosters, '2026-10-03': { ...pack('2026-10-03T09:00:00Z', 'gold', 20), luck: 3 } } };
  assert.equal(mergeProgress(phone, pc).pity, 8); // 3 + 4 + o comum antigo (1)
  const lucky = { ...base, boosters: { ...base.boosters, '2026-10-02': { ...pack('2026-10-02T09:00:00Z', 'galaxy', 10), luck: 0 } } };
  assert.equal(mergeProgress(lucky, lucky).pity, 0);
  assert.equal(normalize({ ...lucky, boosters: { '2026-10-02': { ...pack('x', 'gold', 10), luck: 99 } } }).boosters['2026-10-02'].luck, undefined, 'luck fora de 0..4 é descartado');
});

test('dois aparelhos abrindo boosters diferentes: coleção soma, pity é derivado', () => {
  const phone = { ...base, history: { ...base.history, '2026-10-02': 'win' }, collection: { 10: 2, 20: 1 }, boosters: { ...base.boosters, '2026-10-02': pack('2026-10-02T09:00:00Z', 'common', 10) }, pity: 2 };
  const pc = { ...base, history: { ...base.history, '2026-10-03': 'win' }, collection: { 10: 2, 20: 1, 30: 1 }, boosters: { ...base.boosters, '2026-10-03': pack('2026-10-03T09:00:00Z', 'gold', 10, 30) }, pity: 0 };
  const merged = mergeProgress(phone, pc);
  assert.deepEqual(merged.collection, { 10: 3, 20: 1, 30: 1 }); // o maior daria 10: 2 e perderia uma cópia
  assert.deepEqual(Object.keys(merged.boosters).sort(), ['2026-10-01', '2026-10-02', '2026-10-03']);
  assert.equal(merged.pity, 0); // o último pacote (dia 3) foi Ouro
  assert.deepEqual(mergeProgress(merged, merged).collection, merged.collection, 'juntar de novo não duplica');
  assert.deepEqual(mergeProgress(pc, phone).collection, merged.collection, 'simétrico');
});

test('mesmo dia aberto nos dois: fica o primeiro pacote e a recompensa pendente some', () => {
  const a = { ...base, boosters: { '2026-10-05': pack('2026-10-05T08:00:00Z', 'common', 10) }, collection: { 10: 2 } };
  const b = { ...base, boosters: { '2026-10-05': pack('2026-10-05T09:00:00Z', 'silver', 40) }, collection: { 10: 1, 40: 1 }, rewards: { '2026-10-06': { seed: 'x', pending: true } } };
  const c = { ...base, rewards: { '2026-10-05': { seed: 'booster:2026-10-05:K', difficulty: 'duelist', pending: true } } };
  const merged = mergeProgress(mergeProgress(a, b), c);
  assert.equal(merged.boosters['2026-10-05'].tier, 'common');
  assert.ok(merged.collection[10] >= 2 && merged.collection[40] === 1, 'nenhuma carta some');
  assert.deepEqual(Object.keys(merged.rewards), ['2026-10-06']);
});

test('histórico: vitória vence derrota; PvP une sem repetir', () => {
  const duel = { date: '2026-10-02', vs: 'ABC123', result: 'win', turns: 7, lp: 1200 };
  const merged = mergeProgress({ v: 1, history: { '2026-10-02': 'loss' }, pvp: [duel] }, { v: 1, history: { '2026-10-02': 'win', '2026-10-03': 'draw' }, pvp: [{ ...duel, date: '2026-10-04' }, duel] });
  assert.deepEqual(merged.history, { '2026-10-02': 'win', '2026-10-03': 'draw' });
  assert.deepEqual(merged.pvp.map((item) => item.date), ['2026-10-04', '2026-10-02']);
});

test('deck editado nos dois: vence o mais novo; apagado vira lápide; editado depois de apagado volta', () => {
  const deck = (id, name, updatedAt) => ({ id, name, main: [10], extra: [], updatedAt });
  const phone = { v: 1, decks: { active: 'd1', activeAt: 5, list: [deck('d1', 'Celular', 300), deck('d2', 'Velho', 100)], deleted: {} } };
  const pc = { v: 1, decks: { active: 'd3', activeAt: 9, list: [deck('d1', 'PC', 200), deck('d3', 'Novo', 250)], deleted: { d2: 150 } } };
  const merged = mergeProgress(phone, pc, 1000);
  assert.deepEqual(merged.decks.list.map((item) => `${item.id}:${item.name}`), ['d1:Celular', 'd3:Novo']);
  assert.equal(merged.decks.active, 'd3');
  assert.equal(merged.decks.deleted.d2, 150);
  const revived = mergeProgress({ v: 1, decks: { list: [deck('d2', 'Editado', 400)] } }, merged, 1000);
  assert.ok(revived.decks.list.some((item) => item.id === 'd2'));
  assert.equal(mergeProgress(merged, {}, 200 * 864e5).decks.deleted.d2, undefined, 'lápide velha é podada');
});

test('Coração usado num aparelho fica usado nos dois; peça recuperada num e vencida no outro', () => {
  const merged = mergeProgress({ v: 1, heartUsed: ['2026-08'], recover: { '2026-10-04': 'p1' } }, { v: 1, heartUsed: ['2026-09'], history: { '2026-10-04': 'win' } });
  assert.deepEqual(merged.heartUsed, ['2026-08', '2026-09']);
  assert.equal(merged.history['2026-10-04'], 'win');
  assert.equal(merged.recover['2026-10-04'], 'p1');
  const pieces = new Set([...Object.keys(merged.history), ...Object.keys(merged.recover)]);
  assert.equal(pieces.size, 1, 'o dia conta uma peça só');
});

test('esquema antigo é aceito; mais novo é recusado; lixo é descartado', () => {
  const merged = mergeProgress({ history: { '2026-10-01': 'win' }, decks: { active: 'd1', list: [{ id: 'd1', name: 'X', main: [10] }] } }, null);
  assert.equal(merged.v, SCHEMA_VERSION);
  assert.equal(merged.decks.list[0].updatedAt, 0);
  assert.throws(() => mergeProgress({ v: SCHEMA_VERSION + 1 }, {}), SchemaError);
  const clean = normalize({ v: 1, history: { 'x"><img': 'win', '2026-13-01': 'win' }, pvp: [{ date: '2026-10-01', vs: '<b>' }], collection: { abc: 3, 10: -1, 20: 2 }, decks: { list: [{ id: '"><x', name: 'a' }] }, settings: { difficulty: '<x>', updatedAt: 3 } });
  assert.deepEqual([clean.history, clean.pvp, clean.collection, clean.decks.list, clean.settings], [{}, [], { 20: 2 }, [], { updatedAt: 3 }]);
});

test('ajustes: só a dificuldade viaja e vence a mais recente', () => {
  const merged = mergeProgress({ v: 1, settings: { difficulty: 'duelist', updatedAt: 5 } }, { v: 1, settings: { difficulty: 'king', updatedAt: 9 } });
  assert.deepEqual(merged.settings, { difficulty: 'king', updatedAt: 9 });
});

test('readProgress/writeProgress usam as chaves de sempre e preservam o resto', () => {
  const store = new Map(Object.entries({
    'rushdaily-history': JSON.stringify({ AAA111: { '2026-10-01': 'win' }, OUTRO1: { '2026-10-01': 'loss' } }),
    'rushdaily-classic-booster:AAA111:2026-10-01': JSON.stringify(pack('2026-10-01T10:00:00Z', 'common', 10)),
    'rushdaily-reward:AAA111:2026-10-01': JSON.stringify({ seed: 'b', pending: true }),
    'rushdaily-settings:AAA111': JSON.stringify({ difficulty: 'duelist', reducedMotion: true }),
    'rushdaily-classic-game:AAA111:treino:2026-10-01': '{"responses":[]}',
  }));
  const storage = { getItem: (key) => store.get(key) ?? null, setItem: (key, value) => store.set(key, String(value)), removeItem: (key) => store.delete(key), key: (index) => [...store.keys()][index], get length() { return store.size; } };
  const progress = readProgress(storage, 'AAA111');
  assert.deepEqual(Object.keys(progress.boosters), ['2026-10-01']);
  assert.deepEqual(Object.keys(progress.rewards), ['2026-10-01'], 'normalize mantém; a junção descarta recompensa de pacote aberto');
  writeProgress(storage, 'AAA111', mergeProgress(progress, { v: 1, history: { '2026-10-02': 'win' }, settings: { difficulty: 'king', updatedAt: 9 } }));
  assert.deepEqual(JSON.parse(store.get('rushdaily-history')).OUTRO1, { '2026-10-01': 'loss' });
  assert.equal(JSON.parse(store.get('rushdaily-history')).AAA111['2026-10-02'], 'win');
  assert.equal(store.has('rushdaily-reward:AAA111:2026-10-01'), false);
  assert.deepEqual(JSON.parse(store.get('rushdaily-settings:AAA111')), { difficulty: 'king', reducedMotion: true, updatedAt: 9 });
  assert.ok(store.has('rushdaily-classic-game:AAA111:treino:2026-10-01'), 'partida em andamento não é tocada');
});

test('canonical ignora a ordem das chaves; isProgressKey separa progresso de estado local', async () => {
  const { canonical, isProgressKey } = await import('../src/ui/sync-merge.js');
  assert.equal(canonical({ b: 1, a: { d: [2, 1], c: 0 } }), canonical({ a: { c: 0, d: [2, 1] }, b: 1 }));
  assert.ok(isProgressKey('rushdaily-classic-booster:AAA111:2026-10-01') && isProgressKey('rushdaily-history'));
  assert.ok(!isProgressKey('rushdaily-classic-game:AAA111:treino:2026-10-01') && !isProgressKey('rushdaily-sync:AAA111') && !isProgressKey('rushdaily-ai-memory:AAA111'));
});
