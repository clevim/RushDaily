// Regras compartilhadas pelo engine e pela IA (sem dependências para evitar import circular).

/** Rush Duel: nível 5-6 pede 1 tributo; nível 7+ pede 2. */
export function tributesFor(card) {
  return card.level >= 7 ? 2 : card.level >= 5 ? 1 : 0;
}

export function canSummon(player, card) {
  const tributes = tributesFor(card);
  return card.type === 'monster' && player.field.length >= tributes && player.field.length - tributes < 3;
}

export function canSet(player) {
  return (player.backrow?.length || 0) < 3;
}


/** Quem começa o duelo não ataca no primeiro turno. */
export function canAttackNow(state, owner) {
  return !(state.turn === 1 && owner === 'player');
}

/** Monstro com face para cima em Posição de Ataque. */
export function isAttacker(card) {
  return card.faceUp !== false && card.position !== 'defense';
}

/** Identifica cada meio-turno (o contador `turn` só sobe na vez do jogador). */
export function turnKey(state) {
  return `${state.turn}:${state.active}`;
}

/** Zona (0-2) que o monstro ocupa no campo; cartas antigas sem `zone` usam a posição na lista. */
export function zoneOf(player, card) {
  return card.zone ?? player.field.indexOf(card);
}

/** Muda posição uma vez por turno e não depois de atacar. */
export function canChangePosition(state, player, card) {
  return card.changedTurn !== turnKey(state) && !player.attacks.has(card.uid);
}
