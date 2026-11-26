/* Importa as contas da folha «Perfis de Acesso» (CSV ou texto com tabulações: Nome, email, Tipo, … [, Posto]).
   Cria só as contas que ainda não existem; nunca altera contas existentes.
   Cada conta nova fica à espera do primeiro acesso, com um código pessoal (válido 30 dias).
   Os códigos ficam num ficheiro em copias/ (só leitura do dono): entregue-os em privado e apague o ficheiro depois.
   Uso: node scripts/importar-perfis.js deploy/perfis-acesso.csv */
'use strict';
require('../preparar-env');
const fs = require('fs'), path = require('path');
const armazem = require('../armazem');
const contas = require('../contas');

const f = process.argv[2];
if (!f || !fs.existsSync(f)) { console.log('\nComo usar: node scripts/importar-perfis.js <ficheiro.csv>\n'); process.exit(1); }
(async () => {
  const linhas = contas.lerTabela(fs.readFileSync(f, 'utf8'));
  const r = await contas.importar(armazem, linhas, { auditar: d => armazem.auditar('contas_importadas', { utilizador: 'consola do servidor', detalhe: { ...d, ficheiro: path.basename(f) } }) });
  const criadas = r.filter(x => x.estado === 'criada'), exist = r.filter(x => x.estado === 'existente'), erros = r.filter(x => x.estado === 'erro');
  console.log(`\n✓ ${criadas.length} conta(s) criada(s) · ${exist.length} já existiam (não alteradas) · ${erros.length} com erro`);
  erros.forEach(e => console.log(`  ✗ linha ${e.linha}: ${e.email || e.nome} — ${e.motivo}`));
  if (criadas.length) {
    const pasta = path.join(__dirname, '..', 'copias'); fs.mkdirSync(pasta, { recursive: true });
    const d = new Date(), z = n => String(n).padStart(2, '0');
    const saida = path.join(pasta, `codigos-acesso-${d.getFullYear()}${z(d.getMonth() + 1)}${z(d.getDate())}-${z(d.getHours())}${z(d.getMinutes())}.csv`);
    const dt = t => new Date(t).toLocaleDateString('pt-PT', { timeZone: 'Africa/Luanda' });
    fs.writeFileSync(saida, '\ufeffNome;Email;Perfil;Posto;Código de primeiro acesso;Válido até\n' +
      criadas.map(c => [c.nome, c.email, c.perfil, c.postoNome || '', c.codigo, dt(c.expira)].join(';')).join('\n') + '\n', { mode: 0o600 });
    console.log(`\nCódigos de primeiro acesso gravados em: ${saida}`);
    console.log('Entregue cada código só à pessoa respectiva (pessoalmente ou por canal seguro) e apague este ficheiro depois.');
  }
  await armazem.fechar();
})().catch(e => { console.error(e.message); process.exit(1); });
