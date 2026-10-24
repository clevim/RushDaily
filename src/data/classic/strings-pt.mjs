// Mensagens de sistema do EDOPro (config/strings.conf) usadas durante o duelo, em PT-BR.
// O motor manda só o número; %ls vira o nome da carta e %d um número.
export const SYSTEM = {
  1: 'Invocação-Normal', 2: 'Invocação-Especial', 3: 'Invocação-Virada', 7: 'Ativar',
  10: 'Remover marcadores', 11: 'Pagar PV', 12: 'Desassociar matérias',
  20: 'Fase de Compra', 21: 'Fase de Apoio', 22: 'Fase Principal', 24: 'Fase de Batalha', 26: 'Fase Final',
  30: 'O alvo mudou. Continuar o ataque?', 31: 'Atacar diretamente?', 32: 'Fazer outra Fase de Batalha?',
  60: 'Cara', 61: 'Coroa', 64: 'Gêmeo', 65: 'Usar o efeito', 66: 'Manter revelada',
  70: 'Monstros', 71: 'Magias', 72: 'Armadilhas',
  90: 'Invocar por Normal sem tributo?', 91: 'Usar sua Invocação-Normal extra?', 92: 'Usar um monstro do oponente?',
  93: 'Continuar escolhendo matérias?', 94: 'Ativar o efeito desta carta agora?', 95: 'Usar o efeito de "%ls"?',
  96: 'Usar o efeito de "%ls" para evitar a destruição?', 97: 'Colocar "%ls" na Zona de Magias e Armadilhas?',
  98: 'Usar um efeito que substitui o custo?',
  200: 'Usar o efeito de "%ls" de [%ls]?', 203: 'Ativar uma carta ou efeito?',
  205: 'Escolha a ordem (de cima para baixo)', 206: 'Escolha a ordem da Corrente',
  207: 'Revelando %d carta(s):', 208: 'Confirmar %d carta(s):', 210: 'Continuar escolhendo cartas?',
  212: 'Carta declarada:', 213: 'Tipo declarado:', 214: 'Atributo declarado:', 215: 'Número declarado:',
  221: 'Ativar o efeito de gatilho de "%ls" de [%ls]?', 222: 'Ativar um efeito de gatilho?',
  500: 'Escolha o(s) tributo(s)', 501: 'Escolha a(s) carta(s) para descartar', 502: 'Escolha a(s) carta(s) para destruir',
  503: 'Escolha a(s) carta(s) para banir', 504: 'Escolha a(s) carta(s) para mandar ao Cemitério',
  505: 'Escolha a(s) carta(s) para devolver à mão', 506: 'Escolha a(s) carta(s) para adicionar à mão',
  507: 'Escolha a(s) carta(s) para devolver ao Deck', 508: 'Escolha o monstro para Invocar por Normal',
  509: 'Escolha o(s) monstro(s) para Invocar por Especial', 510: 'Escolha a(s) carta(s) para baixar',
  511: 'Escolha as matérias de Fusão', 512: 'Escolha as matérias de Sincro', 513: 'Escolha as matérias de Xyz',
  514: 'Escolha carta(s) com a face para cima', 515: 'Escolha carta(s) com a face para baixo',
  516: 'Escolha monstro(s) em Posição de Ataque', 517: 'Escolha monstro(s) em Posição de Defesa',
  518: 'Escolha a carta para equipar', 519: 'Escolha a(s) matéria(s) Xyz para desassociar',
  520: 'Escolha o(s) monstro(s) para tomar o controle', 522: 'Escolha um monstro em Ataque com a face para cima',
  523: 'Escolha um monstro em Defesa com a face para cima', 525: 'Escolha um monstro em Defesa com a face para baixo',
  526: 'Escolha a(s) carta(s) para revelar', 527: 'Escolha a(s) carta(s) para colocar no campo',
  528: 'Escolha o monstro para mudar de posição', 529: 'Escolha sua carta', 530: 'Escolha uma carta do oponente',
  531: 'Escolha os monstros para a Invocação-Tributo', 533: 'Escolha as matérias de Link',
  534: 'Escolha a(s) carta(s) que ficam no campo', 549: 'Escolha o alvo do ataque',
  550: 'Escolha o efeito para ativar', 551: 'Escolha o(s) alvo(s) do efeito', 552: 'Escolha cara ou coroa',
  553: 'Escolha o resultado do dado', 554: 'Declare um tipo de carta', 555: 'Escolha uma opção',
  556: 'Escolha o efeito para aplicar', 560: 'Escolha', 561: 'Escolha a posição de batalha',
  562: 'Declare um Atributo', 563: 'Declare um Tipo', 564: 'Declare o nome de uma carta', 565: 'Declare um número',
  566: 'Escolha o efeito para ativar', 567: 'Declare um Nível', 568: 'Escolha a carta para resolver',
  569: 'Escolha a zona para "%ls"', 570: 'Escolha a(s) zona(s) que ficam inutilizáveis', 571: 'Escolha a zona para mover a carta',
  572: 'Escolha a(s) carta(s) para receber marcador', 573: 'Adicionar à mão', 574: 'Mandar ao Cemitério',
  575: 'Escolha a(s) carta(s) para negar os efeitos', 576: 'Escolha a(s) carta(s) para mudar o ATK/DEF',
  577: 'Escolha a(s) carta(s) para aplicar o efeito', 578: 'Escolha a(s) carta(s) para associar como matéria',
  579: 'Escolha a(s) carta(s) para devolver ao Cemitério',
  1000: 'Deck', 1001: 'Mão', 1002: 'Zona de Monstros', 1003: 'Zona de Magias e Armadilhas', 1004: 'Cemitério',
  1005: 'Banidas', 1006: 'Deck Adicional', 1007: 'Matéria Xyz', 1008: 'Zona de Campo', 1009: 'Zona de Pêndulo',
  1150: 'Ativar', 1151: 'Invocar por Normal', 1152: 'Invocar por Especial', 1153: 'Baixar', 1154: 'Invocar por Virada',
  1155: 'Mudar para Defesa', 1156: 'Mudar para Ataque', 1157: 'Atacar', 1159: 'Baixar Magia/Armadilha',
  1160: 'Ativar como Magia de Pêndulo', 1163: 'Invocação-Pêndulo', 1170: 'Invocação-Fusão', 1171: 'Invocação-Ritual',
  1172: 'Invocação-Sincro', 1173: 'Invocação-Xyz', 1174: 'Invocação-Link',
};

export const ATTRIBUTES = { 1: 'TERRA', 2: 'ÁGUA', 4: 'FOGO', 8: 'VENTO', 16: 'LUZ', 32: 'TREVAS', 64: 'DIVINO' };
export const RACES = [
  'Guerreiro', 'Mago', 'Fada', 'Demônio', 'Zumbi', 'Máquina', 'Aqua', 'Piro', 'Rocha', 'Besta Alada', 'Planta', 'Inseto',
  'Trovão', 'Dragão', 'Besta', 'Besta-Guerreira', 'Dinossauro', 'Peixe', 'Serpente Marinha', 'Réptil', 'Psíquico',
  'Besta Divina', 'Deus Criador', 'Wyrm', 'Ciberso', 'Ilusão',
]; // bit i = RACES[i]

/** Texto de uma "description" do motor: (código da carta << 20) | índice do rótulo, ou um número de sistema. */
export function describe(description, cards, args = []) {
  const value = BigInt(description ?? 0);
  const code = Number(value >> 20n);
  const index = Number(value & 0xfffffn);
  let text;
  if (code) {
    const card = cards.get(code);
    text = card?.strings?.[index] || (card ? `Efeito de "${card.name}"` : 'Efeito');
  } else {
    text = SYSTEM[index] || '';
  }
  let at = 0;
  return text.replace(/%ls|%d/g, () => String(args[at++] ?? ''));
}
