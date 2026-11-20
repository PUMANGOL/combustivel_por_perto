/* Prepara a configuração antes de tudo o resto:
   - se não existir .env, cria-o a partir de .env.example;
   - se a chave secreta (JWT_SECRET) estiver vazia, gera uma nova.
   Assim, quem instala não precisa de editar nada para começar. */
'use strict';
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const pasta = __dirname, env = path.join(pasta, '.env'), modelo = path.join(pasta, '.env.example');
try {
  if (!fs.existsSync(env) && fs.existsSync(modelo)) fs.copyFileSync(modelo, env);
  if (fs.existsSync(env)) {
    const txt = fs.readFileSync(env, 'utf8');
    if (/^JWT_SECRET=\s*$/m.test(txt) || !/^JWT_SECRET=/m.test(txt)) {
      const chave = crypto.randomBytes(48).toString('hex');
      const novo = /^JWT_SECRET=/m.test(txt) ? txt.replace(/^JWT_SECRET=\s*$/m, 'JWT_SECRET=' + chave) : txt + '\nJWT_SECRET=' + chave + '\n';
      fs.writeFileSync(env, novo);
      console.log('Chave secreta criada no ficheiro .env.');
    }
  }
} catch (e) { console.warn('Não foi possível preparar o ficheiro .env:', e.message); }
require('dotenv').config({ path: env, quiet: true });
