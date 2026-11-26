/* Combustível por Perto (Pumangol) — servidor, versão 6.0: independente de outras bases de dados.
   As confirmações dos postos ficam na base de dados do portal; cada nova confirmação substitui a anterior.
   Serve o portal (public/), guarda os dados (ficheiro SQLite ou Turso, ver armazem.js) e envia as
   alterações em tempo real (SSE) a todos os ecrãs abertos.
   Servidor próprio: node server.js. Vercel: api/index.js usa esta mesma aplicação (ver VERCEL.md). */
'use strict';
require('./preparar-env');
const path = require('path');
const fs = require('fs');
const crypto = require('crypto');
const express = require('express');
const cookieParser = require('cookie-parser');
const jwt = require('jsonwebtoken');
const bcrypt = require('bcryptjs');
const armazem = require('./armazem');
const postos = require('./postos');
const contas = require('./contas');

/* na Vercel o portal está sempre atrás de HTTPS e de um único proxy (que substitui o X-Forwarded-For) */
const NA_VERCEL = !!process.env.VERCEL;
const {
  PORT = 3000,
  JWT_SECRET, COOKIE_SECURE = NA_VERCEL ? 'true' : 'false', TRUST_PROXY = NA_VERCEL ? '1' : 'loopback', HOST
} = process.env;
if (!JWT_SECRET || JWT_SECRET.length < 32) {
  console.error('Defina JWT_SECRET (mín. 32 caracteres) no .env ou nas variáveis de ambiente (na Vercel: Settings › Environment Variables).');
  process.exit(1);
}


/* ---------- colecções e permissões ----------
   leitura: 'publico' | 'posto' | 'gestor' | 'admin'      escrita: 'admin'
   As confirmações dos postos não se escrevem por aqui: só por POST /api/confirmar. */
const COLS = {
  postos:       { tabela: 'postos',       ler: 'publico', escrever: 'admin', chaves: false },
  runouts:      { tabela: 'runouts',      ler: 'publico', escrever: null,    chaves: true },
  confirmacoes: { tabela: 'confirmacoes', ler: 'publico', escrever: null,    chaves: true },
  decisoes:     { tabela: 'decisoes',     ler: 'publico', escrever: null,    chaves: true },
  registos:     { tabela: 'registos',     ler: 'posto',   escrever: null,    chaves: true },
  config:       { tabela: 'config',       ler: 'publico', escrever: 'admin', chaves: false }
};
const NIVEL = { publico: 0, posto: 1, visualizador: 2, gestor: 2, admin: 3 };
const PERFIS = contas.PERFIS;
/* quem pode enviar confirmações: o visualizador só consulta */
const PODE_CONFIRMAR = ['posto', 'gestor', 'admin'];
const nivelDe = u => (u ? NIVEL[u.perfil] || 0 : 0);
const ID_OK = /^[A-Za-z0-9_.:-]{1,100}$/;

const app = express();
app.set('trust proxy', TRUST_PROXY === '0' ? false : +TRUST_PROXY || TRUST_PROXY);
app.disable('x-powered-by');
app.use(express.json({ limit: '200kb' }));
app.use(cookieParser());
/* ---------- cabeçalhos de segurança ----------
   CSP: só recursos do próprio portal; o único script embutido na página é autorizado pelo seu hash SHA-256. */
const SEGURO = COOKIE_SECURE !== 'false';
const HTML = fs.readFileSync(path.join(__dirname, 'public', 'index.html'), 'utf8');
const HASHES = [...HTML.matchAll(/<script>([\s\S]*?)<\/script>/g)].map(m => `'sha256-${crypto.createHash('sha256').update(m[1], 'utf8').digest('base64')}'`);
const CSP = ["default-src 'self'", `script-src 'self' ${HASHES.join(' ')}`, "style-src 'self' 'unsafe-inline'", "img-src 'self' data:",
  "font-src 'self'", "connect-src 'self'", "object-src 'none'", "base-uri 'none'", "form-action 'self'", "frame-ancestors 'self'"].join('; ');
app.use((req, res, next) => {
  res.set({
    'Content-Security-Policy': CSP,
    'X-Content-Type-Options': 'nosniff',
    'Referrer-Policy': 'strict-origin-when-cross-origin',
    'X-Frame-Options': 'SAMEORIGIN',
    'Permissions-Policy': 'geolocation=(self), camera=(), microphone=(), payment=(), usb=()',
    'Cross-Origin-Opener-Policy': 'same-origin',
    'Cross-Origin-Resource-Policy': 'same-origin',
    ...(SEGURO ? { 'Strict-Transport-Security': 'max-age=31536000' } : {})
  });
  if (req.path.startsWith('/api/')) res.set('Cache-Control', 'no-store');
  next();
});

/* ---------- preparação ----------
   Tabelas, lista de postos e versões prontas antes do primeiro pedido. No servidor próprio acontece ao arrancar;
   na Vercel, no primeiro pedido de cada instância. Se falhar, tenta de novo no pedido seguinte. */
let preparado = null;
function preparar() {
  return (preparado ||= (async () => {
    await armazem.iniciar();
    Object.assign(conhecidas, await armazem.versoes());
    return sincronizarPostos();
  })().catch(e => { preparado = null; throw e; }));
}
app.use((req, res, next) => {
  preparar().then(() => next(), e => {
    console.error('A base de dados não respondeu ao preparar o portal.' + (armazem.remota ? ' Confirme TURSO_DATABASE_URL e TURSO_AUTH_TOKEN (VERCEL.md › Problemas).' : ''));
    next(e);
  });
});

/* limite geral de escritas por IP (protege contra abusos e scripts em ciclo).
   Os contadores ficam na base de dados, para valerem em todas as instâncias do portal. */
const LIMITE_ESCRITAS = Math.max(10, +process.env.LIMITE_ESCRITAS_MIN || 120);
app.use('/api', async (req, res, next) => {
  if (req.method === 'GET') return next();
  if (await armazem.somarLimite('escrita:' + req.ip, 60e3) > LIMITE_ESCRITAS) return res.status(429).json({ erro: 'Demasiados pedidos. Aguarde um minuto.' });
  next();
});

/* ---------- sessão ---------- */
const COOKIE = SEGURO ? '__Host-sessao' : 'sessao';
/* «versão» da senha dentro da sessão: mudar a senha termina todas as sessões abertas dessa conta */
const versaoSenha = h => crypto.createHash('sha256').update(String(h)).digest('hex').slice(0, 16);
async function sessao(req, _res, next) {
  req.u = null;
  const t = req.cookies[COOKIE];
  if (t) {
    try {
      const u = jwt.verify(t, JWT_SECRET, { algorithms: ['HS256'] }), c = await armazem.porId(u.id);
      /* conta desactivada, apagada, com perfil/posto alterado ou com senha mudada: a sessão deixa de valer */
      if (c && c.activo && !c.pendente && c.perfil === u.perfil && String(c.posto_id ?? '') === String(u.posto ?? '') && u.sv === versaoSenha(c.senha_hash))
        req.u = { id: u.id, nome: u.nome, perfil: u.perfil, posto: u.posto, utilizador: c.utilizador };
    } catch (_) { /* sessão inválida ou expirada */ }
  }
  next();
}
app.use(sessao);

/* protecção CSRF: escritas só com o cabeçalho enviado pelo próprio portal */
function soPortal(req, res, next) {
  if (req.get('X-VIA') !== '1') return res.status(403).json({ erro: 'Pedido recusado.' });
  next();
}
const exige = nivel => (req, res, next) =>
  nivelDe(req.u) >= NIVEL[nivel] ? next() : res.status(req.u ? 403 : 401).json({ erro: 'Sem permissão.' });

/* tentativas falhadas: no máximo 20 por IP e 5 por conta em 15 minutos (contadores na base de dados) */
const JANELA = 15 * 60e3;
const chaveConta = u => 'entrada-conta:' + String(u || '').trim().toLowerCase().slice(0, 40);
const chaveIp = ip => 'entrada-ip:' + ip;
const falhou = (ip, conta) => armazem.somarLimites([chaveIp(ip), chaveConta(conta)], JANELA);
async function limiteLogin(req, res, next) {
  const conta = String((req.body && req.body.utilizador) || '').trim().toLowerCase().slice(0, 40);
  const [nIp, nConta] = await armazem.contarLimites([chaveIp(req.ip), chaveConta(conta)], JANELA);
  if (nIp >= 20 || (conta && nConta >= 5)) {
    await armazem.auditar('entrada_bloqueada', { utilizador: conta, ip: req.ip });
    return res.status(429).json({ erro: 'Demasiadas tentativas. Tente de novo dentro de 15 minutos.' });
  }
  next();
}
const HASH_FALSO = bcrypt.hashSync(crypto.randomBytes(12).toString('hex'), 12);   /* para responder no mesmo tempo quando a conta não existe */

app.post('/api/entrar', soPortal, limiteLogin, async (req, res) => {
  const { utilizador, senha } = req.body || {};
  if (typeof utilizador !== 'string' || typeof senha !== 'string') return res.status(400).json({ erro: 'Indique utilizador e senha.' });
  if (utilizador.length > 120 || senha.length > 200) return res.status(400).json({ erro: 'Email ou senha incorrectos.' });
  const u = await armazem.utilizador(utilizador);
  const certa = await bcrypt.compare(senha, u ? u.senha_hash : HASH_FALSO);
  if (!u || !certa || u.pendente) {
    await falhou(req.ip, utilizador);
    await armazem.auditar('entrada_falhada', { utilizador: utilizador.slice(0, 40), ip: req.ip });
    return res.status(401).json({ erro: 'Email ou senha incorrectos. Se é o seu primeiro acesso, use «Primeiro acesso» com o código que recebeu.' });
  }
  await armazem.limparLimite(chaveConta(utilizador));
  const dados = { id: u.id, nome: u.nome, perfil: u.perfil, posto: u.posto_id, utilizador: u.utilizador, sv: versaoSenha(u.senha_hash) };
  res.cookie(COOKIE, jwt.sign(dados, JWT_SECRET, { algorithm: 'HS256', expiresIn: '12h' }), {
    httpOnly: true, sameSite: 'strict', secure: SEGURO, maxAge: 12 * 3600e3, path: '/'
  });
  await armazem.auditar('entrada', { conta: u.id, utilizador: u.utilizador, ip: req.ip });
  res.json(perfilPublico(dados));
});
app.post('/api/sair', soPortal, async (req, res) => {
  if (req.u) await armazem.auditar('saida', { conta: req.u.id, utilizador: req.u.utilizador, ip: req.ip });
  res.clearCookie(COOKIE, { path: '/', httpOnly: true, sameSite: 'strict', secure: SEGURO }); res.json({ ok: true });
});
const perfilPublico = u => (u ? { nivel: u.perfil, conta: String(u.id), nome: u.nome, posto: u.posto, utilizador: u.utilizador } : { nivel: 'cliente', conta: null });
app.get('/api/sessao', (req, res) => res.json(perfilPublico(req.u)));

/* validação dos registos que o admin pode gravar (lista de postos e configuração) */
const texto = (v, max) => v == null || (typeof v === 'string' && v.length <= max && !/[<>\u0000-\u001f\u007f]/.test(v));
function dadosInvalidos(col, id, o) {
  if (!o || typeof o !== 'object' || Array.isArray(o)) return 'Dados inválidos.';
  if (col === 'postos') {
    const permitidos = ['id', 'nome', 'municipio', 'provincia', 'morada', 'lat', 'lng', 'codigoVia', 'validado', 'codigoSiteMaster', 'nomeSiteMaster', 'moso', 'comuna'];
    if (Object.keys(o).some(k => !permitidos.includes(k))) return 'Campo desconhecido no posto.';
    if (String(o.id) !== id || !/^[A-Za-z0-9_-]{1,20}$/.test(id)) return 'Código do posto inválido.';
    if (!texto(o.nome, 80) || !o.nome || !texto(o.nomeSiteMaster, 120) || (o.codigoSiteMaster != null && !texto(String(o.codigoSiteMaster), 40)) || !texto(o.municipio, 80) || !texto(o.provincia, 80) || !texto(o.morada, 200) || !texto(o.moso, 20) || !texto(o.comuna, 80)) return 'Texto inválido no posto (sem < nem >; tamanho limitado).';
    for (const [k, a, b] of [['lat', -19, -4], ['lng', 11, 25]]) if (o[k] != null && !(typeof o[k] === 'number' && o[k] >= a && o[k] <= b)) return 'Coordenadas fora de Angola.';
    if (o.codigoVia != null && !texto(String(o.codigoVia), 40)) return 'Código VIA inválido.';
    if (o.validado != null && typeof o.validado !== 'boolean') return 'Campo «validado» inválido.';
    return null;
  }
  if (col === 'config') {
    if (id !== 'geral') return 'Configuração desconhecida.';
    for (const [k, v] of Object.entries(o)) if (!['validadeMin', 'renovacaoMin'].includes(k) || !(Number.isInteger(v) && v >= 10 && v <= 10080)) return 'Configuração inválida.';
    return null;
  }
  return 'Colecção sem escrita.';
}

/* ---------- contas (só a gestão) e a própria senha ---------- */
const UTIL_OK = /^[A-Za-z0-9._-]{3,40}$/;
/* nomes: sem caracteres de controlo nem < > (defesa adicional contra código injectado) */
const nomeValido = n => typeof n === 'string' && n.trim().length > 0 && n.length <= 80 && !/[<>\u0000-\u001f\u007f]/.test(n);
const senhaInvalida = s => typeof s !== 'string' || s.length < 10 ? 'A senha tem de ter pelo menos 10 caracteres.'
  : Buffer.byteLength(s, 'utf8') > 72 ? 'A senha é demasiado longa (máximo 72 caracteres).' : null;
const contaPublica = c => ({ utilizador: c.utilizador, nome: c.nome, perfil: c.perfil, posto_id: c.posto_id, activo: !!c.activo, pendente: !!c.pendente, expira: c.activacao_expira == null ? null : Number(c.activacao_expira) });
const adminsActivos = async () => (await armazem.contas()).filter(c => c.activo && c.perfil === 'admin').length;
app.get('/api/contas', exige('admin'), async (_req, res) => res.set('Cache-Control', 'no-store').json((await armazem.contas()).map(contaPublica)));
app.post('/api/contas', soPortal, exige('admin'), async (req, res) => {
  const { utilizador, nome, perfil, posto } = req.body || {};
  const email = typeof utilizador === 'string' ? utilizador.trim().toLowerCase() : '';
  if (!contas.EMAIL_OK.test(email) || email.length > 120) return res.status(400).json({ erro: 'Indique um email válido: é o utilizador para entrar no portal.' });
  if (!nomeValido(nome)) return res.status(400).json({ erro: 'Indique o nome a mostrar (até 80 caracteres, sem < nem >).' });
  if (!PERFIS.includes(perfil)) return res.status(400).json({ erro: 'Perfil inválido.' });
  if (perfil === 'posto' && !(await postos.validos(armazem)).has(String(posto ?? ''))) return res.status(400).json({ erro: 'Escolha o posto desta conta.' });
  if (await armazem.existeUtilizador(email)) return res.status(409).json({ erro: `Já existe uma conta «${email}». As contas existentes não são alteradas; use «Novo código de acesso» nessa conta.` });
  const a = await contas.prepararActivacao();
  await armazem.criarUtilizador({ utilizador: email, nome: nome.trim(), hash: contas.senhaInutil(), perfil, posto: perfil === 'posto' ? String(posto) : null, activacaoHash: a.hash, expira: a.expira });
  await armazem.auditar('conta_criada', { conta: req.u.id, utilizador: req.u.utilizador, detalhe: { alvo: email, perfil, posto: perfil === 'posto' ? String(posto) : null }, ip: req.ip });
  res.json({ ok: true, utilizador: email, codigo: a.codigo, expira: a.expira });
});
/* novo código de primeiro acesso (conta nova que perdeu o código, ou senha esquecida): a senha anterior deixa de servir */
app.post('/api/contas/:u/codigo', soPortal, exige('admin'), async (req, res) => {
  const c = await armazem.porNome(req.params.u);
  if (!c) return res.status(404).json({ erro: 'Conta não encontrada.' });
  const a = await contas.prepararActivacao();
  await armazem.definirActivacao(c.utilizador, contas.senhaInutil(), a.hash, a.expira);
  await armazem.auditar('codigo_gerado', { conta: req.u.id, utilizador: req.u.utilizador, detalhe: { alvo: c.utilizador }, ip: req.ip });
  res.json({ ok: true, utilizador: c.utilizador, codigo: a.codigo, expira: a.expira });
});
/* importação da folha «Perfis de Acesso»: cria só as contas que ainda não existem */
app.post('/api/contas/importar', soPortal, exige('admin'), async (req, res) => {
  const linhas = contas.lerTabela(req.body && req.body.texto);
  if (!linhas.length || linhas.length > 1000) return res.status(400).json({ erro: 'Cole as linhas da folha (Nome, email, Tipo), até 1000.' });
  const r = await contas.importar(armazem, linhas, { auditar: d => armazem.auditar('contas_importadas', { conta: req.u.id, utilizador: req.u.utilizador, detalhe: d, ip: req.ip }) });
  res.json(r);
});
/* primeiro acesso: email + código entregue pelo admin → a pessoa grava a sua senha */
app.post('/api/primeiro-acesso', soPortal, limiteLogin, async (req, res) => {
  const { utilizador, codigo, senha } = req.body || {};
  const email = typeof utilizador === 'string' ? utilizador.trim().toLowerCase().slice(0, 120) : '';
  const cod = contas.normalizarCodigo(codigo).slice(0, 20);
  const u = email ? await armazem.utilizador(email) : null;
  const valido = u && u.pendente && u.activacao_hash && Number(u.activacao_expira) > Date.now();
  const certo = await bcrypt.compare(cod || 'x', valido ? u.activacao_hash : HASH_FALSO);
  if (!valido || !certo) {
    await falhou(req.ip, email);
    await armazem.auditar('primeiro_acesso_falhado', { utilizador: email.slice(0, 40), ip: req.ip });
    return res.status(400).json({ erro: 'Email ou código de acesso inválido, ou código expirado. Peça um novo código ao administrador.' });
  }
  if (senhaInvalida(senha)) return res.status(400).json({ erro: senhaInvalida(senha) });
  const hash = await bcrypt.hash(senha, 12);
  await armazem.activar(u.utilizador, hash);
  await armazem.limparLimite(chaveConta(email));
  await armazem.auditar('primeiro_acesso', { conta: u.id, utilizador: u.utilizador, ip: req.ip });
  const dados = { id: u.id, nome: u.nome, perfil: u.perfil, posto: u.posto_id, utilizador: u.utilizador, sv: versaoSenha(hash) };
  res.cookie(COOKIE, jwt.sign(dados, JWT_SECRET, { algorithm: 'HS256', expiresIn: '12h' }), { httpOnly: true, sameSite: 'strict', secure: SEGURO, maxAge: 12 * 3600e3, path: '/' });
  res.json(perfilPublico(dados));
});
app.post('/api/contas/:u/estado', soPortal, exige('admin'), async (req, res) => {
  if (req.params.u.toLowerCase() === String(req.u.utilizador || '').toLowerCase()) return res.status(400).json({ erro: 'Não pode desactivar a sua própria conta.' });
  const activo = !!(req.body && req.body.activo);
  if (!activo && (await armazem.porNome(req.params.u))?.perfil === 'admin' && await adminsActivos() <= 1)
    return res.status(400).json({ erro: 'Tem de existir pelo menos uma conta de admin activa.' });
  if (!(await armazem.estadoConta(req.params.u, activo))) return res.status(404).json({ erro: 'Conta não encontrada.' });
  await armazem.auditar(activo ? 'conta_reactivada' : 'conta_desactivada', { conta: req.u.id, utilizador: req.u.utilizador, detalhe: { alvo: req.params.u }, ip: req.ip });
  res.json({ ok: true });
});
/* alterar o perfil de uma conta: só o admin, e nunca o seu próprio */
app.post('/api/contas/:u/perfil', soPortal, exige('admin'), async (req, res) => {
  const { perfil, posto } = req.body || {};
  const c = await armazem.porNome(req.params.u);
  if (!c) return res.status(404).json({ erro: 'Conta não encontrada.' });
  if (c.utilizador.toLowerCase() === String(req.u.utilizador || '').toLowerCase()) return res.status(400).json({ erro: 'Não pode alterar o seu próprio perfil.' });
  if (!PERFIS.includes(perfil)) return res.status(400).json({ erro: 'Perfil inválido.' });
  if (perfil === 'posto' && !(await postos.validos(armazem)).has(String(posto))) return res.status(400).json({ erro: 'Escolha um posto da lista.' });
  if (c.perfil === 'admin' && perfil !== 'admin' && await adminsActivos() <= 1)
    return res.status(400).json({ erro: 'Tem de existir pelo menos uma conta de admin activa.' });
  await armazem.alterarPerfil(c.utilizador, perfil, perfil === 'posto' ? String(posto) : null);
  await armazem.auditar('perfil_alterado', { conta: req.u.id, utilizador: req.u.utilizador, detalhe: { alvo: c.utilizador, de: c.perfil + (c.posto_id ? ':' + c.posto_id : ''), para: perfil + (perfil === 'posto' ? ':' + posto : '') }, ip: req.ip });
  res.json({ ok: true });
});

/* ---------- confirmação de um posto (único caminho de escrita das confirmações) ---------- */
const MOMENTO_OK = { 'Início de turno': ['venda', 'interrompida'], 'Reconfirmação': ['venda', 'interrompida'], 'Combustível esgotado': ['interrompida'], 'Venda retomada': ['venda'] };
app.post('/api/confirmar', soPortal, exige('posto'), async (req, res) => {
  if (!PODE_CONFIRMAR.includes(req.u.perfil)) return res.status(403).json({ erro: 'Este perfil só consulta: não envia confirmações.' });
  const { posto, momento, responsavel, itens } = req.body || {};
  const pid = String(posto ?? '').trim();
  if (!(await postos.validos(armazem)).has(pid)) return res.status(400).json({ erro: 'Posto desconhecido.' });
  if (req.u.perfil === 'posto' && String(req.u.posto) !== pid) return res.status(403).json({ erro: 'Esta conta só pode confirmar o seu posto.' });
  if (!Object.hasOwn(MOMENTO_OK, momento)) return res.status(400).json({ erro: 'Momento inválido.' });
  const nome = req.u.perfil === 'posto' ? (typeof responsavel === 'string' ? responsavel.trim() : '') : req.u.nome;   /* gestor/admin: o nome da conta */
  if (!nomeValido(nome)) return res.status(400).json({ erro: 'Indique o nome do responsável do posto (até 80 caracteres, sem < nem >).' });
  const erro = itensInvalidos(itens, momento);
  if (erro) return res.status(400).json({ erro });
  const hora = Date.now();     /* a hora é sempre a do servidor */
  await armazem.confirmar(linhasDe([pid], itens, momento, nome, req.u.id, hora), req.u.id);
  await avisar('confirmacoes', 'registos', 'historico');
  res.json({ ok: true, hora });
});
function itensInvalidos(itens, momento) {
  if (!Array.isArray(itens) || !itens.length || itens.length > 2) return 'Indique o estado de pelo menos um combustível.';
  const vistos = new Set();
  for (const it of itens) {
    if (!it || !['GA', 'GO'].includes(it.prod) || vistos.has(it.prod)) return 'Combustível inválido.';
    if (!['venda', 'interrompida'].includes(it.estado)) return 'Estado inválido.';
    if (!MOMENTO_OK[momento].includes(it.estado)) return `«${momento}» só pode ser usado com ${MOMENTO_OK[momento][0] === 'venda' ? 'Disponível' : 'Indisponível'}.`;
    vistos.add(it.prod);
  }
  return null;
}
function linhasDe(ids, itens, momento, nome, conta, hora) {
  const out = [];
  for (const pid of ids) {
    const pv = /^\d+$/.test(pid) ? Number(pid) : pid;
    for (const it of itens) {
      const id = `c-${pid}-${it.prod}`;
      out.push({ conf: { id, posto: pv, prod: it.prod, hora, [it.prod]: it.estado, momento },
                 registo: { id, posto: pv, prod: it.prod, hora, utilizador: nome, conta: String(conta) } });
    }
  }
  return out;
}
/* registo de auditoria: só o admin consulta; ninguém o altera pelo portal */
app.get('/api/auditoria', exige('admin'), async (req, res) => res.json(await armazem.auditoria(req.query.limite)));
/* histórico: as 5 últimas confirmações de um posto e combustível (só contas; o posto só vê o seu) */
app.get('/api/historico', exige('posto'), async (req, res) => {
  const pid = String(req.query.posto ?? '').trim(), prod = String(req.query.prod || '');
  if (!['GA', 'GO'].includes(prod)) return res.status(400).json({ erro: 'Combustível inválido.' });
  if (!(await postos.validos(armazem)).has(pid)) return res.status(400).json({ erro: 'Posto desconhecido.' });
  if (req.u.perfil === 'posto' && String(req.u.posto) !== pid) return res.status(403).json({ erro: 'Esta conta só vê o histórico do seu posto.' });
  res.set('Cache-Control', 'no-store').json(await armazem.historico(pid, prod));
});
/* lista de postos e confirmações sempre alinhadas: postos novos começam «Disponível», postos retirados saem */
async function sincronizarPostos() {
  const ids = [...await postos.validos(armazem)];
  const novos = await armazem.semear(ids), retirados = await armazem.limparOrfaos(ids);
  if (novos || retirados) await avisar('confirmacoes', 'registos');
  return { novos, retirados };
}
/* admin: o mesmo estado em toda a rede, numa só operação (tudo ou nada) */
app.post('/api/confirmar-rede', soPortal, exige('admin'), async (req, res) => {
  const { momento, itens } = req.body || {};
  if (!Object.hasOwn(MOMENTO_OK, momento)) return res.status(400).json({ erro: 'Momento inválido.' });
  const erro = itensInvalidos(itens, momento);
  if (erro) return res.status(400).json({ erro });
  const ids = [...await postos.validos(armazem)], hora = Date.now();
  await armazem.confirmar(linhasDe(ids, itens, momento, req.u.nome, req.u.id, hora), req.u.id);
  await armazem.auditar('rede_confirmada', { conta: req.u.id, utilizador: req.u.utilizador, detalhe: { momento, itens, postos: ids.length }, ip: req.ip });
  await avisar('confirmacoes', 'registos', 'historico');
  res.json({ ok: true, postos: ids.length, hora });
});

app.post('/api/senha', soPortal, limiteLogin, async (req, res) => {
  if (!req.u) return res.status(401).json({ erro: 'Entre primeiro no portal.' });
  const { actual, nova } = req.body || {};
  const c = await armazem.utilizador(req.u.utilizador);
  if (!c || typeof actual !== 'string' || !(await bcrypt.compare(actual, c.senha_hash))) {
    await falhou(req.ip, req.u.utilizador);
    await armazem.auditar('senha_propria_falhada', { conta: req.u.id, utilizador: req.u.utilizador, ip: req.ip });
    return res.status(400).json({ erro: 'A senha actual não está certa.' });
  }
  if (senhaInvalida(nova)) return res.status(400).json({ erro: senhaInvalida(nova) });
  const hash = await bcrypt.hash(nova, 12);
  await armazem.mudarSenha(c.utilizador, hash);
  await armazem.auditar('senha_propria_alterada', { conta: req.u.id, utilizador: req.u.utilizador, ip: req.ip });
  /* as outras sessões desta conta terminam; esta recebe uma sessão nova */
  res.cookie(COOKIE, jwt.sign({ id: c.id, nome: c.nome, perfil: c.perfil, posto: c.posto_id, utilizador: c.utilizador, sv: versaoSenha(hash) }, JWT_SECRET, { algorithm: 'HS256', expiresIn: '12h' }),
    { httpOnly: true, sameSite: 'strict', secure: SEGURO, maxAge: 12 * 3600e3, path: '/' });
  res.json({ ok: true });
});

/* ---------- leitura ---------- */
app.get('/api/c/:col', async (req, res) => {
  const c = COLS[req.params.col];
  if (!c) return res.status(404).json({ erro: 'Colecção desconhecida.' });
  if (nivelDe(req.u) < NIVEL[c.ler]) return res.set('Cache-Control', 'no-store').json([]);   /* sem acesso: lista vazia */
  res.set('Cache-Control', 'no-store').json(vistaDe(req.u, c.tabela, await armazem.listar(c.tabela)));
});
/* o cliente nunca recebe «Indisponível» (vê «Disponibilidade por confirmar»); as contas vêem o estado de toda a rede */
function vistaDe(u, tabela, linhas) {
  const n = nivelDe(u);
  if (n >= NIVEL.gestor || (tabela !== 'confirmacoes' && tabela !== 'registos')) return linhas;
  if (tabela === 'registos') return linhas.filter(r => n === NIVEL.posto && String(r.dados.posto) === String(u.posto));
  if (n === NIVEL.posto) return linhas;                                  /* conta de posto: estado de toda a rede */
  return linhas.filter(r => r.dados[r.dados.prod] === 'venda');          /* cliente: nunca «Indisponível» */
}

/* ---------- escrita ---------- */
app.put('/api/c/:col/:id', soPortal, async (req, res) => {
  const c = COLS[req.params.col], id = req.params.id;
  if (!c) return res.status(404).json({ erro: 'Colecção desconhecida.' });
  if (!ID_OK.test(id)) return res.status(400).json({ erro: 'Identificador inválido.' });
  if (!c.escrever) return res.status(405).json({ erro: 'Use a confirmação do posto.' });
  if (nivelDe(req.u) < NIVEL[c.escrever]) return res.status(req.u ? 403 : 401).json({ erro: 'Sem permissão.' });
  const invalido = dadosInvalidos(req.params.col, id, req.body);
  if (invalido) return res.status(400).json({ erro: invalido });
  const obj = req.body;
  if (!obj || typeof obj !== 'object' || Array.isArray(obj)) return res.status(400).json({ erro: 'Dados inválidos.' });

  await armazem.gravar(c.tabela, id, obj, req.u.id);
  await armazem.auditar('dados_alterados', { conta: req.u.id, utilizador: req.u.utilizador, detalhe: { colecao: req.params.col, id }, ip: req.ip });
  await avisar(req.params.col);
  if (c.tabela === 'postos') await sincronizarPostos();
  res.json({ ok: true });
});

app.delete('/api/c/:col/:id', soPortal, exige('admin'), async (req, res) => {
  const c = COLS[req.params.col], id = req.params.id;
  if (!c) return res.status(404).json({ erro: 'Colecção desconhecida.' });
  if (!ID_OK.test(id)) return res.status(400).json({ erro: 'Identificador inválido.' });
  await armazem.apagar(c.tabela, id);
  await armazem.auditar('dados_apagados', { conta: req.u.id, utilizador: req.u.utilizador, detalhe: { colecao: req.params.col, id }, ip: req.ip });
  if (c.tabela === 'postos') await sincronizarPostos();
  await avisar(req.params.col);
  res.json({ ok: true });
});

/* ---------- tempo real (Server-Sent Events) ----------
   Cada alteração sobe a «versão» da colecção na base de dados. Cada instância do portal compara as versões
   (logo a seguir às suas escritas e, enquanto houver ecrãs ligados, a cada 5 segundos) e avisa os seus ecrãs.
   Assim os avisos chegam a todos, mesmo com várias instâncias (Vercel). Ao ligar, cada ecrã recebe as versões
   actuais e recarrega só o que mudou desde a última ligação. */
const clientes = new Set();
const SSE_MAX = 5000, SSE_POR_IP = 50;
/* na Vercel a ligação fecha antes do limite de duração da função; o navegador religa sozinho */
const SSE_DURACAO = 1000 * (+process.env.SSE_DURACAO_SEG || (NA_VERCEL ? 280 : 0));
const conhecidas = {};
const nivelDaColecao = col => col === 'historico' ? NIVEL.posto : COLS[col] ? NIVEL[COLS[col].ler] : NIVEL.admin;
const versoesPara = nivel => Object.fromEntries(Object.entries(conhecidas).filter(([col]) => nivel >= nivelDaColecao(col)));
const enviar = (cli, txt) => { try { cli.res.write(txt); } catch (_) { /* ligação já fechada */ } };
let emCurso = null, outraVez = false;
function verificarVersoes() {
  if (emCurso) { outraVez = true; return emCurso; }
  emCurso = (async () => {
    do {
      outraVez = false;
      const v = await armazem.versoes(), mudaram = [];
      for (const [col, n] of Object.entries(v)) if ((conhecidas[col] ?? 0) !== n) { conhecidas[col] = n; mudaram.push(col); }
      if (mudaram.length) for (const cli of clientes) {
        const vis = mudaram.filter(col => cli.nivel >= nivelDaColecao(col));
        if (!vis.length) continue;
        for (const col of vis) enviar(cli, `event: mudou\ndata: ${col}\n\n`);     /* ecrãs abertos antes desta versão */
        enviar(cli, `event: versoes\ndata: ${JSON.stringify(versoesPara(cli.nivel))}\n\n`);
      }
    } while (outraVez);
  })().catch(e => console.error('tempo real:', e.message)).finally(() => { emCurso = null; });
  return emCurso;
}
/* regista a alteração (para todas as instâncias) e avisa já os ecrãs desta; uma falha aqui não desfaz a escrita */
async function avisar(...cols) {
  try { await armazem.marcar(cols); } catch (e) { console.error('tempo real:', e.message); }
  await verificarVersoes();
}
let relogio = null;
function vigiar() {
  if (clientes.size && !relogio) relogio = setInterval(verificarVersoes, 5000);
  else if (!clientes.size && relogio) { clearInterval(relogio); relogio = null; }
}
app.get('/api/eventos', (req, res) => {
  if (clientes.size >= SSE_MAX || [...clientes].filter(c => c.ip === req.ip).length >= SSE_POR_IP)
    return res.status(429).json({ erro: 'Demasiadas ligações abertas.' });
  res.set({ 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache', Connection: 'keep-alive', 'X-Accel-Buffering': 'no' });
  res.flushHeaders();
  const cli = { res, nivel: nivelDe(req.u), ip: req.ip };
  clientes.add(cli); vigiar();
  res.write('retry: 5000\n\n');
  verificarVersoes().finally(() => { if (clientes.has(cli)) enviar(cli, `event: versoes\ndata: ${JSON.stringify(versoesPara(cli.nivel))}\n\n`); });
  const fim = SSE_DURACAO ? setTimeout(() => res.end(), SSE_DURACAO) : null;
  /* «close» da resposta: só quando a ligação fecha (o do pedido dispara logo depois de o pedido ser lido) */
  res.on('close', () => { clearTimeout(fim); clientes.delete(cli); vigiar(); });
});
setInterval(() => { for (const cli of clientes) enviar(cli, ': ping\n\n'); }, 25000).unref();

/* ---------- portal ---------- */
app.get('/api/saude', async (req, res) => {
  res.json({ ok: true });
});
app.use('/api', (_req, res) => res.status(404).json({ erro: 'Não encontrado.' }));
/* a página principal nunca fica em cache: depois de uma actualização, todos recebem logo a versão nova */
app.use(express.static(path.join(__dirname, 'public'), {
  index: 'index.html', maxAge: '1d',
  setHeaders: (res, f) => { if (f.endsWith('.html')) res.setHeader('Cache-Control', 'no-cache'); }
}));

app.use((err, _req, res, _next) => {
  if (err && err.status >= 400 && err.status < 500) return res.status(err.status).json({ erro: err.status === 413 ? 'Pedido demasiado grande.' : 'Pedido inválido.' });
  console.error(err); res.status(500).json({ erro: 'Erro no servidor.' });
});

module.exports = app;

/* servidor próprio: node server.js (na Vercel a aplicação é usada por api/index.js, sem listen) */
if (require.main === module) {
  (async () => {
    console.log('Dados do portal em:', armazem.ficheiro);
    const { novos } = await preparar();
    if (novos) console.log(`Estado inicial: ${novos} combinações de posto e combustível ficaram «Disponível» por defeito.`);
    app.listen(+PORT, HOST || undefined, () => {
      console.log(`Combustível por Perto a correr em http://localhost:${PORT}`);
      console.log('Deixe esta janela aberta. Para desligar o portal, feche-a ou carregue em Ctrl + C.');
    });
  })().catch(e => { console.error('O portal não arrancou:', e.message); process.exit(1); });
}
