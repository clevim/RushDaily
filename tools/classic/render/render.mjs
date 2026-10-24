// Desenha as cartas clássicas em PT-BR com moldura oficial (yugioh-card, MIT) e grava WebP.
//   cd tools/classic/render && npm install   (aprovar o script do skia-canvas: npm install-scripts approve skia-canvas)
//   node tools/classic/render/render.mjs [--force] [id ...]
// Entrada: src/data/classic/s*.json e puzzles.json + artes em tools/classic/cache/art/<id>.jpg (comando "art" do importador).
// Saída: src/assets/classic-cards/<id>.webp (418x609).
import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import skia from 'skia-canvas';
import { YugiohCard } from 'yugioh-card';
import { SCALE, cardData, patchSpellTrapLabel } from '../../../src/ui/classic-card-data.js';

const ROOT = new URL('../../../', import.meta.url).pathname;
const ASSETS = `${ROOT}tools/classic/cache/yugioh-card-assets`;
const ART = `${ROOT}tools/classic/cache/art`;
const OUT = `${ROOT}src/assets/classic-cards`;
const args = process.argv.slice(2);
const force = args.includes('--force');
const only = new Set(args.filter((arg) => /^\d+$/.test(arg)).map(Number));

patchSpellTrapLabel(YugiohCard);
const nodeCardData = (card) => cardData(card, `data:image/jpeg;base64,${readFileSync(`${ART}/${card.id}.jpg`).toString('base64')}`);

const pool = readdirSync(`${ROOT}src/data/classic`).filter((name) => /^s\d+\.json$/.test(name)).flatMap((name) => JSON.parse(readFileSync(`${ROOT}src/data/classic/${name}`)));
// Cartas dos puzzles (mesmo fora da temporada) também ganham a pré-desenhada.
if (existsSync(`${ROOT}src/data/classic/puzzles.json`)) pool.push(...JSON.parse(readFileSync(`${ROOT}src/data/classic/puzzles.json`)).flatMap((puzzle) => puzzle.cards));
mkdirSync(OUT, { recursive: true });
const todo = pool.filter((card) => (!only.size || only.has(card.id)) && (force || !existsSync(`${OUT}/${card.id}.webp`)) && existsSync(`${ART}/${card.id}.jpg`));
const renderer = new YugiohCard({ data: { scale: SCALE }, resourcePath: ASSETS, skia });
const started = Date.now();
let done = 0;
for (const card of todo) {
  renderer.setData(nodeCardData(card));
  await new Promise((resolve) => renderer.leafer.waitViewCompleted(resolve));
  const result = await renderer.leafer.export('webp', { screenshot: true, quality: 0.82 });
  writeFileSync(`${OUT}/${card.id}.webp`, Buffer.from(String(result.data).replace(/^data:image\/webp;base64,/, ''), 'base64'));
  done += 1;
  if (done % 100 === 0) console.log(`${done}/${todo.length} (${((Date.now() - started) / done).toFixed(0)} ms/carta)`);
}
console.log(`${done} cartas desenhadas em ${((Date.now() - started) / 1000).toFixed(0)}s -> ${OUT}`);
process.exit(0);
