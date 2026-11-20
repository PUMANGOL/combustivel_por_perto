/* Onde estão o endereço e o token da base de dados Turso:
   - integração da Vercel (Storage › Turso): TURSO_DATABASE_URL e TURSO_DATABASE_TURSO_AUTH_TOKEN, criadas (e renovadas) por ela;
   - configuração à mão, ou no PC: TURSO_DATABASE_URL e TURSO_AUTH_TOKEN.
   O token da integração tem prioridade, porque é criado em par com o endereço. */
'use strict';
const crypto = require('crypto');

function configTurso(env = process.env) {
  const url = String(env.TURSO_DATABASE_URL || '').trim();
  const integracao = String(env.TURSO_DATABASE_TURSO_AUTH_TOKEN || '').trim();
  const manual = String(env.TURSO_AUTH_TOKEN || '').trim();
  return {
    url,
    token: integracao || manual,
    variavelToken: integracao ? 'TURSO_DATABASE_TURSO_AUTH_TOKEN' : manual ? 'TURSO_AUTH_TOKEN' : null,
    /* as duas definidas e diferentes: usa-se a da integração (a outra pode ser apagada) */
    duasDiferentes: !!(integracao && manual && integracao !== manual),
  };
}

/* resumo do token, para comparar o que está na Vercel com o que funciona no PC sem o mostrar:
   impressão digital curta (SHA-256) e a data de criação que vem dentro do próprio token */
function resumoToken(token) {
  if (!token) return 'nenhum token definido';
  let txt = 'impressão ' + crypto.createHash('sha256').update(token).digest('hex').slice(0, 8);
  try {
    const p = JSON.parse(Buffer.from(token.split('.')[1], 'base64url').toString('utf8'));
    const data = s => new Date(s * 1000).toISOString().slice(0, 16).replace('T', ' ') + ' UTC';
    if (p.iat) txt += ', criado em ' + data(p.iat);
    if (p.exp) txt += ', expira em ' + data(p.exp);
    if (p.a) txt += ', acesso ' + p.a;
  } catch (_) { /* não é um token no formato habitual */ }
  return txt;
}

module.exports = { configTurso, resumoToken };
