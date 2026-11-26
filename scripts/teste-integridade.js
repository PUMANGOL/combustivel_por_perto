/* Teste de consistência e integridade das confirmações dos postos.
   Corre um portal à parte (porta 3999) com um ficheiro de dados TEMPORÁRIO: não toca nos dados reais.
   Uso: node scripts/teste-integridade.js */
'use strict';
const os = require('os'), fs = require('fs'), path = require('path'), crypto = require('crypto');
const { spawn, execFileSync } = require('child_process');

const pasta = fs.mkdtempSync(path.join(os.tmpdir(), 'cpp-teste-'));
const FICH = path.join(pasta, 'teste.sqlite'), PORTA = 3999, BASE = `http://127.0.0.1:${PORTA}`;
const ENV = { ...process.env, DADOS_FICHEIRO: FICH, PORT: String(PORTA), HOST: '127.0.0.1', COOKIE_SECURE: 'false', TRUST_PROXY: '0', JWT_SECRET: crypto.randomBytes(48).toString('hex'), LIMITE_ESCRITAS_MIN: '100000' };
const RAIZ = path.join(__dirname, '..');
const res = []; const ok = (nome, cond, info = '') => { res.push({ nome, ok: !!cond, info }); };

/* contas de teste criadas directamente no ficheiro temporário */
function prepararContas() {
  execFileSync(process.execPath, ['-e', `
    process.env.DADOS_FICHEIRO=${JSON.stringify(FICH)};
    const a=require(${JSON.stringify(path.join(RAIZ, 'armazem'))}), b=require('bcryptjs');
    const h=b.hashSync('SenhaTeste2026',4);
    a.criarUtilizador({utilizador:'admin1',nome:'Admin',hash:h,perfil:'admin'});
    a.criarUtilizador({utilizador:'gestor1',nome:'Gestor',hash:h,perfil:'gestor'});
    a.criarUtilizador({utilizador:'posto09',nome:'TALATONA',hash:h,perfil:'posto',posto:'9'});
    a.criarUtilizador({utilizador:'posto11',nome:'11 DE NOVEMBRO',hash:h,perfil:'posto',posto:'11'});
    a.fechar();`], { cwd: RAIZ, env: ENV, stdio: 'pipe' });
}
function ligar() {
  return new Promise((ok_, falha) => {
    const p = spawn(process.execPath, ['server.js'], { cwd: RAIZ, env: ENV, stdio: ['ignore', 'pipe', 'pipe'] });
    let txt = ''; const t = setTimeout(() => falha(new Error('o servidor não arrancou: ' + txt)), 15000);
    p.stdout.on('data', d => { txt += d; if (/a correr/.test(txt)) { clearTimeout(t); ok_(p); } });
    p.stderr.on('data', d => { txt += d; });
  });
}
const parar = p => new Promise(r => { p.once('exit', r); p.kill(); });
async function pedido(metodo, url, corpo, cookie) {
  const r = await fetch(BASE + url, { method: metodo, headers: { 'Content-Type': 'application/json', 'X-VIA': '1', ...(cookie ? { Cookie: cookie } : {}) }, body: corpo === undefined ? undefined : JSON.stringify(corpo) });
  let j = null; try { j = await r.json(); } catch (_) {}
  return { status: r.status, j, cookie: (r.headers.get('set-cookie') || '').split(';')[0] };
}
const entrar = async u => (await pedido('POST', '/api/entrar', { utilizador: u, senha: 'SenhaTeste2026' })).cookie;
const confirmar = (ck, corpo) => pedido('POST', '/api/confirmar', corpo, ck);
const lista = async (col, ck) => (await pedido('GET', '/api/c/' + col, undefined, ck)).j;
const doc = (l, id) => (l.find(x => x.id === id) || {}).dados;
function lerDB() {
  return JSON.parse(execFileSync(process.execPath, ['-e', `
    process.env.DADOS_FICHEIRO=${JSON.stringify(FICH)};
    const a=require(${JSON.stringify(path.join(RAIZ, 'armazem'))}), P=require(${JSON.stringify(path.join(RAIZ, 'postos'))});
    console.log(JSON.stringify({conf:a.listar('confirmacoes'), reg:a.listar('registos'), contas:a.contas(), integ:a.integridade(P.validos(a))}));`],
    { cwd: RAIZ, env: ENV }).toString().trim().split('\n').pop());
}

(async () => {
  prepararContas();
  let srv = await ligar();
  const A = await entrar('admin1'), G = await entrar('gestor1'), P9 = await entrar('posto09'), P11 = await entrar('posto11');
  ok('1. As quatro contas de teste entram no portal', A && G && P9 && P11);
  let db0 = lerDB();
  ok('Estado inicial: os 83 postos começam com gasolina e gasóleo «Disponível»', db0.conf.length === 166 && db0.conf.every(x => x.dados[x.dados.prod] === 'venda' && x.dados.inicial === true), db0.conf.length);
  ok('Estado inicial: cada um tem o registo correspondente', db0.reg.length === 166 && db0.integ.ok, db0.integ.problemas.join(' | '));
  ok('O cliente vê o estado inicial como «Disponível»', doc(await lista('confirmacoes'), 'c-11-GA')?.GA === 'venda');

  /* --- gravação simples e substituição --- */
  let r = await confirmar(P9, { posto: 9, momento: 'Início de turno', responsavel: 'João', itens: [{ prod: 'GA', estado: 'venda' }, { prod: 'GO', estado: 'venda' }] });
  ok('2. Posto confirma gasolina e gasóleo Disponível', r.status === 200, r.status);
  let db = lerDB();
  ok('3. Ficou exactamente uma confirmação por combustível', db.conf.filter(x => x.id.startsWith('c-9-')).length === 2);
  const cGA = doc(db.conf, 'c-9-GA'), rGA = doc(db.reg, 'c-9-GA');
  ok('4. Confirmação e registo de quem confirmou têm a mesma hora', cGA && rGA && cGA.hora === rGA.hora);
  ok('5. O nome do responsável não está na tabela pública', cGA && !('utilizador' in cGA) && rGA.utilizador === 'João');
  ok('6. A hora gravada é a do servidor (± 5 s)', cGA && Math.abs(cGA.hora - Date.now()) < 5000);
  ok('7. O cliente vê a gasolina do Talatona como Disponível', doc(await lista('confirmacoes'), 'c-9-GA')?.GA === 'venda');

  r = await confirmar(P9, { posto: 9, momento: 'Combustível esgotado', responsavel: 'Maria', itens: [{ prod: 'GA', estado: 'interrompida' }] });
  db = lerDB();
  ok('8. Nova confirmação substitui a anterior (continua uma só)', r.status === 200 && db.conf.filter(x => x.id === 'c-9-GA').length === 1 && doc(db.conf, 'c-9-GA').GA === 'interrompida');
  ok('9. O registo passou para a responsável da nova confirmação', doc(db.reg, 'c-9-GA').utilizador === 'Maria');
  ok('10. O gasóleo, não confirmado de novo, ficou como estava', doc(db.conf, 'c-9-GO').GO === 'venda');
  const pub = await lista('confirmacoes');
  ok('11. O cliente não recebe «Indisponível» (vê «Disponibilidade por confirmar»)', !doc(pub, 'c-9-GA') && !JSON.stringify(pub).includes('interrompida'));
  ok('12. O gestor vê «Indisponível»', doc(await lista('confirmacoes', G), 'c-9-GA')?.GA === 'interrompida');
  ok('13. O próprio posto vê o seu «Indisponível»', doc(await lista('confirmacoes', P9), 'c-9-GA')?.GA === 'interrompida');
  ok('14. Outra conta de posto vê o estado de toda a rede (incluindo o «Indisponível» do Talatona)', doc(await lista('confirmacoes', P11), 'c-9-GA')?.GA === 'interrompida');
  ok('15. O cliente não vê quem confirmou', (await lista('registos')).length === 0);
  ok('16. Um posto só vê os registos do seu posto', (await lista('registos', P11)).every(x => String(x.dados.posto) === '11'));

  /* --- validações --- */
  const casos = [
    ['17. «Combustível esgotado» com Disponível é recusado', P9, { posto: 9, momento: 'Combustível esgotado', responsavel: 'X', itens: [{ prod: 'GA', estado: 'venda' }] }, 400],
    ['18. «Venda retomada» com Indisponível é recusado', P9, { posto: 9, momento: 'Venda retomada', responsavel: 'X', itens: [{ prod: 'GO', estado: 'interrompida' }] }, 400],
    ['19. Momento desconhecido é recusado', P9, { posto: 9, momento: 'Verificação', responsavel: 'X', itens: [{ prod: 'GA', estado: 'venda' }] }, 400],
    ['20. Sem nome do responsável é recusado', P9, { posto: 9, momento: 'Reconfirmação', responsavel: '  ', itens: [{ prod: 'GA', estado: 'venda' }] }, 400],
    ['21. Combustível repetido é recusado', P9, { posto: 9, momento: 'Reconfirmação', responsavel: 'X', itens: [{ prod: 'GA', estado: 'venda' }, { prod: 'GA', estado: 'interrompida' }] }, 400],
    ['22. Posto inexistente é recusado', G, { posto: 9999, momento: 'Reconfirmação', responsavel: 'X', itens: [{ prod: 'GA', estado: 'venda' }] }, 400],
    ['23. Um posto não confirma outro posto', P9, { posto: 11, momento: 'Reconfirmação', responsavel: 'X', itens: [{ prod: 'GA', estado: 'venda' }] }, 403],
    ['24. Sem sessão não se confirma', null, { posto: 9, momento: 'Reconfirmação', responsavel: 'X', itens: [{ prod: 'GA', estado: 'venda' }] }, 401],
  ];
  for (const [n, ck, corpo, esp] of casos) { const x = await confirmar(ck, corpo); ok(n, x.status === esp, `obtido ${x.status}`); }
  db = lerDB();
  ok('25. As tentativas recusadas não alteraram nada', doc(db.conf, 'c-9-GA').GA === 'interrompida' && doc(db.conf, 'c-11-GA').inicial === true && !db.conf.some(x => x.id.startsWith('c-9999')));
  let x = await pedido('PUT', '/api/c/confirmacoes/c-9-GA', { id: 'c-9-GA', posto: 9, prod: 'GA', hora: Date.now(), GA: 'venda' }, A);
  ok('26. Nem o admin escreve confirmações por fora do ecrã do posto', x.status === 405, x.status);
  x = await confirmar(P9, { posto: 9, momento: 'Venda retomada', responsavel: 'Ana', hora: 0, itens: [{ prod: 'GA', estado: 'venda' }] });
  ok('27. Uma hora enviada pelo aparelho é ignorada', x.status === 200 && Math.abs(doc(lerDB().conf, 'c-9-GA').hora - Date.now()) < 5000);

  /* --- gestor: fica sempre o nome da conta --- */
  x = await confirmar(G, { posto: 11, momento: 'Reconfirmação', responsavel: 'Outro nome qualquer', itens: [{ prod: 'GO', estado: 'interrompida' }] });
  db = lerDB();
  ok('Gestor altera o estado de um posto: fica gravado o nome do gestor', x.status === 200 && doc(db.reg, 'c-11-GO').utilizador === 'Gestor' && doc(db.conf, 'c-11-GO').GO === 'interrompida');

  /* --- admin: toda a rede de uma só vez --- */
  x = await pedido('POST', '/api/confirmar-rede', { momento: 'Reconfirmação', itens: [{ prod: 'GA', estado: 'venda' }] }, G);
  ok('Gestor não pode confirmar a rede toda', x.status === 403, x.status);
  x = await pedido('POST', '/api/confirmar-rede', { momento: 'Venda retomada', itens: [{ prod: 'GA', estado: 'interrompida' }] }, A);
  ok('Rede toda: combinação errada de momento e estado é recusada', x.status === 400, x.status);
  const goAntes = JSON.stringify(lerDB().conf.filter(y => y.id.endsWith('-GO')));
  x = await pedido('POST', '/api/confirmar-rede', { momento: 'Combustível esgotado', itens: [{ prod: 'GA', estado: 'interrompida' }] }, A);
  db = lerDB();
  const ga = db.conf.filter(y => y.id.endsWith('-GA'));
  ok('Admin confirma a rede toda de uma só vez: os 83 postos com gasolina «Indisponível»', x.status === 200 && x.j.postos === 83 && ga.length === 83 && ga.every(y => y.dados.GA === 'interrompida'));
  ok('Rede toda: todos com a mesma hora e o nome do admin no registo', new Set(ga.map(y => y.dados.hora)).size === 1 && db.reg.filter(y => y.id.endsWith('-GA')).every(y => y.dados.utilizador === 'Admin'));
  ok('Rede toda: o gasóleo, não indicado, ficou exactamente como estava', JSON.stringify(db.conf.filter(y => y.id.endsWith('-GO'))) === goAntes);
  ok('Rede toda: o cliente não recebe nenhum «Indisponível»', !JSON.stringify(await lista('confirmacoes')).includes('interrompida'));
  x = await pedido('POST', '/api/confirmar-rede', { momento: 'Venda retomada', itens: [{ prod: 'GA', estado: 'venda' }, { prod: 'GO', estado: 'venda' }] }, A);
  ok('Admin repõe a rede toda «Disponível»', x.status === 200 && lerDB().conf.every(y => y.dados[y.dados.prod] === 'venda'));

  /* --- histórico: as 5 últimas por posto e combustível --- */
  for (let i = 0; i < 7; i++) {
    await confirmar(P9, { posto: 9, momento: 'Reconfirmação', responsavel: 'H' + i, itens: [{ prod: 'GO', estado: i % 2 ? 'interrompida' : 'venda' }] });
    await new Promise(z => setTimeout(z, 5));
  }
  let h = (await pedido('GET', '/api/historico?posto=9&prod=GO', undefined, P9)).j;
  ok('Histórico: guarda no máximo 5 confirmações por combustível', Array.isArray(h) && h.length === 5, h && h.length);
  ok('Histórico: da mais recente para a mais antiga, com produto, data/hora e nome', h[0].utilizador === 'H6' && h[4].utilizador === 'H2' && h.every((y, i) => y.prod === 'GO' && Number.isFinite(y.hora) && (!i || h[i - 1].hora >= y.hora)));
  const dbh = lerDB();
  ok('Histórico: a entrada mais recente é igual à confirmação actual', h[0].hora === doc(dbh.conf, 'c-9-GO').hora && h[0].estado === doc(dbh.conf, 'c-9-GO').GO);
  ok('Histórico: uma conta de posto não vê o histórico de outro posto', (await pedido('GET', '/api/historico?posto=11&prod=GO', undefined, P9)).status === 403);
  ok('Histórico: o cliente (sem sessão) não vê o histórico', (await pedido('GET', '/api/historico?posto=9&prod=GO')).status === 401);
  ok('Histórico: o gestor vê o histórico de qualquer posto', (await pedido('GET', '/api/historico?posto=11&prod=GO', undefined, G)).status === 200);
  const hga = (await pedido('GET', '/api/historico?posto=50&prod=GA', undefined, A)).j;
  ok('Histórico: a confirmação da rede toda pelo admin também fica registada', hga.length >= 1 && hga[0].utilizador === 'Admin');
  ok('Histórico: o estado inicial não conta como confirmação', (await pedido('GET', '/api/historico?posto=12&prod=GO', undefined, A)).j.every(y => y.utilizador !== 'Estado inicial do portal'));

  /* --- muitas confirmações em simultâneo --- */
  const envios = [];
  for (let i = 0; i < 60; i++) {
    const ck = i % 2 ? P9 : G, est = i % 3 ? 'venda' : 'interrompida';
    envios.push(confirmar(ck, { posto: 9, momento: 'Reconfirmação', responsavel: 'R' + i, itens: [{ prod: i % 4 < 2 ? 'GA' : 'GO', estado: est }] }));
  }
  const sts = (await Promise.all(envios)).map(y => y.status);
  db = lerDB();
  ok('28. 60 confirmações em simultâneo foram todas aceites', sts.every(s => s === 200), sts.filter(s => s !== 200).length + ' falharam');
  ok('29. Depois delas continua a haver uma só confirmação por combustível', db.conf.filter(y => y.id === 'c-9-GA').length === 1 && db.conf.filter(y => y.id === 'c-9-GO').length === 1);
  ok('30. Confirmação e registo continuam emparelhados (mesma hora)', ['c-9-GA', 'c-9-GO'].every(id => doc(db.conf, id).hora === doc(db.reg, id).hora));
  ok('31. Verificação de integridade da base: sem problemas', db.integ.ok, db.integ.problemas.join(' | '));
  const h9 = [(await pedido('GET', '/api/historico?posto=9&prod=GA', undefined, A)).j, (await pedido('GET', '/api/historico?posto=9&prod=GO', undefined, A)).j];
  ok('Histórico: depois de 60 confirmações em simultâneo continua no máximo 5', h9.every(y => y.length <= 5));

  /* --- tempo real --- */
  const ctl = new AbortController(); let recebeu = false;
  const sse = fetch(BASE + '/api/eventos', { signal: ctl.signal }).then(async rr => { const rd = rr.body.getReader(); const dec = new TextDecoder(); let t = '';
    for (;;) { const { value, done } = await rd.read(); if (done) break; t += dec.decode(value); if (/data: confirmacoes/.test(t)) { recebeu = true; break; } } }).catch(() => {});
  await new Promise(z => setTimeout(z, 300));
  await confirmar(P9, { posto: 9, momento: 'Reconfirmação', responsavel: 'SSE', itens: [{ prod: 'GO', estado: 'venda' }] });
  await Promise.race([sse, new Promise(z => setTimeout(z, 3000))]); ctl.abort();
  ok('32. Os ecrãs abertos são avisados da nova confirmação', recebeu);

  /* --- perfis --- */
  ok('33. Conta de posto não vê as contas', (await pedido('GET', '/api/contas', undefined, P9)).status === 403);
  ok('34. Gestor não vê as contas', (await pedido('GET', '/api/contas', undefined, G)).status === 403);
  ok('35. Admin vê as contas', (await pedido('GET', '/api/contas', undefined, A)).status === 200);
  await pedido('POST', '/api/contas', { utilizador: 'novo.posto@pumangol.co.ao', nome: 'X', perfil: 'posto', posto: '9' }, A);
  x = await pedido('POST', '/api/contas', { utilizador: 'NOVO.posto@pumangol.co.ao', nome: 'Y', perfil: 'gestor' }, A);
  ok('36. Não se cria uma conta que já existe', x.status === 409, x.status);
  x = await pedido('POST', '/api/contas/admin1/perfil', { perfil: 'gestor' }, A);
  ok('37. O admin não altera o seu próprio perfil', x.status === 400);
  x = await pedido('POST', '/api/contas/gestor1/perfil', { perfil: 'admin' }, G);
  ok('38. Um gestor não altera perfis', x.status === 403);
  const antes = lerDB().contas;

  /* --- actualização do portal: reiniciar não altera contas nem confirmações --- */
  const confAntes = JSON.stringify(lerDB().conf);
  await parar(srv); srv = await ligar();
  db = lerDB();
  ok('39. Depois de reiniciar, as contas ficam iguais', JSON.stringify(db.contas) === JSON.stringify(antes));
  ok('40. Depois de reiniciar, as confirmações ficam iguais', JSON.stringify(db.conf) === confAntes);
  ok('41. As sessões continuam válidas depois de reiniciar', (await pedido('GET', '/api/contas', undefined, A)).status === 200);
  await parar(srv);

  /* --- migração de uma base da versão 4 (perfis posto/gestao) --- */
  const velho = path.join(pasta, 'v4.sqlite');
  execFileSync(process.execPath, ['-e', `
    const {DatabaseSync}=require('node:sqlite'); const d=new DatabaseSync(${JSON.stringify(velho)});
    d.exec("CREATE TABLE utilizadores (id INTEGER PRIMARY KEY AUTOINCREMENT, utilizador TEXT NOT NULL UNIQUE COLLATE NOCASE, nome TEXT NOT NULL, senha_hash TEXT NOT NULL, perfil TEXT NOT NULL CHECK (perfil IN ('posto','gestao')), posto_id TEXT, activo INTEGER NOT NULL DEFAULT 1, criado_em INTEGER NOT NULL)");
    d.exec("INSERT INTO utilizadores VALUES (7,'rufino','Rufino','HASH1','gestao',NULL,1,1),(8,'posto09','TALATONA','HASH2','posto','9',1,2),(9,'antigo','X','HASH3','gestao',NULL,0,3)"); d.close();`], { stdio: 'pipe' });
  const mig = JSON.parse(execFileSync(process.execPath, ['-e', `
    process.env.DADOS_FICHEIRO=${JSON.stringify(velho)}; const a=require(${JSON.stringify(path.join(RAIZ, 'armazem'))});
    const {DatabaseSync}=require('node:sqlite'); a.fechar(); const d=new DatabaseSync(${JSON.stringify(velho)});
    console.log(JSON.stringify(d.prepare('SELECT id,utilizador,perfil,posto_id,senha_hash,activo FROM utilizadores ORDER BY id').all()));`], { cwd: RAIZ, stdio: ['ignore', 'pipe', 'ignore'] }).toString().trim().split('\n').pop());
  ok('42. Base da versão 4: «gestao» passa a «admin», o resto fica igual (ids, senhas, posto, estado)',
    JSON.stringify(mig) === JSON.stringify([{ id: 7, utilizador: 'rufino', perfil: 'admin', posto_id: null, senha_hash: 'HASH1', activo: 1 }, { id: 8, utilizador: 'posto09', perfil: 'posto', posto_id: '9', senha_hash: 'HASH2', activo: 1 }, { id: 9, utilizador: 'antigo', perfil: 'admin', posto_id: null, senha_hash: 'HASH3', activo: 0 }]), JSON.stringify(mig));

  fs.rmSync(pasta, { recursive: true, force: true });
  const falhas = res.filter(y => !y.ok);
  console.log('\nTeste de consistência e integridade das confirmações\n');
  res.forEach((y, i) => console.log(`${y.ok ? '  ✓' : '  ✗'} ${i + 1}. ${y.nome.replace(/^\d+[a-z]?\. /, '')}${!y.ok && y.info ? '  [' + y.info + ']' : ''}`));
  console.log(`\n${res.length - falhas.length} de ${res.length} verificações passaram.${falhas.length ? '' : ' Tudo consistente.'}\n`);
  process.exit(falhas.length ? 1 : 0);
})().catch(e => { console.error('Erro no teste:', e); try { fs.rmSync(pasta, { recursive: true, force: true }); } catch (_) {} process.exit(1); });
