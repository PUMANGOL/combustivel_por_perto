/* Lista dos códigos de posto válidos: a lista incluída no portal (public/index.html)
   ou, se a gestão a tiver substituído, a da tabela «postos». Usada para validar as confirmações. */
'use strict';
const fs = require('fs');
const path = require('path');

function daPagina() {
  const html = fs.readFileSync(path.join(__dirname, 'public', 'index.html'), 'utf8');
  const m = /const POSTOS_REDE = (\[[\s\S]*?\n\]);/.exec(html);
  if (!m) throw new Error('Lista de postos não encontrada em public/index.html');
  return JSON.parse(m[1]).map(p => String(p.id));
}
const INCLUIDOS = new Set(daPagina());
module.exports = {
  /* códigos válidos neste momento */
  async validos(armazem) {
    const t = await armazem.listar('postos');
    return t.length ? new Set(t.map(r => String(r.dados.id))) : INCLUIDOS;
  },
};
