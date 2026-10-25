import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import test from 'node:test';
import { RACES, descriptionZoom, maximumAtk, placeholderArt, rushCardData, rushDescription } from '../src/ui/rush-card-data.js';

// Desenho das cartas Rush (dados para o RushDuelCard) e o casamento das artes (tools/rush/import_rush.py art), sem rede e sem os dados do setup.
const dragon = { id: 160001000, type: 0x11, atk: 3000, def: 2500, level: 8, race: 0x2000, attribute: 16, name: 'Dragão Branco de Olhos Azuis', nameEn: 'Blue-Eyes White Dragon', desc: 'Lendário.', pt: true, legend: true };
const center = { id: 160004022, type: 0x8021, atk: 2500, def: 0, level: 10, race: 0x800000, attribute: 1, name: 'Draco', nameEn: 'Draco', desc: 'MAXIMUM ATK = 3500\nYou can Maximum Summon this card.\n\n[REQUIREMENT]\nMaximum Mode\n[CONTINUOUS EFFECT]\nNo.', pt: false, maximum: 'C' };

test('monstro: tipo em PT, Lenda, nível e atributo', () => {
  const data = rushCardData(dragon, 'arte.webp');
  assert.equal(data.type, 'monster');
  assert.equal(data.cardType, 'normal');
  assert.equal(data.monsterType, 'Dragão/Normal');
  assert.equal(data.attribute, 'light');
  assert.equal(data.level, 8);
  assert.equal(data.legend, true);
  assert.equal(data.image, 'arte.webp');
  assert.equal(data.maximumAtk, 0);
  assert.equal(RACES.length, 32, 'até Galáxia (bit 31)');
  assert.equal(rushCardData({ ...dragon, race: 0x80000000 }).monsterType, 'Galáxia/Normal');
});

test('Máximo: ATK MAX vem do texto e sai da descrição; rótulos ficam na mesma linha', () => {
  assert.equal(maximumAtk(center), 3500);
  assert.equal(maximumAtk({ ...center, maximum: 'L' }), 0);
  assert.equal(rushDescription(center), 'You can Maximum Summon this card.\n[REQUIREMENT] Maximum Mode\n[CONTINUOUS EFFECT] No.');
  const data = rushCardData(center);
  assert.equal(data.cardType, 'effect');
  assert.equal(data.monsterType, 'Wyrm/Máximo/Efeito');
  assert.ok(descriptionZoom('x'.repeat(700)) < descriptionZoom('x'.repeat(100)));
});

test('Magia/Armadilha: ícone e quadro provisório sem arte', () => {
  const equip = rushCardData({ ...dragon, type: 0x40002, attribute: 0, race: 0, legend: false });
  assert.deepEqual([equip.type, equip.icon, equip.attribute], ['spell', 'equip', '']);
  const trap = rushCardData({ ...dragon, type: 0x4, attribute: 0, race: 0 });
  assert.equal(trap.type, 'trap');
  assert.match(trap.image, /^data:image\/svg\+xml;base64,/);
  assert.notEqual(placeholderArt({ type: 0x21, attribute: 32 }), placeholderArt({ type: 0x21, attribute: 4 }), 'tom pelo atributo');
});

// Chama as funções do importador num Python isolado, com cartas de mentira.
function python(code, ...args) {
  const result = spawnSync('python3', ['-I', '-c', `import json, sys\nsys.path.insert(0, 'tools/rush')\nimport import_rush as m\n${code}`, ...args], { cwd: new URL('../', import.meta.url), encoding: 'utf8' });
  assert.equal(result.status, 0, result.stderr);
  return JSON.parse(result.stdout);
}

test('artes: casa pelo nome, pelos atributos do monstro e pelo nome parecido da Magia', () => {
  const cards = [
    { id: 1, nameEn: 'Blue-Eyes White Dragon', type: 0x11, atk: 3000, def: 2500, level: 8, race: 0x2000, attribute: 16 },
    { id: 2, nameEn: 'Coil Dragon of the Fertile Land', type: 0x11, atk: 1500, def: 1200, level: 4, race: 0x800000, attribute: 1 },
    { id: 3, nameEn: 'Galactica Reminiscences', type: 0x2, atk: 0, def: 0, level: 0, race: 0, attribute: 0 },
    { id: 4, nameEn: 'Surging-Wave Swordsman Yoshimitsu Shark', type: 0x21, atk: 1, def: 1, level: 1, race: 1, attribute: 1 },
    { id: 5, nameEn: 'Unknown Trap', type: 0x4, atk: 0, def: 0, level: 0, race: 0, attribute: 0 },
  ];
  const yaml = [
    { name: { en: 'Blue-Eyes White Dragon' }, card_type: 'Monster', images: [{ image: 'BlueEyesWhiteDragon-RDKP01-JP-UR.png', illustration: 'BlueEyesWhiteDragon-DBR-JP-VG-artwork.png' }] },
    { name: { en: 'Coiled Dragon of Fertility' }, card_type: 'Monster', monster_type_line: 'Wyrm / Normal', atk: 1500, def: 1200, level: 4, attribute: 'EARTH', images: [{ image: 'CoiledDragonofFertility-RDKP01-JP-C.png' }] },
    { name: { en: 'Galactica Reminiscence' }, card_type: 'Spell', images: [{ image: 'GalacticaReminiscence-RDKP02-JP-C.png' }] },
    { name: { en: 'Hydro Sword Yoshimitsu Goblin Shark' }, card_type: 'Monster', images: [{ image: 'Yoshimitsu-RDKP03-JP-C.png' }] },
    { name: { en: 'Some Other Trap' }, card_type: 'Trap', images: [{ image: 'Other-RDKP04-JP-C.png' }] },
  ];
  const found = python("found = m.match_yaml(json.loads(sys.argv[1]), json.loads(sys.argv[2]))\nprint(json.dumps({k: v['name']['en'] for k, v in found.items()}))", JSON.stringify(cards), JSON.stringify(yaml));
  assert.deepEqual(found, { 1: 'Blue-Eyes White Dragon', 2: 'Coiled Dragon of Fertility', 3: 'Galactica Reminiscence', 4: 'Hydro Sword Yoshimitsu Goblin Shark' });
});

test('artes: fonte preferida (limpa > padrão conferido > scan recortado) e URL do CDN pelo md5', () => {
  const out = python(`sources = {'files': {'Foo-OW-RD.png': True}, 'pages': {'Bar (Rush Duel)': 'Bar-RDKP05-JP-C.png'}}
card = {'nameEn': 'Bar'}
print(json.dumps([
  m.art_source(card, {'images': [{'image': 'Foo-RDKP01-JP-C.png', 'illustration': 'Foo-DBR-JP-VG-artwork.png'}]}, sources),
  m.art_source(card, {'images': [{'image': 'Foo-RDKP01-JP-C.png'}]}, sources),
  m.art_source(card, {'images': [{'image': 'Baz-RDKP01-JP-C.png'}]}, sources),
  m.art_source(card, None, sources),
  m.art_source({'nameEn': 'Nada'}, None, sources),
  m.cdn('BlueEyesWhiteDragon-DBR-JP-VG-artwork.png'),
]))`);
  assert.deepEqual(out.slice(0, 5), [['Foo-DBR-JP-VG-artwork.png', false], ['Foo-OW-RD.png', false], ['Baz-RDKP01-JP-C.png', true], ['Bar-RDKP05-JP-C.png', true], null]);
  assert.equal(out[5], 'https://ms.yugipedia.com//b/b9/BlueEyesWhiteDragon-DBR-JP-VG-artwork.png');
});
