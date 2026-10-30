/**
 * Monstro em Modo Máximo no campo: centro (maximum 'C') com as peças L/R (ids vizinhos no cards.json) nas zonas
 * ao lado, as três face para cima. O motor não expõe os flags do proc_maximum.lua, mas as três peças vêm com
 * TYPE_MAXIMUM (0x8000) e o mesmo ATK (o ATK MÁXIMO do centro, com bônus); o trio por ids vale mesmo sem o tipo.
 * Devolve Map(sequência -> 'L' | 'C' | 'R'); fora do trio completo, as peças ficam como cartas comuns.
 */
export function maximumTrios(monsters, cardOf) {
  const out = new Map();
  const up = (card) => card && !(card.position & 0xa); // 0xa = virada (ataque ou defesa)
  monsters.forEach((card, seq) => {
    if (!up(card) || cardOf(card.code).maximum !== 'C') return;
    const [left, right] = [monsters[seq - 1], monsters[seq + 1]];
    if (up(left) && left.code === card.code - 1 && up(right) && right.code === card.code + 1) { out.set(seq - 1, 'L').set(seq, 'C').set(seq + 1, 'R'); }
  });
  return out;
}
