/* Passo de build na Vercel (vercel.json › buildCommand).
   A pasta de ficheiros estáticos só tem o robots.txt (a Vercel não aceita a pasta vazia): assim nenhum ficheiro do
   projecto é publicado tal como está, e a página e os ficheiros de public/ são servidos pela função (api/index.js),
   com os cabeçalhos de segurança.
   Também confirma que a configuração obrigatória existe, para o erro aparecer no build e não no portal. */
'use strict';
const fs = require('fs');
const path = require('path');

const saida = path.join(__dirname, '..', 'vercel-estatico');
fs.rmSync(saida, { recursive: true, force: true });
fs.mkdirSync(saida, { recursive: true });
fs.writeFileSync(path.join(saida, 'robots.txt'), 'User-agent: *\nDisallow: /api/\n');

const falta = [];
if (!process.env.TURSO_DATABASE_URL) falta.push('TURSO_DATABASE_URL');
if (!process.env.TURSO_AUTH_TOKEN) falta.push('TURSO_AUTH_TOKEN');
if (!process.env.JWT_SECRET || process.env.JWT_SECRET.length < 32) falta.push('JWT_SECRET (mínimo 32 caracteres)');
if (falta.length) {
  console.error('\nFaltam variáveis de ambiente no projecto da Vercel (Settings › Environment Variables):');
  falta.forEach(v => console.error('  - ' + v));
  console.error('Ver VERCEL.md. Depois de as definir, faça Redeploy.\n');
  process.exit(1);
}
console.log('Configuração da Vercel completa. A página e a API são servidas pela função api/index.js.');
