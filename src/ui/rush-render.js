// Imagens das cartas Rush (motor do EDOPro), desenhadas no navegador. CONTRATO (espelha classic-render.js):
//   rushImg(card, { small })  -> Promise<string> com a URL da frente da carta
//   paintRushCards(root)      -> preenche os <img data-rush-card="<id>"> dentro de root, sob demanda
//   rushCardUrl(id)           -> URL da melhor imagem já disponível, ou null (síncrono)
//   warmRushCards(ids)        -> pré-aquece em segundo plano
//   RUSH_BACK                 -> verso
// Versão provisória: ainda só devolve o verso.
export const RUSH_BACK = 'src/assets/card-back.svg';

const rel = (path) => new URL(`../../${path}`, import.meta.url).href;

export async function rushImg(card, { small = false } = {}) { // eslint-disable-line no-unused-vars
  return rel(RUSH_BACK);
}

export function paintRushCards(root = document) {
  for (const img of root.querySelectorAll('img[data-rush-card]')) {
    img.style.aspectRatio ||= '418 / 609';
    if (!img.getAttribute('src')) img.src = rel(RUSH_BACK);
  }
}

export function rushCardUrl(id) { // eslint-disable-line no-unused-vars
  return null;
}

export function warmRushCards(ids) {} // eslint-disable-line no-unused-vars
