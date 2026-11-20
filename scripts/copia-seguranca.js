/* Faz uma cópia de segurança dos dados do portal (confirmações, contas…) para a pasta copias/.
   Pode correr com o portal ligado. Uso: npm run copia
   - ficheiro local: cópia SQLite completa (.sqlite);
   - Turso (Vercel): exportação de todas as tabelas para um ficheiro .json (a Turso guarda também o seu próprio histórico). */
'use strict';
require('../preparar-env');
const fs = require('fs');
const path = require('path');
const armazem = require('../armazem');
(async () => {
  const pasta = path.join(__dirname, '..', 'copias');
  fs.mkdirSync(pasta, { recursive: true });
  const d = new Date(), z = n => String(n).padStart(2, '0');
  const nome = `via-abastece-${d.getFullYear()}-${z(d.getMonth() + 1)}-${z(d.getDate())}_${z(d.getHours())}${z(d.getMinutes())}`;
  let destino;
  if (armazem.remota) {
    destino = path.join(pasta, nome + '.json');
    fs.writeFileSync(destino, JSON.stringify(await armazem.exportar(), null, 1));
  } else {
    destino = path.join(pasta, nome + '.sqlite');
    await armazem.copiar(destino);
  }
  await armazem.fechar();
  console.log('✓ Cópia de segurança gravada em: ' + destino);
  console.log('  Guarde também uma cópia desta pasta noutro sítio (pen, OneDrive, servidor de ficheiros).');
})().catch(e => { console.error('A cópia falhou:', e.message); process.exit(1); });
