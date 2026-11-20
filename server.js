/* Combustível por Perto (Pumangol) — servidor, versão 5.7: independente de outras bases de dados.
   As confirmações dos postos ficam num ficheiro local; cada nova confirmação substitui a anterior.
   Serve o portal (public/), guarda os dados em dados/via-abastece.sqlite e envia as
   alterações em tempo real (SSE) a todos os ecrãs abertos. */
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

const {
  PORT = 3000,
  JWT_SECRET, COOKIE_SECURE = 'false', TRUST_PROXY = 'loopback', HOST
} = process.env;
if (!JWT_SECRET || JWT_SECRET.length < 32) { console.error('Defina JWT_SECRET (mín. 32 caracteres) no .env'); process.exit(1); }


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
const NIVEL = { publico: 0, posto: 1, gestor: 2, admin: 3 };
const PERFIS = ['posto', 'gestor', 'admin'];
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

/* limite geral de escritas por IP (protege contra abusos e scripts em ciclo) */
const escritas = new Map(), LIMITE_ESCRITAS = Math.max(10, +process.env.LIMITE_ESCRITAS_MIN || 120);
app.use('/api', (req, res, next) => {
  if (req.method === 'GET') return next();
  const k = req.ip, agora = Date.now(), t = escritas.get(k) || { n: 0, desde: agora };
  if (agora - t.desde > 60e3) { t.n = 0; t.desde = agora; }
  if (++t.n > LIMITE_ESCRITAS) return res.status(429).json({ erro: 'Demasiados pedidos. Aguarde um minuto.' });
  escritas.set(k, t); next();
});

/* ---------- sessão ---------- */
const COOKIE = SEGURO ? '__Host-sessao' : 'sessao';
/* «versão» da senha dentro da sessão: mudar a senha termina todas as sessões abertas dessa conta */
const versaoSenha = h => crypto.createHash('sha256').update(String(h)).digest('hex').slice(0, 16);
function sessao(req, _res, next) {
  req.u = null;
  const t = req.cookies[COOKIE];
  if (t) {
    try {
      const u = jwt.verify(t, JWT_SECRET, { algorithms: ['HS256'] }), c = armazem.porId(u.id);
      /* conta desactivada, apagada, com perfil/posto alterado ou com senha mudada: a sessão deixa de valer */
      if (c && c.activo && c.perfil === u.perfil && String(c.posto_id ?? '') === String(u.posto ?? '') && u.sv === versaoSenha(c.senha_hash))
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

/* tentativas falhadas: no máximo 20 por IP e 5 por conta em 15 minutos */
const JANELA = 15 * 60e3, falhasIp = new Map(), falhasConta = new Map();
const contar = (m, k) => { const agora = Date.now(), t = m.get(k); return t && agora - t.desde < JANELA ? t.n : 0; };
const falhou = (m, k) => { const agora = Date.now(), t = m.get(k); if (!t || agora - t.desde >= JANELA) m.set(k, { n: 1, desde: agora }); else t.n++; };
setInterval(() => { const agora = Date.now(); for (const m of [falhasIp, falhasConta, escritas]) for (const [k, t] of m) if (agora - t.desde > JANELA) m.delete(k); }, 60e3).unref();
function limiteLogin(req, res, next) {
  const conta = String((req.body && req.body.utilizador) || '').trim().toLowerCase().slice(0, 40);
  if (contar(falhasIp, req.ip) >= 20 || (conta && contar(falhasConta, conta) >= 5)) {
    armazem.auditar('entrada_bloqueada', { utilizador: conta, ip: req.ip });
    return res.status(429).json({ erro: 'Demasiadas tentativas. Tente de novo dentro de 15 minutos.' });
  }
  next();
}
const HASH_FALSO = bcrypt.hashSync(crypto.randomBytes(12).toString('hex'), 12);   /* para responder no mesmo tempo quando a conta não existe */

app.post('/api/entrar', soPortal, limiteLogin, async (req, res) => {
  const { utilizador, senha } = req.body || {};
  if (typeof utilizador !== 'string' || typeof senha !== 'string') return res.status(400).json({ erro: 'Indique utilizador e senha.' });
  if (utilizador.length > 80 || senha.length > 200) return res.status(400).json({ erro: 'Utilizador ou senha incorrectos.' });
  const u = armazem.utilizador(utilizador);
  const certa = await bcrypt.compare(senha, u ? u.senha_hash : HASH_FALSO);
  if (!u || !certa) {
    falhou(falhasIp, req.ip); falhou(falhasConta, utilizador.trim().toLowerCase().slice(0, 40));
    armazem.auditar('entrada_falhada', { utilizador: utilizador.slice(0, 40), ip: req.ip });
    return res.status(401).json({ erro: 'Utilizador ou senha incorrectos.' });
  }
  falhasConta.delete(utilizador.trim().toLowerCase().slice(0, 40));
  const dados = { id: u.id, nome: u.nome, perfil: u.perfil, posto: u.posto_id, utilizador: u.utilizador, sv: versaoSenha(u.senha_hash) };
  res.cookie(COOKIE, jwt.sign(dados, JWT_SECRET, { algorithm: 'HS256', expiresIn: '12h' }), {
    httpOnly: true, sameSite: 'strict', secure: SEGURO, maxAge: 12 * 3600e3, path: '/'
  });
  armazem.auditar('entrada', { conta: u.id, utilizador: u.utilizador, ip: req.ip });
  res.json(perfilPublico(dados));
});
app.post('/api/sair', soPortal, (req, res) => {
  if (req.u) armazem.auditar('saida', { conta: req.u.id, utilizador: req.u.utilizador, ip: req.ip });
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
const contaPublica = c => ({ utilizador: c.utilizador, nome: c.nome, perfil: c.perfil, posto_id: c.posto_id, activo: !!c.activo });
app.get('/api/contas', exige('admin'), (_req, res) => res.set('Cache-Control', 'no-store').json(armazem.contas().map(contaPublica)));
app.post('/api/contas', soPortal, exige('admin'), async (req, res) => {
  const { utilizador, nome, perfil, posto, senha } = req.body || {};
  if (typeof utilizador !== 'string' || !UTIL_OK.test(utilizador)) return res.status(400).json({ erro: 'Utilizador inválido: use 3 a 40 letras, números, ponto, hífen ou sublinhado, sem espaços.' });
  if (!nomeValido(nome)) return res.status(400).json({ erro: 'Indique o nome a mostrar (até 80 caracteres, sem < nem >).' });
  if (!PERFIS.includes(perfil)) return res.status(400).json({ erro: 'Perfil inválido.' });
  if (perfil === 'posto' && !postos.validos(armazem).has(String(posto))) return res.status(400).json({ erro: 'Esse posto não existe na lista de postos.' });
  if (perfil === 'posto' && !(typeof posto === 'string' || typeof posto === 'number') || perfil === 'posto' && !String(posto).trim()) return res.status(400).json({ erro: 'Escolha o posto desta conta.' });
  if (senhaInvalida(senha)) return res.status(400).json({ erro: senhaInvalida(senha) });
  if (perfil === 'posto' && utilizador.toLowerCase() !== 'posto' + String(posto).trim().padStart(2, '0'))
    return res.status(400).json({ erro: `O utilizador de uma conta de posto é «posto${String(posto).trim().padStart(2, '0')}».` });
  if (armazem.existeUtilizador(utilizador)) return res.status(409).json({ erro: `Já existe uma conta «${utilizador}». Escolha outro utilizador, ou use «Nova senha» nessa conta.` });
  armazem.criarUtilizador({ utilizador: perfil === 'posto' ? utilizador.toLowerCase() : utilizador, nome: nome.trim(), hash: await bcrypt.hash(senha, 12), perfil, posto: perfil === 'posto' ? String(posto) : null });
  armazem.auditar('conta_criada', { conta: req.u.id, utilizador: req.u.utilizador, detalhe: { alvo: utilizador, perfil, posto: perfil === 'posto' ? String(posto) : null }, ip: req.ip });
  res.json({ ok: true });
});
app.post('/api/contas/:u/senha', soPortal, exige('admin'), async (req, res) => {
  const { senha } = req.body || {};
  if (senhaInvalida(senha)) return res.status(400).json({ erro: senhaInvalida(senha) });
  if (!armazem.mudarSenha(req.params.u, await bcrypt.hash(senha, 12))) return res.status(404).json({ erro: 'Conta não encontrada.' });
  armazem.auditar('senha_reposta', { conta: req.u.id, utilizador: req.u.utilizador, detalhe: { alvo: req.params.u }, ip: req.ip });
  res.json({ ok: true });
});
app.post('/api/contas/:u/estado', soPortal, exige('admin'), (req, res) => {
  if (req.params.u.toLowerCase() === String(req.u.utilizador || '').toLowerCase()) return res.status(400).json({ erro: 'Não pode desactivar a sua própria conta.' });
  const activo = !!(req.body && req.body.activo);
  if (!activo && armazem.porNome(req.params.u)?.perfil === 'admin' && armazem.contas().filter(c => c.activo && c.perfil === 'admin').length <= 1)
    return res.status(400).json({ erro: 'Tem de existir pelo menos uma conta de admin activa.' });
  if (!armazem.estadoConta(req.params.u, activo)) return res.status(404).json({ erro: 'Conta não encontrada.' });
  armazem.auditar(activo ? 'conta_reactivada' : 'conta_desactivada', { conta: req.u.id, utilizador: req.u.utilizador, detalhe: { alvo: req.params.u }, ip: req.ip });
  res.json({ ok: true });
});
/* alterar o perfil de uma conta: só o admin, e nunca o seu próprio */
app.post('/api/contas/:u/perfil', soPortal, exige('admin'), (req, res) => {
  const { perfil, posto } = req.body || {};
  const c = armazem.porNome(req.params.u);
  if (!c) return res.status(404).json({ erro: 'Conta não encontrada.' });
  if (c.utilizador.toLowerCase() === String(req.u.utilizador || '').toLowerCase()) return res.status(400).json({ erro: 'Não pode alterar o seu próprio perfil.' });
  if (!PERFIS.includes(perfil)) return res.status(400).json({ erro: 'Perfil inválido.' });
  if (perfil === 'posto' && !postos.validos(armazem).has(String(posto))) return res.status(400).json({ erro: 'Escolha um posto da lista.' });
  if (c.perfil === 'admin' && perfil !== 'admin' && armazem.contas().filter(x => x.activo && x.perfil === 'admin').length <= 1)
    return res.status(400).json({ erro: 'Tem de existir pelo menos uma conta de admin activa.' });
  armazem.alterarPerfil(c.utilizador, perfil, perfil === 'posto' ? String(posto) : null);
  armazem.auditar('perfil_alterado', { conta: req.u.id, utilizador: req.u.utilizador, detalhe: { alvo: c.utilizador, de: c.perfil + (c.posto_id ? ':' + c.posto_id : ''), para: perfil + (perfil === 'posto' ? ':' + posto : '') }, ip: req.ip });
  res.json({ ok: true });
});

/* ---------- confirmação de um posto (único caminho de escrita das confirmações) ---------- */
const MOMENTO_OK = { 'Início de turno': ['venda', 'interrompida'], 'Reconfirmação': ['venda', 'interrompida'], 'Combustível esgotado': ['interrompida'], 'Venda retomada': ['venda'] };
app.post('/api/confirmar', soPortal, exige('posto'), (req, res) => {
  const { posto, momento, responsavel, itens } = req.body || {};
  const pid = String(posto ?? '').trim();
  if (!postos.validos(armazem).has(pid)) return res.status(400).json({ erro: 'Posto desconhecido.' });
  if (req.u.perfil === 'posto' && String(req.u.posto) !== pid) return res.status(403).json({ erro: 'Esta conta só pode confirmar o seu posto.' });
  if (!Object.hasOwn(MOMENTO_OK, momento)) return res.status(400).json({ erro: 'Momento inválido.' });
  const nome = req.u.perfil === 'posto' ? (typeof responsavel === 'string' ? responsavel.trim() : '') : req.u.nome;   /* gestor/admin: o nome da conta */
  if (!nomeValido(nome)) return res.status(400).json({ erro: 'Indique o nome do responsável do posto (até 80 caracteres, sem < nem >).' });
  const erro = itensInvalidos(itens, momento);
  if (erro) return res.status(400).json({ erro });
  const hora = Date.now();     /* a hora é sempre a do servidor */
  armazem.confirmar(linhasDe([pid], itens, momento, nome, req.u.id, hora), req.u.id);
  avisar('confirmacoes'); avisar('registos'); avisarContas('historico');
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
app.get('/api/auditoria', exige('admin'), (req, res) => res.json(armazem.auditoria(req.query.limite)));
/* histórico: as 5 últimas confirmações de um posto e combustível (só contas; o posto só vê o seu) */
app.get('/api/historico', exige('posto'), (req, res) => {
  const pid = String(req.query.posto ?? '').trim(), prod = String(req.query.prod || '');
  if (!['GA', 'GO'].includes(prod)) return res.status(400).json({ erro: 'Combustível inválido.' });
  if (!postos.validos(armazem).has(pid)) return res.status(400).json({ erro: 'Posto desconhecido.' });
  if (req.u.perfil === 'posto' && String(req.u.posto) !== pid) return res.status(403).json({ erro: 'Esta conta só vê o histórico do seu posto.' });
  res.set('Cache-Control', 'no-store').json(armazem.historico(pid, prod));
});
/* lista de postos e confirmações sempre alinhadas: postos novos começam «Disponível», postos retirados saem */
function sincronizarPostos() {
  const ids = [...postos.validos(armazem)];
  const novos = armazem.semear(ids), retirados = armazem.limparOrfaos(ids);
  if ((novos || retirados) && typeof avisar === 'function') { try { avisar('confirmacoes'); avisar('registos'); } catch (_) {} }
  return { novos, retirados };
}
/* admin: o mesmo estado em toda a rede, numa só operação (tudo ou nada) */
app.post('/api/confirmar-rede', soPortal, exige('admin'), (req, res) => {
  const { momento, itens } = req.body || {};
  if (!Object.hasOwn(MOMENTO_OK, momento)) return res.status(400).json({ erro: 'Momento inválido.' });
  const erro = itensInvalidos(itens, momento);
  if (erro) return res.status(400).json({ erro });
  const ids = [...postos.validos(armazem)], hora = Date.now();
  armazem.confirmar(linhasDe(ids, itens, momento, req.u.nome, req.u.id, hora), req.u.id);
  armazem.auditar('rede_confirmada', { conta: req.u.id, utilizador: req.u.utilizador, detalhe: { momento, itens, postos: ids.length }, ip: req.ip });
  avisar('confirmacoes'); avisar('registos'); avisarContas('historico');
  res.json({ ok: true, postos: ids.length, hora });
});

app.post('/api/senha', soPortal, limiteLogin, async (req, res) => {
  if (!req.u) return res.status(401).json({ erro: 'Entre primeiro no portal.' });
  const { actual, nova } = req.body || {};
  const c = armazem.utilizador(req.u.utilizador);
  if (!c || typeof actual !== 'string' || !(await bcrypt.compare(actual, c.senha_hash))) {
    falhou(falhasIp, req.ip); falhou(falhasConta, String(req.u.utilizador).toLowerCase());
    armazem.auditar('senha_propria_falhada', { conta: req.u.id, utilizador: req.u.utilizador, ip: req.ip });
    return res.status(400).json({ erro: 'A senha actual não está certa.' });
  }
  if (senhaInvalida(nova)) return res.status(400).json({ erro: senhaInvalida(nova) });
  const hash = await bcrypt.hash(nova, 12);
  armazem.mudarSenha(c.utilizador, hash);
  armazem.auditar('senha_propria_alterada', { conta: req.u.id, utilizador: req.u.utilizador, ip: req.ip });
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
  res.set('Cache-Control', 'no-store').json(vistaDe(req.u, c.tabela, armazem.listar(c.tabela)));
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

  armazem.gravar(c.tabela, id, obj, req.u.id);
  armazem.auditar('dados_alterados', { conta: req.u.id, utilizador: req.u.utilizador, detalhe: { colecao: req.params.col, id }, ip: req.ip });
  avisar(req.params.col);
  if (c.tabela === 'postos') sincronizarPostos();
  res.json({ ok: true });
});

app.delete('/api/c/:col/:id', soPortal, exige('admin'), async (req, res) => {
  const c = COLS[req.params.col], id = req.params.id;
  if (!c) return res.status(404).json({ erro: 'Colecção desconhecida.' });
  if (!ID_OK.test(id)) return res.status(400).json({ erro: 'Identificador inválido.' });
  armazem.apagar(c.tabela, id);
  armazem.auditar('dados_apagados', { conta: req.u.id, utilizador: req.u.utilizador, detalhe: { colecao: req.params.col, id }, ip: req.ip });
  if (c.tabela === 'postos') sincronizarPostos();
  avisar(req.params.col);
  res.json({ ok: true });
});

/* ---------- tempo real (Server-Sent Events) ----------
   Avisa as vistas abertas quando os dados mudam. */
const clientes = new Set();
const SSE_MAX = 5000, SSE_POR_IP = 50;
app.get('/api/eventos', (req, res) => {
  if (clientes.size >= SSE_MAX || [...clientes].filter(c => c.ip === req.ip).length >= SSE_POR_IP)
    return res.status(429).json({ erro: 'Demasiadas ligações abertas.' });
  res.set({ 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache', Connection: 'keep-alive', 'X-Accel-Buffering': 'no' });
  res.flushHeaders();
  const cli = { res, nivel: nivelDe(req.u), ip: req.ip };
  clientes.add(cli);
  res.write('retry: 5000\n\n');
  req.on('close', () => clientes.delete(cli));
});
/* aviso só para os ecrãs com sessão (o histórico não é público) */
function avisarContas(nome) { for (const cli of clientes) if (cli.nivel >= NIVEL.posto) cli.res.write(`event: mudou\ndata: ${nome}\n\n`); }
function avisar(col) {
  const c = COLS[col];
  for (const cli of clientes) if (cli.nivel >= NIVEL[c.ler]) cli.res.write(`event: mudou\ndata: ${col}\n\n`);
}
setInterval(() => { for (const cli of clientes) cli.res.write(': ping\n\n'); }, 25000);

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

(async () => {
  console.log('Dados do portal em:', armazem.ficheiro);
  const { novos } = sincronizarPostos();
  if (novos) console.log(`Estado inicial: ${novos} combinações de posto e combustível ficaram «Disponível» por defeito.`);
  app.listen(+PORT, HOST || undefined, () => {
    console.log(`Combustível por Perto a correr em http://localhost:${PORT}`);
    console.log('Deixe esta janela aberta. Para desligar o portal, feche-a ou carregue em Ctrl + C.');
  });
})();
