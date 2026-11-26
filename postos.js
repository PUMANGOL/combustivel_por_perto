/* Lista dos postos válidos: a lista incluída no portal (public/index.html)
   ou, se a gestão a tiver substituído, a da tabela «postos». Usada para validar confirmações e contas. */
'use strict';
const fs = require('fs');
const path = require('path');

function daPagina() {
  const html = fs.readFileSync(path.join(__dirname, 'public', 'index.html'), 'utf8');
  const m = /const POSTOS_REDE = (\[[\s\S]*?\n\]);/.exec(html);
  if (!m) throw new Error('Lista de postos não encontrada em public/index.html');
  return JSON.parse(m[1]).map(p => ({ id: String(p.id), nome: String(p.nome) }));
}
const INCLUIDOS = daPagina();
const lista = async armazem => {
  const t = await armazem.listar('postos');
  return t.length ? t.map(r => ({ id: String(r.dados.id), nome: String(r.dados.nome || '') })) : INCLUIDOS;
};
module.exports = {
  lista,
  /* códigos válidos neste momento */
  async validos(armazem) { return new Set((await lista(armazem)).map(p => p.id)); },
};
