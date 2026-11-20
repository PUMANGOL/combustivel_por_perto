/* Faz uma cópia de segurança dos dados do portal (confirmações, contas…) para a pasta copias/.
   Pode correr com o portal ligado. Uso: npm run copia */
'use strict';
require('../preparar-env');
const fs = require('fs');
const path = require('path');
const armazem = require('../armazem');
const pasta = path.join(__dirname, '..', 'copias');
fs.mkdirSync(pasta, { recursive: true });
const d = new Date(), z = n => String(n).padStart(2, '0');
const nome = `via-abastece-${d.getFullYear()}-${z(d.getMonth() + 1)}-${z(d.getDate())}_${z(d.getHours())}${z(d.getMinutes())}.sqlite`;
const destino = path.join(pasta, nome);
armazem.copiar(destino);
armazem.fechar();
console.log('✓ Cópia de segurança gravada em: ' + destino);
console.log('  Guarde também uma cópia desta pasta noutro sítio (pen, OneDrive, servidor de ficheiros).');
