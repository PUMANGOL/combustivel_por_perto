/* Teste de segurança (auditoria técnica) do Combustível por Perto.
   Corre portais à parte (portas 3997 e 3998) com dados TEMPORÁRIOS: não toca nos dados reais.
   Uso: node scripts/teste-seguranca.js
   Com TESTE_TURSO=1, o mesmo teste corre com o cliente Turso/libSQL (num ficheiro local), o modo usado na Vercel. */
'use strict';
const os = require('os'), fs = require('fs'), path = require('path'), crypto = require('crypto');
const { pathToFileURL } = require('url');
const { spawn, execFileSync } = require('child_process');
const jwt = require('jsonwebtoken');

const RAIZ = path.join(__dirname, '..');
const pasta = fs.mkdtempSync(path.join(os.tmpdir(), 'cpp-seg-'));
const SEGREDO = crypto.randomBytes(48).toString('hex');
const res = []; let grupo = '';
const ok = (nome, cond, info = '') => res.push({ grupo, nome, ok: !!cond, info: String(info) });
const titulo = g => { grupo = g; };

function ambiente(porta, extra = {}) {
  /* a base de dados é sempre a temporária: nunca a Turso nem o ficheiro indicados no .env */
  const f = path.join(pasta, `d${porta}.sqlite`);
  return { ...process.env, DADOS_FICHEIRO: f, TURSO_DATABASE_URL: process.env.TESTE_TURSO ? pathToFileURL(f).href : '', TURSO_AUTH_TOKEN: '', TURSO_DATABASE_TURSO_AUTH_TOKEN: '', VERCEL: '',
    PORT: String(porta), HOST: '127.0.0.1', COOKIE_SECURE: 'false', TRUST_PROXY: 'loopback', JWT_SECRET: SEGREDO, LIMITE_ESCRITAS_MIN: '100000', ...extra };
}
function contas(env) {
  execFileSync(process.execPath, ['-e', `
    const a=require(${JSON.stringify(path.join(RAIZ, 'armazem'))}), b=require('bcryptjs'); const h=b.hashSync('SenhaTeste2026',12);   /* custo igual ao de produção, para a medição de tempo ser justa */
    (async () => {
      await a.criarUtilizador({utilizador:'admin1',nome:'Admin',hash:h,perfil:'admin'});
      await a.criarUtilizador({utilizador:'gestor1',nome:'Gestor',hash:h,perfil:'gestor'});
      await a.criarUtilizador({utilizador:'posto09',nome:'TALATONA',hash:h,perfil:'posto',posto:'9'});
      await a.criarUtilizador({utilizador:'alvo1',nome:'Alvo',hash:h,perfil:'gestor'}); await a.fechar();
    })().catch(e => { console.error(e); process.exit(1); });`], { cwd: RAIZ, env, stdio: 'pipe' });
}
function ligar(env) {
  return new Promise((ok_, falha) => {
    const p = spawn(process.execPath, ['server.js'], { cwd: RAIZ, env, stdio: ['ignore', 'pipe', 'pipe'] });
    let txt = ''; const t = setTimeout(() => falha(new Error('o servidor não arrancou: ' + txt)), 20000);
    p.stdout.on('data', d => { txt += d; if (/a correr/.test(txt)) { clearTimeout(t); ok_(p); } });
    p.stderr.on('data', d => { txt += d; });
  });
}
const parar = p => new Promise(r => { p.once('exit', r); p.kill(); });

(async () => {
  const E = ambiente(3997); contas(E);
  const srv = await ligar(E), BASE = 'http://127.0.0.1:3997';
  const pedido = async (metodo, url, corpo, cookie, cab = { 'X-VIA': '1' }, cru) => {
    const r = await fetch(BASE + url, { method: metodo, redirect: 'manual', headers: { 'Content-Type': 'application/json', ...cab, ...(cookie ? { Cookie: cookie } : {}) },
      body: cru !== undefined ? cru : corpo === undefined ? undefined : JSON.stringify(corpo) });
    const txt = await r.text(); let j = null; try { j = JSON.parse(txt); } catch (_) {}
    return { status: r.status, j, txt, h: r.headers, cookie: (r.headers.get('set-cookie') || '').split(';')[0], setCookie: r.headers.get('set-cookie') || '' };
  };
  const entrar = async (u, s = 'SenhaTeste2026') => (await pedido('POST', '/api/entrar', { utilizador: u, senha: s })).cookie;
  const nivel = async ck => (await pedido('GET', '/api/sessao', undefined, ck)).j.nivel;

  /* 1. cabeçalhos */
  titulo('Cabeçalhos HTTP de segurança');
  const pg = await pedido('GET', '/');
  const csp = pg.h.get('content-security-policy') || '';
  ok('Content-Security-Policy presente, só recursos do próprio portal', /default-src 'self'/.test(csp) && /object-src 'none'/.test(csp) && /frame-ancestors 'self'/.test(csp), csp);
  ok('CSP: scripts sem «unsafe-inline» nem «unsafe-eval»', /script-src [^;]*'sha256-/.test(csp) && !/script-src[^;]*unsafe-(inline|eval)/.test(csp));
  const corpoScript = (pg.txt.match(/<script>([\s\S]*?)<\/script>/) || [])[1] || '';
  ok('CSP: o hash autoriza exactamente o script da página', csp.includes(`'sha256-${crypto.createHash('sha256').update(corpoScript, 'utf8').digest('base64')}'`));
  ok('A página não carrega nada de fora (sem Google Fonts nem CDN)', !/https?:\/\/(?!www\.google\.com\/maps|wa\.me|via\.)[^"'\s]*\.(js|css)/.test(pg.txt) && !/googleapis|gstatic|cdnjs|jsdelivr/.test(pg.txt));
  ok('Sem atributos de evento em linha (onclick, onerror…)', !/\son(click|error|load|mouseover)\s*=/.test(pg.txt));
  ok('X-Content-Type-Options: nosniff', pg.h.get('x-content-type-options') === 'nosniff');
  ok('X-Frame-Options: SAMEORIGIN (protecção contra clickjacking)', pg.h.get('x-frame-options') === 'SAMEORIGIN');
  ok('Referrer-Policy definido', !!pg.h.get('referrer-policy'));
  ok('Permissions-Policy: localização só para o próprio portal; câmara e microfone bloqueados', /geolocation=\(self\)/.test(pg.h.get('permissions-policy') || '') && /camera=\(\)/.test(pg.h.get('permissions-policy') || ''));
  ok('Cross-Origin-Opener-Policy: same-origin', pg.h.get('cross-origin-opener-policy') === 'same-origin');
  ok('Sem cabeçalho X-Powered-By (não revela a tecnologia)', !pg.h.get('x-powered-by'));
  ok('Respostas da API não ficam em cache', (await pedido('GET', '/api/sessao')).h.get('cache-control') === 'no-store');

  /* 2. ficheiros que não podem ser descarregados */
  titulo('Exposição de ficheiros');
  for (const u of ['/.env', '/.env.example', '/server.js', '/armazem.js', '/package.json', '/dados/via-abastece.sqlite', '/scripts/teste-seguranca.js', '/%2e%2e/.env', '/..%2f.env', '/public/../.env', '/node_modules/jsonwebtoken/package.json']) {
    const x = await pedido('GET', u);
    ok(`Não se descarrega ${u}`, x.status === 404 || (x.status === 200 && !x.txt.includes('JWT_SECRET') && !x.txt.includes('require(') && /<!doctype html>/i.test(x.txt) === false && x.txt.length < 10), `estado ${x.status}`);
  }

  /* 3. sessões e cookies */
  titulo('Sessões e cookies');
  const login = await pedido('POST', '/api/entrar', { utilizador: 'admin1', senha: 'SenhaTeste2026' });
  ok('Cookie de sessão HttpOnly (inacessível a scripts)', /HttpOnly/i.test(login.setCookie));
  ok('Cookie de sessão SameSite=Strict (protecção CSRF)', /SameSite=Strict/i.test(login.setCookie));
  ok('Cookie de sessão com validade de 12 horas', /Max-Age=43200/i.test(login.setCookie));
  const A = login.cookie, G = await entrar('gestor1'), P = await entrar('posto09');
  const tok = decodeURIComponent(A.split('=')[1]), dec = jwt.decode(tok, { complete: true });
  ok('Sessão assinada com HS256', dec && dec.header.alg === 'HS256');
  ok('A sessão não contém a senha nem o hash da senha', !/\$2[aby]\$/.test(JSON.stringify(dec.payload)) && !('senha' in dec.payload));
  const nome = A.split('=')[0];
  const nenhum = Buffer.from(JSON.stringify({ alg: 'none', typ: 'JWT' })).toString('base64url') + '.' + Buffer.from(JSON.stringify({ ...dec.payload })).toString('base64url') + '.';
  ok('Sessão com algoritmo «none» é recusada', await nivel(`${nome}=${nenhum}`) === 'cliente');
  const pdec = jwt.decode(decodeURIComponent(P.split('=')[1]));
  const { iat: _i, exp: _e, ...semDatas } = pdec;
  const forjado = jwt.sign({ ...semDatas, perfil: 'admin' }, 'segredo-errado', { algorithm: 'HS256', expiresIn: '1h' });
  ok('Sessão assinada com outra chave é recusada', await nivel(`${nome}=${forjado}`) === 'cliente');
  const partes = decodeURIComponent(P.split('=')[1]).split('.'), alterado = Buffer.from(JSON.stringify({ ...pdec, perfil: 'admin' })).toString('base64url');
  ok('Sessão de posto alterada para «admin» é recusada', await nivel(`${nome}=${partes[0]}.${alterado}.${partes[2]}`) === 'cliente');
  const expirado = jwt.sign({ ...dec.payload, iat: Math.floor(Date.now() / 1000) - 50000, exp: Math.floor(Date.now() / 1000) - 10 }, SEGREDO, { algorithm: 'HS256' });
  ok('Sessão expirada é recusada', await nivel(`${nome}=${expirado}`) === 'cliente');
  const Alvo = await entrar('alvo1');
  await pedido('POST', '/api/contas/alvo1/senha', { senha: 'NovaSenhaAlvo2026' }, A);
  ok('Senha reposta pelo admin: as sessões abertas dessa conta terminam', await nivel(Alvo) === 'cliente');
  const Alvo2 = await entrar('alvo1', 'NovaSenhaAlvo2026');
  await pedido('POST', '/api/contas/alvo1/estado', { activo: false }, A);
  ok('Conta desactivada: a sessão aberta termina de imediato', await nivel(Alvo2) === 'cliente');
  const G2 = await entrar('gestor1');
  const mud = await pedido('POST', '/api/senha', { actual: 'SenhaTeste2026', nova: 'SenhaGestorNova26' }, G2);
  ok('Mudar a própria senha termina as outras sessões da conta', mud.status === 200 && await nivel(G) === 'cliente');
  ok('… e mantém a sessão de quem mudou a senha', await nivel(mud.cookie) === 'gestor');
  const Gn = mud.cookie;
  const sair = await pedido('POST', '/api/sair', {}, Gn);
  ok('Sair apaga o cookie de sessão', /Max-Age=0|Expires=Thu, 01 Jan 1970/i.test(sair.setCookie));

  /* 4. CSRF */
  titulo('Protecção contra pedidos forjados (CSRF)');
  ok('Escrita sem o cabeçalho do portal é recusada, mesmo com sessão válida', (await pedido('POST', '/api/confirmar', { posto: 9, momento: 'Reconfirmação', responsavel: 'X', itens: [{ prod: 'GA', estado: 'venda' }] }, P, {})).status === 403);
  ok('Entrada sem o cabeçalho do portal é recusada', (await pedido('POST', '/api/entrar', { utilizador: 'admin1', senha: 'SenhaTeste2026' }, null, {})).status === 403);
  ok('Pedido com formulário (text/plain) não é aceite como JSON', (await pedido('POST', '/api/confirmar', undefined, P, { 'X-VIA': '1', 'Content-Type': 'text/plain' }, 'posto=9')).status >= 400);

  /* 5. controlo de acessos */
  titulo('Controlo de acessos por perfil');
  const matriz = [
    ['GET', '/api/contas', null, 401], ['GET', '/api/auditoria', null, 401], ['GET', '/api/historico?posto=9&prod=GA', null, 401],
    ['GET', '/api/auditoria', P, 403], ['GET', '/api/contas', P, 403], ['PUT', '/api/c/postos/9', P, 403], ['PUT', '/api/c/config/geral', P, 403],
    ['GET', '/api/auditoria', Gn, 403], ['GET', '/api/contas', Gn, 403], ['POST', '/api/confirmar-rede', Gn, 403], ['POST', '/api/contas', Gn, 403],
    ['DELETE', '/api/c/postos/9', Gn, 403], ['PUT', '/api/c/confirmacoes/c-9-GA', A, 405], ['PUT', '/api/c/registos/c-9-GA', A, 405],
    ['GET', '/api/auditoria', A, 200], ['GET', '/api/contas', A, 200],
  ];
  for (const [m, u, ck, esp] of matriz) {
    const x = await pedido(m, u, m === 'GET' ? undefined : {}, ck);
    ok(`${m} ${u} como ${ck === A ? 'admin' : ck === Gn ? 'gestor' : ck === P ? 'posto' : 'cliente'} → ${esp}`, x.status === esp, `obtido ${x.status}`);
  }
  ok('O cliente não recebe nomes de quem confirmou', (await pedido('GET', '/api/c/registos')).j.length === 0);
  ok('A lista de contas não inclui hashes de senhas', !/\$2[aby]\$|senha_hash/.test((await pedido('GET', '/api/contas', undefined, A)).txt));

  /* 6. injecção e validação */
  titulo('Injecção e validação de dados');
  ok('Identificador com SQL é recusado', (await pedido('PUT', `/api/c/postos/${encodeURIComponent("9' OR '1'='1")}`, { id: 'x' }, A)).status === 400);
  ok('Parâmetro do histórico com SQL é recusado', (await pedido('GET', `/api/historico?posto=${encodeURIComponent("9' OR '1'='1")}&prod=GA`, undefined, A)).status === 400);
  ok('Posto com SQL na confirmação é recusado', (await pedido('POST', '/api/confirmar', { posto: '9; DROP TABLE confirmacoes', momento: 'Reconfirmação', responsavel: 'X', itens: [{ prod: 'GA', estado: 'venda' }] }, A)).status === 400);
  ok('Nome com código HTML é recusado na criação de conta', (await pedido('POST', '/api/contas', { utilizador: 'xss1', nome: '<img src=x onerror=alert(1)>', perfil: 'gestor', senha: 'SenhaXss202620' }, A)).status === 400);
  ok('Responsável com código HTML é recusado na confirmação', (await pedido('POST', '/api/confirmar', { posto: 9, momento: 'Reconfirmação', responsavel: '<script>alert(1)</script>', itens: [{ prod: 'GA', estado: 'venda' }] }, P)).status === 400);
  ok('Posto com código HTML no nome é recusado (mesmo vindo do admin)', (await pedido('PUT', '/api/c/postos/9', { id: 9, nome: 'TALATONA <img src=x onerror=alert(1)>', municipio: 'Samba', provincia: 'Luanda', lat: -8.9, lng: 13.19 }, A)).status === 400);
  ok('Posto com campos desconhecidos ou coordenadas fora de Angola é recusado', (await pedido('PUT', '/api/c/postos/9', { id: 9, nome: 'X', lat: 40, lng: 13 }, A)).status === 400 && (await pedido('PUT', '/api/c/postos/9', { id: 9, nome: 'X', script: 'y' }, A)).status === 400);
  ok('Posto válido gravado pelo admin é aceite', (await pedido('PUT', '/api/c/postos/9', { id: 9, nome: 'TALATONA', municipio: 'Samba', provincia: 'Luanda', lat: -8.9018, lng: 13.203 }, A)).status === 200);
  ok('Configuração inválida é recusada', (await pedido('PUT', '/api/c/config/geral', { validadeMin: 'x' }, A)).status === 400);
  ok('Pedido com mais de 200 kB é recusado (413)', (await pedido('POST', '/api/confirmar', undefined, P, { 'X-VIA': '1' }, JSON.stringify({ x: 'a'.repeat(300000) }))).status === 413);
  const mal = await pedido('POST', '/api/confirmar', undefined, P, { 'X-VIA': '1' }, '{"posto": 9,');
  ok('JSON mal formado: 400 sem pormenores internos', mal.status === 400 && !/at |node_modules|SyntaxError/.test(mal.txt));
  ok('Rota inexistente da API: 404 em JSON, sem pormenores', (await pedido('GET', '/api/nao-existe')).status === 404);
  ok('Senha com mais de 72 caracteres é recusada (limite do bcrypt)', (await pedido('POST', '/api/contas', { utilizador: 'longo1', nome: 'Longo', perfil: 'gestor', senha: 'x'.repeat(80) }, A)).status === 400);
  ok('Senha com menos de 10 caracteres é recusada', (await pedido('POST', '/api/contas', { utilizador: 'curto1', nome: 'Curto', perfil: 'gestor', senha: 'curta' }, A)).status === 400);
  ok('O último admin não pode ser desactivado', (await pedido('POST', '/api/contas/admin1/estado', { activo: false }, A)).status === 400);

  /* 7. tempo real */
  titulo('Ligações de tempo real');
  /* as respostas ficam guardadas: sem isso o fetch pode libertá-las e fechar as ligações a meio do teste */
  const ctls = [], sts = [], abertas = [];
  for (let i = 0; i < 51; i++) { const c = new AbortController(); ctls.push(c); sts.push(await fetch(BASE + '/api/eventos', { signal: c.signal, headers: { 'X-Forwarded-For': '10.9.9.9' } }).then(r => { abertas.push(r); return r.status; }).catch(() => 0)); }
  const outro = await fetch(BASE + '/api/eventos', { headers: { 'X-Forwarded-For': '10.9.9.10' } }).then(r => { r.body.cancel(); return r.status; });
  ctls.forEach(c => c.abort());
  ok('No máximo 50 ligações de tempo real por visitante', sts.slice(0, 50).every(s => s === 200) && sts[50] === 429, sts.filter(s => s !== 200).length);
  ok('Atrás do túnel/proxy local, cada visitante conta à parte (os limites não bloqueiam toda a gente)', outro === 200);
  await new Promise(z => setTimeout(z, 300));

  /* 8. armazenamento */
  titulo('Armazenamento');
  const db = JSON.parse(execFileSync(process.execPath, ['-e', `
    const {DatabaseSync}=require('node:sqlite'); const d=new DatabaseSync(${JSON.stringify(E.DADOS_FICHEIRO)});
    console.log(JSON.stringify({h:d.prepare('SELECT senha_hash FROM utilizadores').all().map(r=>r.senha_hash), ic:d.prepare('PRAGMA integrity_check').get()}));`], { stdio: ['ignore', 'pipe', 'ignore'] }).toString());
  ok('Senhas guardadas com bcrypt (nunca em texto)', db.h.every(h => /^\$2[aby]\$\d\d\$/.test(h)));
  ok('Base de dados íntegra depois dos ataques (integrity_check)', Object.values(db.ic)[0] === 'ok');

  /* 9. auditoria (lida pela própria API, como o admin a vê) */
  titulo('Registo de auditoria');
  await pedido('POST', '/api/entrar', { utilizador: 'gestor1', senha: 'senha-errada-de-teste' });
  const aud = (await pedido('GET', '/api/auditoria?limite=500', undefined, A)).j || [];
  const acc = new Set(aud.map(x => x.accao));
  for (const a of ['entrada', 'entrada_falhada', 'saida', 'senha_reposta', 'conta_desactivada', 'senha_propria_alterada'])
    ok(`Fica registado: ${a}`, acc.has(a));
  ok('O registo de auditoria não contém senhas', aud.length > 0 && !JSON.stringify(aud).match(/SenhaTeste2026|NovaSenhaAlvo2026|SenhaGestorNova26|senha-errada-de-teste/));
  ok('O registo de auditoria indica o endereço IP de cada acção', aud.every(x => x.ip));

  /* 10. força bruta (no fim: bloqueia o endereço IP do teste) */
  titulo('Ataques de força bruta e enumeração');
  const tempo = async (u, s) => { const t0 = process.hrtime.bigint(); const x = await pedido('POST', '/api/entrar', { utilizador: u, senha: s }); return { ms: Number(process.hrtime.bigint() - t0) / 1e6, x }; };
  const t1 = await tempo('posto09', 'errada-1'), t2 = await tempo('naoexiste99', 'errada-1');
  ok('Mesma mensagem para conta inexistente e senha errada', t1.x.txt === t2.x.txt && t1.x.status === 401 && t2.x.status === 401);
  ok('Tempo de resposta semelhante (não revela se a conta existe)', Math.abs(t1.ms - t2.ms) < Math.max(t1.ms, t2.ms) * 0.6, `${t1.ms.toFixed(0)} ms / ${t2.ms.toFixed(0)} ms`);
  for (let i = 0; i < 4; i++) await pedido('POST', '/api/entrar', { utilizador: 'posto09', senha: 'errada' + i });
  ok('Depois de 5 senhas erradas a conta fica bloqueada 15 min (mesmo com a senha certa)', (await pedido('POST', '/api/entrar', { utilizador: 'posto09', senha: 'SenhaTeste2026' })).status === 429);
  ok('O bloqueio de uma conta não impede as outras de entrar', !!(await entrar('admin1')));
  for (let i = 0; i < 20; i++) await pedido('POST', '/api/entrar', { utilizador: 'qualquer' + i, senha: 'x' });
  ok('Depois de 20 falhas do mesmo IP, esse IP fica bloqueado 15 min', (await pedido('POST', '/api/entrar', { utilizador: 'admin1', senha: 'SenhaTeste2026' })).status === 429);
  await parar(srv);

  /* 11. produção: HTTPS */
  titulo('Configuração de produção (HTTPS)');
  const E2 = ambiente(3998, { COOKIE_SECURE: 'true' }); contas(E2);
  const srv2 = await ligar(E2);
  const r2 = await fetch('http://127.0.0.1:3998/api/entrar', { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-VIA': '1' }, body: JSON.stringify({ utilizador: 'admin1', senha: 'SenhaTeste2026' }) });
  const sc = r2.headers.get('set-cookie') || '';
  ok('Em HTTPS o cookie é «Secure» e usa o prefixo __Host-', /^__Host-/.test(sc) && /;\s*Secure/i.test(sc), sc.split(';').slice(1).join(';'));
  ok('Em HTTPS o servidor envia Strict-Transport-Security', !!r2.headers.get('strict-transport-security'));
  await parar(srv2);

  fs.rmSync(pasta, { recursive: true, force: true });
  const falhas = res.filter(y => !y.ok);
  console.log('\nTeste de segurança — Combustível por Perto\n');
  let g = '';
  res.forEach((y, i) => { if (y.grupo !== g) { g = y.grupo; console.log('\n ' + g); } console.log(`  ${y.ok ? '✓' : '✗'} ${i + 1}. ${y.nome}${!y.ok && y.info ? '  [' + y.info + ']' : ''}`); });
  console.log(`\n${res.length - falhas.length} de ${res.length} verificações passaram.${falhas.length ? '' : ' Nenhuma vulnerabilidade encontrada nestes testes.'}\n`);
  process.exit(falhas.length ? 1 : 0);
})().catch(e => { console.error('Erro no teste:', e); try { fs.rmSync(pasta, { recursive: true, force: true }); } catch (_) {} process.exit(1); });
