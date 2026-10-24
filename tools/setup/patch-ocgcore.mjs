// Aplica os patches locais do RushDaily no binding do ocgcore-wasm 0.1.6 (index.js): parser de consulta (função Q),
// COUNTERS, leitura de mensagens (duelGetMessage) e resposta de ordenação (função ce).
// Falha alto se alguma âncora não bater (pacote em outra versão). Idempotente: se já aplicado, não faz nada.
// Uso: node tools/setup/patch-ocgcore.mjs <index.js>
import { readFileSync, writeFileSync } from 'node:fs';

// Cada patch troca `de` por `para`. "Já aplicado" = `para` presente e (`para` contém `de` ou `de` ausente).
export const PATCHES = [
  { nome: 'campo TYPE', de: 'if(r===u.CODE&&o===4)t.code=e.u32();', para: 'if(r===u.TYPE&&o===4)t.type=e.u32();else if(r===u.CODE&&o===4)t.code=e.u32();' },
  { nome: 'pular campos desconhecidos', de: 't.link={rating:s,marker:O}}}return t}', para: 't.link={rating:s,marker:O}}else e.off+=o}return t}' },
  // Consulta COUNTERS: o core manda (tipo u16, quantidade u16); o binding guardava counters[quantidade] = tipo.
  { nome: 'COUNTERS tipo/quantidade', de: 'let c=e.u16(),a=e.u16();t.counters[a]=c', para: 'let c=e.u16(),a=e.u16();t.counters[c]=a' },
  // Mensagem que o parser não sabe ler lança "eof" e perdia o lote inteiro de duelGetMessage: agora só ela é descartada.
  { nome: 'mensagem ilegível não derruba o lote', de: 'R=te(T);if(!R)', para: 'R=(()=>{try{return te(T)}catch{return null}})();if(!R)' },
  // SORT_CARD/SORT_CHAIN com ordem explícita: o core lê só as posições, sem o byte de tamanho (com ele a resposta dá RETRY para sempre).
  { nome: 'SORT_CARD sem byte de tamanho', de: 't.i8(e.order.length);for(let s of e.order)t.i8(s);break', para: 'for(let s of e.order)t.i8(s);break' },
];

export function aplicar(codigo) {
  let saida = codigo;
  const log = [];
  for (const { nome, de, para } of PATCHES) {
    if (saida.includes(para) && (para.includes(de) || !saida.includes(de))) { log.push(`${nome}: já aplicado`); continue; }
    const achados = saida.split(de).length - 1;
    if (achados !== 1) throw new Error(`patch do ocgcore: âncora "${nome}" encontrada ${achados}x (esperado 1). O pacote mudou? Revise tools/setup/patch-ocgcore.mjs.`);
    saida = saida.replace(de, () => para);
    log.push(`${nome}: aplicado`);
  }
  return { codigo: saida, log };
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const alvo = process.argv[2];
  const { codigo, log } = aplicar(readFileSync(alvo, 'utf8'));
  writeFileSync(alvo, codigo);
  console.log(log.join('; '));
}
