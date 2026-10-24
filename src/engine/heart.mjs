// Coração das Cartas como Skill do EDOPro (proc_skill.lua): uma carta de Skill entra no deck antes do início,
// o próprio procedimento tira ela do duelo e registra o efeito no jogador. Aparece como "Ativar" na Fase Principal.
// Uma vez por duelo: escolha 1 carta do seu Deck e adicione à mão (o rival vê qual foi).
// O script não vem do CardScripts: é servido por readScript a partir daqui (Node e navegador).

/** Código fora da faixa das cartas reais (Rush usa 160xxxxxx; capas de Skill 300xxxxxx). */
export const HEART_CODE = 199900001;
export const HEART_SCRIPT_NAME = `rush/c${HEART_CODE}.lua`;

/** Linha da carta no formato do cards.json (o motor só precisa do Tipo Skill). */
export const HEART_CARD = {
  id: HEART_CODE, alias: 0, setcode: '0', type: 0x8000000, atk: 0, def: 0, level: 0, race: 0, attribute: 0,
  name: 'Coração das Cartas', nameEn: 'Heart of the Cards', pt: true, skill: true,
  desc: 'Skill. Uma vez por duelo, na sua Fase Principal: escolha 1 carta do seu Deck e adicione-a à sua mão. Gasta a carga do Enigma do Milênio.',
  strings: ['Coração das Cartas: buscar 1 carta do Deck'],
};

export const HEART_SCRIPT = `-- Coração das Cartas (RushDaily)
local s,id=GetID()
function s.initial_effect(c)
	aux.AddSkillProcedure(c,1,false,s.con,s.op,1)
end
function s.con(e,tp,eg,ep,ev,re,r,rp)
	return aux.CanActivateSkill(tp) and Duel.GetFlagEffect(tp,id)==0
		and Duel.IsExistingMatchingCard(Card.IsAbleToHand,tp,LOCATION_DECK,0,1,nil)
end
function s.op(e,tp,eg,ep,ev,re,r,rp)
	Duel.RegisterFlagEffect(tp,id,0,0,0)
	Duel.Hint(HINT_CARD,tp,id)
	Duel.Hint(HINT_SELECTMSG,tp,HINTMSG_ATOHAND)
	local g=Duel.SelectMatchingCard(tp,Card.IsAbleToHand,tp,LOCATION_DECK,0,1,1,nil)
	if #g>0 then
		Duel.SendtoHand(g,nil,REASON_EFFECT)
		Duel.ConfirmCards(1-tp,g)
		Duel.ShuffleDeck(tp)
	end
end
`;

/** Leitor de scripts que também serve o script do Coração. */
export const withHeart = (readScript) => (name) => (name === HEART_SCRIPT_NAME ? HEART_SCRIPT : readScript(name));
