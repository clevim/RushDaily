// Copia os recursos das molduras para o navegador: imagens a 30% (desenhamos em escala 0.3) e só as fontes latinas.
// Requer ImageMagick (convert). Saída: src/vendor/yugioh-card/assets/{yugioh,rush-duel}/{image,font}
import { copyFileSync, mkdirSync, readdirSync, writeFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';

const ROOT = new URL('../../../', import.meta.url).pathname;
const SRC = `${ROOT}tools/classic/cache/yugioh-card-assets/yugioh`;
const OUT = `${ROOT}src/vendor/yugioh-card/assets/yugioh`;
const RUSH_SRC = `${ROOT}tools/classic/cache/yugioh-card-assets/rush-duel`;
const RUSH_OUT = `${ROOT}src/vendor/yugioh-card/assets/rush-duel`;
const FONTS = ['ygo-en', 'ygo-en-italic', 'ygo-en-name', 'ygo-en-race', 'ygo-atk-def', 'ygo-link', 'ygo-password'];
// Fora: versões jp/kr/astral, verso, sangria, raridades, lasers, copyright e 20º aniversário (não usados; twentieth e attribute-rare são só pedidos pela biblioteca).
const SKIP = /-(astral|jp|kr)\.|^card-back|^card-bleed|^rare-|^laser|^copyright/;
// Rush: as fontes da biblioteca são chinesas/japonesas (MBs); só os números (rd-atk-def) vêm dela, nome e texto usam as latinas acima.
const RUSH_FONTS = ['rd-atk-def', 'ygo-en', 'ygo-en-name', 'ygo-en-race'];

const reduzir = (de, para) => execFileSync('magick', [de, '-resize', '30%', '-define', 'png:compression-level=9', '-strip', para]);

mkdirSync(`${OUT}/image`, { recursive: true });
mkdirSync(`${OUT}/font`, { recursive: true });
for (const name of readdirSync(`${SRC}/image`)) {
  if (SKIP.test(name)) continue;
  if (name.endsWith('.png')) reduzir(`${SRC}/image/${name}`, `${OUT}/image/${name}`);
  else copyFileSync(`${SRC}/image/${name}`, `${OUT}/image/${name}`);
}
for (const name of FONTS) copyFileSync(`${SRC}/font/${name}.woff2`, `${OUT}/font/${name}.woff2`);
// A biblioteca baixa só o que está nesta lista.
writeFileSync(`${OUT}/font/font-list.json`, JSON.stringify(FONTS));

// Moldura Rush (RushDuelCard): mesma redução; a biblioteca lê as fontes de rush-duel/font/font-list.json.
mkdirSync(`${RUSH_OUT}/image`, { recursive: true });
mkdirSync(`${RUSH_OUT}/font`, { recursive: true });
for (const name of readdirSync(`${RUSH_SRC}/image`)) {
  if (SKIP.test(name) || !name.endsWith('.png')) continue;
  reduzir(`${RUSH_SRC}/image/${name}`, `${RUSH_OUT}/image/${name}`);
}
for (const name of RUSH_FONTS) copyFileSync(name.startsWith('rd-') ? `${RUSH_SRC}/font/${name}.woff2` : `${SRC}/font/${name}.woff2`, `${RUSH_OUT}/font/${name}.woff2`);
writeFileSync(`${RUSH_OUT}/font/font-list.json`, JSON.stringify(RUSH_FONTS));
