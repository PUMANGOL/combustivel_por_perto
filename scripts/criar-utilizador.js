/* Cria a PRIMEIRA conta de administrador (quando ainda não existe nenhum admin activo).
   As restantes contas criam-se no portal, pelo admin, no separador Gestão.
   Nunca altera uma conta existente.
   Uso: node scripts/criar-utilizador.js <utilizador> "<Nome completo>" */
'use strict';
require('../preparar-env');
const bcrypt = require('bcryptjs');
const readline = require('readline');
const armazem = require('../armazem');

const [utilizador, nome] = process.argv.slice(2);
if (utilizador && !/^[A-Za-z0-9._-]{3,40}$/.test(utilizador)) {
  console.log(`\nO utilizador «${utilizador}» não é válido: tem de ter entre 3 e 40 caracteres (letras, números, ponto, hífen ou sublinhado), sem espaços.`);
  console.log('Exemplos válidos: rufino, rc.pumangol, admin01. Volte a correr o ficheiro.\n');
  process.exit(1);
}
if (!nome || !nome.trim()) {
  console.log('\nFalta o nome completo. Volte a correr o ficheiro.\n');
  process.exit(1);
}
if (!utilizador) {
  console.log('\nComo usar:  node scripts/criar-utilizador.js <utilizador> "<Nome completo>"');
  console.log('Exemplo:    node scripts/criar-utilizador.js rufino "Rufino Chipongue"\n');
  console.log('Cria a primeira conta de administrador. As outras contas criam-se no portal (separador Gestão).');
  process.exit(1);
}
const admins = armazem.contas().filter(c => c.activo && c.perfil === 'admin');
if (admins.length) {
  console.log(`\nJá existe ${admins.length === 1 ? 'uma conta' : admins.length + ' contas'} de administrador (${admins.map(a => a.utilizador).join(', ')}).`);
  console.log('Novas contas e alterações de perfil fazem-se no portal, pelo admin, no separador Gestão.');
  console.log('Se o admin perdeu a senha: node scripts/repor-senha.js <utilizador>\n');
  process.exit(1);
}
if (armazem.existeUtilizador(utilizador)) {
  console.log(`\nJá existe uma conta «${utilizador}». Escolha outro utilizador. As contas existentes não são alteradas por este comando.\n`);
  process.exit(1);
}
const rl = readline.createInterface({ input: process.stdin, output: process.stdout, terminal: !!process.stdin.isTTY });
let escondido = false;
rl._writeToOutput = s => { if (!escondido || s === '\r\n' || s === '\n') rl.output.write(s); };
const linhas = []; let espera = null;
rl.on('line', l => { if (espera) { const f = espera; espera = null; f(l); } else linhas.push(l); });
function perguntarSenha(q) {
  escondido = false; rl.output.write(q); escondido = true;
  return linhas.length ? Promise.resolve(linhas.shift()) : new Promise(r => { espera = r; });
}
(async () => {
  console.log('(As letras da senha não aparecem enquanto escreve. É normal.)');
  const senha = await perguntarSenha('Senha (mínimo 10 caracteres): ');
  rl.output.write('\n');
  if (senha.length < 10) { rl.close(); console.log('\nSenha demasiado curta. Tente de novo com pelo menos 10 caracteres.'); process.exit(1); }
  if (Buffer.byteLength(senha, 'utf8') > 72) { rl.close(); console.log('\nSenha demasiado longa (máximo 72 caracteres).'); process.exit(1); }
  const repetir = await perguntarSenha('Repita a senha: ');
  rl.output.write('\n');
  if (repetir !== senha) { rl.close(); console.log('\nAs senhas não são iguais. Tente de novo.'); process.exit(1); }
  rl.close();
  armazem.criarUtilizador({ utilizador, nome, hash: await bcrypt.hash(senha, 12), perfil: 'admin', posto: null });
  armazem.auditar('admin_criado_consola', { utilizador, detalhe: { origem: 'consola do servidor' } });
  console.log(`\n✓ Conta de administrador «${utilizador}» criada.`);
  armazem.fechar();
})().catch(e => { console.error(e.message); process.exit(1); });
