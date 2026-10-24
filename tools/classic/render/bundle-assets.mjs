// Copia os recursos das molduras para o navegador: imagens a 30% (desenhamos em escala 0.3) e só as fontes latinas.
// Requer ImageMagick (convert). Saída: src/vendor/yugioh-card/assets/yugioh/{image,font}
import { copyFileSync, mkdirSync, readdirSync, writeFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';

const ROOT = new URL('../../../', import.meta.url).pathname;
const SRC = `${ROOT}tools/classic/cache/yugioh-card-assets/yugioh`;
const OUT = `${ROOT}src/vendor/yugioh-card/assets/yugioh`;
const FONTS = ['ygo-en', 'ygo-en-italic', 'ygo-en-name', 'ygo-en-race', 'ygo-atk-def', 'ygo-link', 'ygo-password'];
// Fora: versões jp/kr/astral, verso, sangria, raridades, lasers, copyright e 20º aniversário (não usados; twentieth e attribute-rare são só pedidos pela biblioteca).
const SKIP = /-(astral|jp|kr)\.|^card-back|^card-bleed|^rare-|^laser|^copyright/;

mkdirSync(`${OUT}/image`, { recursive: true });
mkdirSync(`${OUT}/font`, { recursive: true });
for (const name of readdirSync(`${SRC}/image`)) {
  if (SKIP.test(name)) continue;
  if (name.endsWith('.png')) execFileSync('magick', [`${SRC}/image/${name}`, '-resize', '30%', '-define', 'png:compression-level=9', '-strip', `${OUT}/image/${name}`]);
  else copyFileSync(`${SRC}/image/${name}`, `${OUT}/image/${name}`);
}
for (const name of FONTS) copyFileSync(`${SRC}/font/${name}.woff2`, `${OUT}/font/${name}.woff2`);
// A biblioteca baixa só o que está nesta lista.
writeFileSync(`${OUT}/font/font-list.json`, JSON.stringify(FONTS));
