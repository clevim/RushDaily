// Monta as cartas Rush pré-desenhadas (mesmo desenho do navegador: src/ui/rush-card-data.js) e grava WebP.
//   node tools/rush/render.mjs [--force] [id ...]
// Requer o npm ci em tools/classic/render (yugioh-card + skia-canvas; o setup faz) e as molduras em tools/classic/cache.
// Entrada: src/data/rush/cards.json + artes em src/assets/rush-art/<id>.webp (etapa rush-art; sem arte sai o quadro provisório).
// Saída: src/assets/rush-cards/<id>.webp (418x609), src/assets/rush-cards-sm/<id>.webp (140 px) e rush-cards/index.json.
// Refaz a carta quando a arte é mais nova que ela (a arte chegou depois); mudou o desenho: --force.
import { copyFileSync, existsSync, mkdirSync, readFileSync, readdirSync, rmSync, statSync, symlinkSync, writeFileSync } from 'node:fs';
import { SCALE, patchRushCard, rushCardData } from '../../src/ui/rush-card-data.js';

const ROOT = new URL('../../', import.meta.url).pathname;
const LIBS = `${ROOT}tools/classic/render/node_modules`;
const MOLDURAS = `${ROOT}tools/classic/cache/yugioh-card-assets`;
const ASSETS = `${ROOT}tools/rush/cache/yugioh-card-assets`;
const ART = `${ROOT}src/assets/rush-art`;
const OUT = `${ROOT}src/assets/rush-cards`;
const OUT_SM = `${ROOT}src/assets/rush-cards-sm`;
const SMALL = 140;
const FONTS = { 'rd-atk-def': 'rush-duel', 'ygo-en': 'yugioh', 'ygo-en-name': 'yugioh', 'ygo-en-race': 'yugioh' };
const args = process.argv.slice(2);
const force = args.includes('--force');
const only = new Set(args.filter((arg) => /^\d+$/.test(arg)).map(Number));

if (!existsSync(`${MOLDURAS}/rush-duel/image`)) {
  console.error('faltam as molduras Rush: rode npm run setup -- --so yugioh');
  process.exit(1);
}
const skia = (await import(`${LIBS}/skia-canvas/lib/index.mjs`)).default;
const { RushDuelCard } = await import(`${LIBS}/yugioh-card/index.js`);
patchRushCard(RushDuelCard);

// Pasta de recursos só com o que o desenho usa: imagens originais (links) e as 4 fontes latinas (a biblioteca lê font-list.json).
rmSync(`${ASSETS}/rush-duel/font`, { recursive: true, force: true });
mkdirSync(`${ASSETS}/rush-duel/font`, { recursive: true });
for (const [dir, target] of [[`${ASSETS}/rush-duel/image`, `${MOLDURAS}/rush-duel/image`], [`${ASSETS}/yugioh`, `${MOLDURAS}/yugioh`]]) {
  if (!existsSync(dir)) symlinkSync(target, dir, 'dir');
}
for (const [font, folder] of Object.entries(FONTS)) copyFileSync(`${MOLDURAS}/${folder}/font/${font}.woff2`, `${ASSETS}/rush-duel/font/${font}.woff2`);
writeFileSync(`${ASSETS}/rush-duel/font/font-list.json`, JSON.stringify(Object.keys(FONTS)));

const mtime = (path) => (existsSync(path) ? statSync(path).mtimeMs : 0);
const artPath = (id) => `${ART}/${id}.webp`;
const pool = JSON.parse(readFileSync(`${ROOT}src/data/rush/cards.json`));
mkdirSync(OUT, { recursive: true });
mkdirSync(OUT_SM, { recursive: true });
const todo = pool.filter((card) => {
  if (only.size && !only.has(card.id)) return false;
  const done = mtime(`${OUT}/${card.id}.webp`);
  return force || !done || mtime(artPath(card.id)) > done || !existsSync(`${OUT_SM}/${card.id}.webp`);
});

const renderer = new RushDuelCard({ data: { scale: SCALE }, resourcePath: ASSETS, skia });
const started = Date.now();
let done = 0;
let semArte = 0;
for (const card of todo) {
  const art = existsSync(artPath(card.id)) ? `data:image/webp;base64,${readFileSync(artPath(card.id)).toString('base64')}` : null;
  if (!art) semArte += 1;
  renderer.setData(rushCardData(card, art));
  await new Promise((resolve) => renderer.leafer.waitViewCompleted(resolve));
  const result = await renderer.leafer.export('webp', { screenshot: true, quality: 0.82 });
  const bytes = Buffer.from(String(result.data).replace(/^data:image\/webp;base64,/, ''), 'base64');
  writeFileSync(`${OUT}/${card.id}.webp`, bytes);
  // Miniatura das listas e da mão: a mesma imagem reduzida.
  const image = await skia.loadImage(bytes);
  const canvas = new skia.Canvas(SMALL, Math.round((image.height * SMALL) / image.width));
  canvas.getContext('2d').drawImage(image, 0, 0, canvas.width, canvas.height);
  writeFileSync(`${OUT_SM}/${card.id}.webp`, await canvas.toBuffer('webp', { quality: 0.8 }));
  done += 1;
  if (done % 100 === 0 || done === todo.length) console.log(`${done}/${todo.length} (${((Date.now() - started) / done).toFixed(0)} ms/carta)`);
}
// O navegador só usa a pré-desenhada das cartas listadas aqui.
const ids = readdirSync(OUT).filter((name) => /^\d+\.webp$/.test(name)).map((name) => Number(name.slice(0, -5))).sort((a, b) => a - b);
writeFileSync(`${OUT}/index.json`, JSON.stringify(ids));
console.log(`${done} cartas desenhadas (${semArte} sem arte) em ${((Date.now() - started) / 1000).toFixed(0)}s | ${ids.length} de ${pool.length} prontas -> ${OUT}`);
process.exit(0);
