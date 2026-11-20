/* Verifica a configuração e os dados do portal.
   Uso: npm run verificar */
'use strict';
require('../preparar-env');

const ok = t => console.log('  ✓ ' + t), mal = t => console.log('  ✗ ' + t), nota = t => console.log('    ' + t);

(async () => {
  let falhas = 0;
  const e = process.env;
  console.log('\n1. Configuração e dados do portal');
  const [maj, min] = process.versions.node.split('.').map(Number);
  if (maj < 22 || (maj === 22 && min < 13)) { mal(`Node.js ${process.version}: precisa da versão 22.13 ou superior (instale a LTS em nodejs.org)`); process.exit(1); }
  ok(`Node.js ${process.version}`);
  if (!e.JWT_SECRET || e.JWT_SECRET.length < 32) { falhas++; mal('falta a chave secreta (JWT_SECRET) no ficheiro .env'); nota('Gere-a com: node -e "console.log(require(\'crypto\').randomBytes(48).toString(\'hex\'))"'); }
  else ok('chave secreta (JWT_SECRET) preenchida');
  let armazem;
  try { armazem = require('../armazem'); await armazem.iniciar(); ok((armazem.remota ? 'base de dados: ' : 'ficheiro de dados: ') + armazem.ficheiro); }
  catch (x) { falhas++; mal('não foi possível abrir a base de dados'); nota(x.message); armazem = null; }
  if (armazem) {
    ok(`confirmações guardadas: ${await armazem.contar('confirmacoes')} (a última de cada posto e combustível)`);
    const contas = (await armazem.contas()).filter(c => c.activo), n = p => contas.filter(c => c.perfil === p).length;
    if (!n('admin')) { falhas++; mal('ainda não há nenhuma conta de administrador'); nota('Crie-a: node scripts/criar-utilizador.js <utilizador> "<Nome>"  (ou dois cliques em «Criar conta de administrador.bat»)'); }
    else ok(`contas activas: ${n('admin')} admin, ${n('gestor')} gestor, ${n('posto')} posto`);
    const integ = await armazem.integridade(await require('../postos').validos(armazem));
    if (integ.ok) ok(`integridade das confirmações: ${integ.confirmacoes} confirmação(ões), sem problemas`);
    else { falhas++; mal('integridade das confirmações'); integ.problemas.slice(0, 8).forEach(p => nota('- ' + p)); }
    await armazem.fechar();
  }

  console.log(falhas ? `\n${falhas} problema(s) a corrigir.\n` : '\nTudo pronto. Arranque com: npm start (ou dois cliques em «Ligar portal.bat»)\n');
  process.exit(falhas ? 1 : 0);
})();
