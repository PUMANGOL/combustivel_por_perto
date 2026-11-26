/* Contas: códigos de primeiro acesso e importação a partir da folha «Perfis de Acesso». */
'use strict';
const crypto = require('crypto');
const bcrypt = require('bcryptjs');
const postos = require('./postos');

const EMAIL_OK = /^[a-z0-9._%+-]+@[a-z0-9.-]+\.[a-z]{2,}$/i;
const PERFIS = ['posto', 'gestor', 'visualizador', 'admin'];
const VALIDADE_CODIGO_DIAS = 30;
const ALFABETO = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';   /* sem 0/O, 1/I */

/* código de 10 caracteres (≈50 bits), apresentado como ABCDE-FGHJK */
function novoCodigo() {
  const b = crypto.randomBytes(10); let c = '';
  for (let i = 0; i < 10; i++) c += ALFABETO[b[i] % ALFABETO.length];
  return c.slice(0, 5) + '-' + c.slice(5);
}
const normalizarCodigo = c => String(c || '').toUpperCase().replace(/[^A-Z0-9]/g, '');
const senhaInutil = () => bcrypt.hashSync(crypto.randomBytes(24).toString('hex'), 10);   /* ninguém a conhece */
async function prepararActivacao() {
  const codigo = novoCodigo();
  return { codigo, hash: await bcrypt.hash(normalizarCodigo(codigo), 10), expira: Date.now() + VALIDADE_CODIGO_DIAS * 864e5 };
}

/* tipo da folha → perfil do portal */
const N = s => String(s || '').normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase().replace(/[^a-z0-9]/g, '');
const TIPOS = { admin: 'admin', administrador: 'admin', gestor: 'gestor', visualizador: 'visualizador', posto: 'posto' };
/* nomes da folha que diferem da lista de postos do portal */
const ALIASES = { estadio11denovembro: '11 DE NOVEMBRO', huambo: 'HUAMBO BASE', malange: 'MALANGE SS', welwitschia: 'WELWITCHIA' };

function postoPeloNome(nome, lista) {
  const n = N(nome), por = new Map(lista.map(p => [N(p.nome), p]));
  return por.get(n) || (ALIASES[n] && por.get(N(ALIASES[n]))) || null;
}

/* linhas: [{nome, email, tipo, posto?}] → cria as contas que ainda não existem (pendentes, com código) */
async function importar(armazem, linhas, { auditar } = {}) {
  const lista = postos.lista(armazem), res = [], vistos = new Set();
  for (const [i, l] of linhas.entries()) {
    const nome = String(l.nome || '').trim(), email = String(l.email || '').trim().toLowerCase(), tipo = TIPOS[N(l.tipo).replace(/\.$/, '')];
    const r = { linha: i + 1, nome, email, perfil: tipo || String(l.tipo || '').trim() };
    if (!email || !EMAIL_OK.test(email) || email.length > 120) { res.push({ ...r, estado: 'erro', motivo: 'email inválido' }); continue; }
    if (vistos.has(email)) { res.push({ ...r, estado: 'erro', motivo: 'email repetido na lista' }); continue; }
    vistos.add(email);
    if (!tipo) { res.push({ ...r, estado: 'erro', motivo: 'tipo desconhecido (Admin, Gestor, Visualizador ou Posto)' }); continue; }
    if (!nome || nome.length > 80 || /[<>\u0000-\u001f]/.test(nome)) { res.push({ ...r, estado: 'erro', motivo: 'nome inválido' }); continue; }
    let posto = null;
    if (tipo === 'posto') {
      const p = l.posto ? lista.find(x => x.id === String(l.posto).trim()) : postoPeloNome(nome, lista);
      if (!p) { res.push({ ...r, estado: 'erro', motivo: 'posto não encontrado na lista de postos' }); continue; }
      posto = p.id; r.posto = p.id; r.postoNome = p.nome;
    }
    if (armazem.existeUtilizador(email)) { res.push({ ...r, estado: 'existente', motivo: 'já existe: não foi alterada' }); continue; }
    const a = await prepararActivacao();
    armazem.criarUtilizador({ utilizador: email, nome, hash: senhaInutil(), perfil: tipo, posto, activacaoHash: a.hash, expira: a.expira });
    res.push({ ...r, estado: 'criada', codigo: a.codigo, expira: a.expira });
  }
  if (auditar) auditar({ criadas: res.filter(x => x.estado === 'criada').length, existentes: res.filter(x => x.estado === 'existente').length, erros: res.filter(x => x.estado === 'erro').length });
  return res;
}

/* texto colado do Excel (tabulações) ou CSV (; ou ,): Nome | email | Tipo | … | (Posto) */
function lerTabela(txt) {
  const linhas = String(txt || '').replace(/\r/g, '').split('\n').map(l => l.trim() ? l : null).filter(Boolean);
  if (!linhas.length) return [];
  const sep = linhas[0].includes('\t') ? '\t' : (linhas[0].split(';').length > linhas[0].split(',').length ? ';' : ',');
  const partes = linhas.map(l => l.split(sep).map(c => c.trim().replace(/^"|"$/g, '')));
  const cab = partes[0].map(N);
  const temCab = cab.some(c => c === 'email' || c === 'nome');
  const col = nome => cab.findIndex(c => c === nome || c.startsWith(nome));
  const iN = temCab ? col('nome') : 0, iE = temCab ? col('email') : 1, iT = temCab ? col('tipo') : 2, iP = temCab ? cab.findIndex(c => c === 'posto' || c === 'codigoposto') : -1;
  return (temCab ? partes.slice(1) : partes).map(p => ({ nome: p[iN], email: p[iE], tipo: p[iT], posto: iP >= 0 ? p[iP] : undefined }));
}

module.exports = { EMAIL_OK, PERFIS, VALIDADE_CODIGO_DIAS, novoCodigo, normalizarCodigo, senhaInutil, prepararActivacao, importar, lerTabela, postoPeloNome };
