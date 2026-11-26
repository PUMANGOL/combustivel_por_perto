/* Emergência: repor a senha de uma conta directamente no servidor (por exemplo, o admin esqueceu-se).
   Só altera a senha; o perfil e o posto da conta ficam como estão.
   Uso: node scripts/repor-senha.js <utilizador> */
'use strict';
require('../preparar-env');
const bcrypt = require('bcryptjs');
const readline = require('readline');
const armazem = require('../armazem');
const [utilizador] = process.argv.slice(2);
const c = utilizador && armazem.porNome(utilizador);
if (!c) { console.log('\nComo usar: node scripts/repor-senha.js <utilizador>   (a conta tem de existir)\n'); process.exit(1); }
const rl = readline.createInterface({ input: process.stdin, output: process.stdout, terminal: !!process.stdin.isTTY });
let escondido = false;
rl._writeToOutput = s => { if (!escondido || s === '\r\n' || s === '\n') rl.output.write(s); };
const linhas = []; let espera = null;
rl.on('line', l => { if (espera) { const f = espera; espera = null; f(l); } else linhas.push(l); });
const pergunta = q => { escondido = false; rl.output.write(q); escondido = true; return linhas.length ? Promise.resolve(linhas.shift()) : new Promise(r => { espera = r; }); };
(async () => {
  console.log(`Conta «${c.utilizador}» (${c.perfil}). As letras da senha não aparecem enquanto escreve.`);
  const s1 = await pergunta('Nova senha (mínimo 10 caracteres): '); rl.output.write('\n');
  const s2 = await pergunta('Repita a senha: '); rl.output.write('\n'); rl.close();
  if (s1.length < 10 || s1 !== s2 || Buffer.byteLength(s1, 'utf8') > 72) { console.log('\nSenha curta, longa demais (máx. 72) ou diferente. Nada foi alterado.'); process.exit(1); }
  armazem.activar(c.utilizador, await bcrypt.hash(s1, 12));   /* também conclui um primeiro acesso pendente */
  armazem.auditar('senha_reposta_consola', { utilizador: c.utilizador, detalhe: { origem: 'consola do servidor' } });
  console.log(`\n✓ Senha da conta «${c.utilizador}» reposta. O perfil não foi alterado.`);
  armazem.fechar();
})();
