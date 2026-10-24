// Entrada do bundle para o navegador: só o desenhador das cartas clássicas.
import { Platform } from 'leafer-unified';
export { YugiohCard } from 'yugioh-card';

// As imagens das molduras em src/vendor ficam a 30% do tamanho original (bundle-assets.mjs); a biblioteca usa o
// tamanho natural da imagem para posicionar, então devolvemos o tamanho lógico original (PNG; os SVG não mudam).
const REDUCED = 0.3;
const loadImage = Platform.origin.loadImage;
Platform.origin.loadImage = function (url, ...rest) {
  return loadImage.call(this, url, ...rest).then((img) => {
    if (/\/yugioh\/image\/.*\.png/.test(url)) {
      Object.defineProperty(img, 'width', { value: Math.round(img.naturalWidth / REDUCED) });
      Object.defineProperty(img, 'height', { value: Math.round(img.naturalHeight / REDUCED) });
    }
    return img;
  });
};
