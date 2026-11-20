/* Dados próprios do portal (confirmações, decisões, contas…). O mesmo SQL em dois modos:
   - servidor próprio: ficheiro SQLite dentro da pasta do portal, com o SQLite que já vem com o Node.js (22.13 ou superior);
     não é preciso instalar nenhuma base de dados;
   - Vercel (ou outro alojamento sem disco gravável): base de dados Turso (libSQL, compatível com SQLite),
     indicada por TURSO_DATABASE_URL e TURSO_AUTH_TOKEN. Ver VERCEL.md.
   Todas as funções são assíncronas. As tabelas são criadas no primeiro acesso. */
'use strict';
const fs = require('fs');
const path = require('path');

const TURSO_URL = String(process.env.TURSO_DATABASE_URL || '').trim();

/* ---------- ligação: ficheiro local (node:sqlite) ---------- */
function ligarFicheiro() {
  /* o aviso «SQLite is an experimental feature» do Node não interessa a quem usa o portal */
  const emitir = process.emitWarning;
  process.emitWarning = function (w, ...r) {
    if (String(w && w.message || w).includes('SQLite')) return;
    return emitir.call(process, w, ...r);
  };
  let DatabaseSync;
  try { ({ DatabaseSync } = require('node:sqlite')); }
  catch (e) {
    console.error(`Este portal precisa do Node.js 22.13 ou superior (tem o ${process.version}). Instale a versão LTS em nodejs.org.`);
    process.exit(1);
  }
  const ficheiro = path.resolve(__dirname, process.env.DADOS_FICHEIRO || 'dados/via-abastece.sqlite');
  try {
    fs.mkdirSync(path.dirname(ficheiro), { recursive: true });
    fs.accessSync(path.dirname(ficheiro), fs.constants.W_OK);
  } catch (e) {
    console.error(`\nNão é possível gravar os dados em: ${path.dirname(ficheiro)} (${e.code || e.message}).`);
    console.error('Em servidores com o sistema de ficheiros só de leitura, defina a variável DADOS_FICHEIRO');
    console.error('com um caminho gravável e persistente (por exemplo /var/lib/combustivel/via-abastece.sqlite),');
    console.error('ou use uma base de dados Turso (TURSO_DATABASE_URL e TURSO_AUTH_TOKEN; ver VERCEL.md).\n');
    process.exit(1);
  }
  const db = new DatabaseSync(ficheiro);
  db.exec('PRAGMA journal_mode=WAL; PRAGMA busy_timeout=5000; PRAGMA foreign_keys=ON;');
  const preparadas = new Map();
  const prep = sql => { let s = preparadas.get(sql); if (!s) preparadas.set(sql, s = db.prepare(sql)); return s; };
  return {
    descricao: ficheiro,
    remota: false,
    todos: async (sql, a = []) => prep(sql).all(...a),
    um: async (sql, a = []) => prep(sql).get(...a),
    correr: async (sql, a = []) => { const r = prep(sql).run(...a); return { changes: Number(r.changes), lastId: Number(r.lastInsertRowid) }; },
    /* várias escritas numa só transacção: ou ficam todas gravadas, ou nenhuma */
    lote: async lista => {
      db.exec('BEGIN IMMEDIATE');
      try {
        const out = lista.map(([sql, a = []]) => ({ changes: Number(prep(sql).run(...a).changes) }));
        db.exec('COMMIT');
        return out;
      } catch (e) { db.exec('ROLLBACK'); throw e; }
    },
    /* cópia de segurança consistente, mesmo com o portal ligado */
    copiar: async destino => { db.exec(`VACUUM INTO '${String(destino).replace(/'/g, "''")}'`); },
    fechar: async () => { db.close(); },
  };
}

/* ---------- ligação: Turso / libSQL ---------- */
function ligarTurso(url) {
  /* na Vercel usa-se o cliente só por HTTP (sem módulos nativos); «file:» serve para testar este modo localmente */
  const { createClient } = url.startsWith('file:') ? require('@libsql/client') : require('@libsql/client/web');
  /* a biblioteca descarta o texto dos erros HTTP da Turso (por exemplo, base de dados inexistente ou token recusado):
     fica no registo, para se saber a causa. As sondagens de versão (GET) que falham são normais e não se registam. */
  const fetchComErros = async (pedido, ...resto) => {
    const r = await fetch(pedido, ...resto);
    const metodo = (pedido && pedido.method) || (resto[0] && resto[0].method) || 'GET';
    if (!r.ok && metodo !== 'GET') {
      try { console.error(`Turso respondeu HTTP ${r.status}: ${(await r.clone().text()).slice(0, 400) || '(sem texto)'}`); } catch (_) {}
    }
    return r;
  };
  const c = createClient({ url, authToken: String(process.env.TURSO_AUTH_TOKEN || '').trim() || undefined, fetch: fetchComErros });
  const objectos = rs => rs.rows.map(r => Object.fromEntries(rs.columns.map((k, i) => [k, r[i]])));
  return {
    descricao: 'Turso ' + url.replace(/[?#].*$/, ''),
    remota: true,
    todos: async (sql, a = []) => objectos(await c.execute({ sql, args: a })),
    um: async (sql, a = []) => objectos(await c.execute({ sql, args: a }))[0],
    correr: async (sql, a = []) => { const r = await c.execute({ sql, args: a }); return { changes: r.rowsAffected, lastId: Number(r.lastInsertRowid ?? 0) }; },
    lote: async lista => (await c.batch(lista.map(([sql, a = []]) => ({ sql, args: a })), 'write')).map(r => ({ changes: r.rowsAffected })),
    copiar: async () => { throw new Error('Com a base de dados Turso, as cópias de segurança fazem-se na Turso (ver VERCEL.md).'); },
    fechar: async () => { c.close(); },
  };
}

if (!TURSO_URL && process.env.VERCEL) {
  console.error('Na Vercel os dados não podem ficar num ficheiro: ligue uma base de dados Turso e defina TURSO_DATABASE_URL e TURSO_AUTH_TOKEN (ver VERCEL.md).');
  process.exit(1);
}
const base = TURSO_URL ? ligarTurso(TURSO_URL) : ligarFicheiro();

/* ---------- tabelas ---------- */
const TABELAS = ['postos', 'runouts', 'confirmacoes', 'decisoes', 'registos', 'config'];
const UTILIZADORES = `(
    id INTEGER PRIMARY KEY AUTOINCREMENT, utilizador TEXT NOT NULL UNIQUE COLLATE NOCASE, nome TEXT NOT NULL,
    senha_hash TEXT NOT NULL, perfil TEXT NOT NULL CHECK (perfil IN ('posto','gestor','admin')), posto_id TEXT,
    activo INTEGER NOT NULL DEFAULT 1, criado_em INTEGER NOT NULL)`;
/* registo de auditoria: acções sobre contas, sessões e dados (só acrescenta; guarda as 20 000 mais recentes) */
const AUD_MAX = 20000;
/* histórico: no máximo as 5 últimas confirmações de cada posto e combustível */
const HIST_MAX = 5;
const ESQUEMA = [
  ...TABELAS.map(t => `CREATE TABLE IF NOT EXISTS ${t} (
    id TEXT PRIMARY KEY, posto TEXT, prod TEXT, dados TEXT NOT NULL,
    actualizado_em INTEGER NOT NULL, actualizado_por INTEGER)`),
  'CREATE INDEX IF NOT EXISTS ix_conf_posto ON confirmacoes (posto, prod)',
  'CREATE INDEX IF NOT EXISTS ix_runouts_posto ON runouts (posto, prod)',
  'CREATE TABLE IF NOT EXISTS utilizadores ' + UTILIZADORES,
  `CREATE TABLE IF NOT EXISTS auditoria (
    seq INTEGER PRIMARY KEY AUTOINCREMENT, hora INTEGER NOT NULL, accao TEXT NOT NULL,
    conta TEXT, utilizador TEXT, detalhe TEXT, ip TEXT)`,
  `CREATE TABLE IF NOT EXISTS historico (
    seq INTEGER PRIMARY KEY AUTOINCREMENT, posto TEXT NOT NULL, prod TEXT NOT NULL CHECK (prod IN ('GA','GO')),
    estado TEXT NOT NULL CHECK (estado IN ('venda','interrompida')), hora INTEGER NOT NULL, momento TEXT,
    utilizador TEXT NOT NULL, conta TEXT)`,
  'CREATE INDEX IF NOT EXISTS ix_hist ON historico (posto, prod, hora DESC, seq DESC)',
  /* limites de tentativas de entrada e de escritas: na base de dados, para valerem em todas as instâncias do portal */
  'CREATE TABLE IF NOT EXISTS limites (chave TEXT PRIMARY KEY, n INTEGER NOT NULL, desde INTEGER NOT NULL)',
  /* versão de cada colecção: sobe a cada alteração; os ecrãs abertos recarregam só o que mudou */
  'CREATE TABLE IF NOT EXISTS versoes (col TEXT PRIMARY KEY, v INTEGER NOT NULL)',
];

async function iniciar() {
  /* versões anteriores (perfis posto/gestao): converter uma única vez, mantendo ids, senhas e estado.
     «gestao» tinha acesso total, por isso passa a «admin». Nada mais é alterado. */
  const def = await base.um("SELECT sql FROM sqlite_master WHERE type='table' AND name='utilizadores'");
  if (def && /'gestao'/.test(def.sql)) {
    await base.lote([
      ['CREATE TABLE utilizadores_v5 ' + UTILIZADORES],
      [`INSERT INTO utilizadores_v5 (id, utilizador, nome, senha_hash, perfil, posto_id, activo, criado_em)
        SELECT id, utilizador, nome, senha_hash, CASE perfil WHEN 'gestao' THEN 'admin' ELSE perfil END, posto_id, activo, criado_em FROM utilizadores`],
      ['DROP TABLE utilizadores'],
      ['ALTER TABLE utilizadores_v5 RENAME TO utilizadores'],
    ]);
    console.log('Contas convertidas para os perfis posto / gestor / admin (as contas de gestão passaram a admin).');
  }
  await base.lote([
    ...ESQUEMA.map(sql => [sql]),
    ['INSERT OR IGNORE INTO config (id, dados, actualizado_em) VALUES (?, ?, ?)', ['geral', JSON.stringify({ validadeMin: 240 }), Date.now()]],
    /* versão 4: só existe a última confirmação de cada posto e combustível (id c-<posto>-<GA|GO>).
       Registos de versões anteriores, com outro formato, são retirados. Os runouts deixaram de ser usados. */
    ...['confirmacoes', 'registos'].map(t => [`DELETE FROM ${t} WHERE id NOT GLOB 'c-*-GA' AND id NOT GLOB 'c-*-GO'`]),
    ['DELETE FROM runouts'],
  ]);
}
/* uma só preparação por processo; se falhar (por exemplo, a base remota não responde), tenta de novo no pedido seguinte */
let preparado = null;
const garantir = () => (preparado ||= iniciar().catch(e => { preparado = null; throw e; }));

const ok = t => { if (!TABELAS.includes(t)) throw new Error('Tabela desconhecida: ' + t); return t; };
const UPSERT = t => `INSERT INTO ${ok(t)} (id, posto, prod, dados, actualizado_em, actualizado_por) VALUES (?, ?, ?, ?, ?, ?)
      ON CONFLICT(id) DO UPDATE SET posto = excluded.posto, prod = excluded.prod, dados = excluded.dados,
        actualizado_em = excluded.actualizado_em, actualizado_por = excluded.actualizado_por`;
const CORTA_HIST = `DELETE FROM historico WHERE posto = ? AND prod = ? AND seq NOT IN
      (SELECT seq FROM historico WHERE posto = ? AND prod = ? ORDER BY hora DESC, seq DESC LIMIT ${HIST_MAX})`;
const SOMA_LIMITE = `INSERT INTO limites (chave, n, desde) VALUES (?, 1, ?)
      ON CONFLICT(chave) DO UPDATE SET
        n = CASE WHEN excluded.desde - limites.desde >= ? THEN 1 ELSE limites.n + 1 END,
        desde = CASE WHEN excluded.desde - limites.desde >= ? THEN excluded.desde ELSE limites.desde END`;

const listar = async t => { await garantir(); return (await base.todos(`SELECT id, dados FROM ${ok(t)}`)).map(r => ({ id: r.id, dados: JSON.parse(r.dados) })); };

module.exports = {
  ficheiro: base.descricao,
  remota: base.remota,
  TABELAS,
  iniciar: garantir,
  listar,
  async existe(t, id) { await garantir(); return !!(await base.um(`SELECT 1 AS x FROM ${ok(t)} WHERE id = ?`, [id])); },
  async gravar(t, id, obj, por) {
    await garantir();
    await base.correr(UPSERT(t), [id, obj.posto != null ? String(obj.posto) : null, obj.prod || null, JSON.stringify(obj), Date.now(), por ?? null]);
  },
  async apagar(t, id) { await garantir(); await base.correr(`DELETE FROM ${ok(t)} WHERE id = ?`, [id]); },
  async contar(t) { await garantir(); return Number((await base.um(`SELECT COUNT(*) AS n FROM ${ok(t)}`)).n); },
  async utilizador(nome) {
    await garantir();
    return base.um('SELECT id, utilizador, nome, senha_hash, perfil, posto_id FROM utilizadores WHERE utilizador = ? AND activo = 1', [String(nome).trim()]);
  },
  /* só cria: uma conta existente nunca é alterada por aqui (perfis só mudam por acção do admin) */
  async criarUtilizador({ utilizador, nome, hash, perfil, posto }) {
    await garantir();
    await base.correr('INSERT INTO utilizadores (utilizador, nome, senha_hash, perfil, posto_id, activo, criado_em) VALUES (?, ?, ?, ?, ?, 1, ?)',
      [utilizador, nome, hash, perfil, posto ?? null, Date.now()]);
  },
  async alterarPerfil(u, perfil, posto) {
    await garantir();
    return (await base.correr('UPDATE utilizadores SET perfil = ?, posto_id = ? WHERE utilizador = ?', [perfil, posto ?? null, String(u)])).changes > 0;
  },
  /* confirmação de um posto: o estado público e quem confirmou são gravados juntos, ou nada é gravado */
  async confirmar(linhas, por) {
    await garantir();
    const agora = Date.now(), lista = [];
    for (const { conf, registo } of linhas) {
      const pid = String(conf.posto);
      lista.push([UPSERT('confirmacoes'), [conf.id, pid, conf.prod, JSON.stringify(conf), agora, por ?? null]]);
      lista.push([UPSERT('registos'), [registo.id, String(registo.posto), registo.prod, JSON.stringify(registo), agora, por ?? null]]);
      lista.push(['INSERT INTO historico (posto, prod, estado, hora, momento, utilizador, conta) VALUES (?, ?, ?, ?, ?, ?, ?)',
        [pid, conf.prod, conf[conf.prod], conf.hora, conf.momento || null, registo.utilizador, registo.conta ?? null]]);
      lista.push([CORTA_HIST, [pid, conf.prod, pid, conf.prod]]);
    }
    if (lista.length) await base.lote(lista);
  },
  /* estado inicial: cada posto e combustível sem confirmação fica «Disponível» por defeito.
     Nunca substitui uma confirmação existente. Devolve quantas foram criadas. */
  async semear(ids) {
    await garantir();
    const existentes = new Set((await base.todos('SELECT id FROM confirmacoes')).map(r => r.id));
    const agora = Date.now(), lista = [];
    for (const pid of ids) for (const prod of ['GA', 'GO']) {
      const id = `c-${pid}-${prod}`, pv = /^\d+$/.test(pid) ? Number(pid) : pid;
      if (existentes.has(id)) continue;
      /* o registo só entra se a confirmação ainda não existir (vem primeiro na mesma transacção) */
      lista.push([`INSERT INTO registos (id, posto, prod, dados, actualizado_em, actualizado_por)
        SELECT ?, ?, ?, ?, ?, NULL WHERE NOT EXISTS (SELECT 1 FROM confirmacoes WHERE id = ?) ON CONFLICT(id) DO NOTHING`,
        [id, String(pid), prod, JSON.stringify({ id, posto: pv, prod, hora: agora, utilizador: 'Estado inicial do portal', conta: null }), agora, id]]);
      lista.push([`INSERT INTO confirmacoes (id, posto, prod, dados, actualizado_em, actualizado_por) VALUES (?, ?, ?, ?, ?, NULL) ON CONFLICT(id) DO NOTHING`,
        [id, String(pid), prod, JSON.stringify({ id, posto: pv, prod, hora: agora, [prod]: 'venda', momento: 'Estado inicial', inicial: true }), agora]]);
    }
    if (!lista.length) return 0;
    return (await base.lote(lista)).reduce((n, r, i) => n + (i % 2 ? r.changes : 0), 0);
  },
  /* as últimas confirmações (no máximo 5) de um posto e combustível, da mais recente para a mais antiga */
  async historico(posto, prod) {
    await garantir();
    return base.todos('SELECT prod, estado, hora, momento, utilizador FROM historico WHERE posto = ? AND prod = ? ORDER BY hora DESC, seq DESC LIMIT ?',
      [String(posto), prod, HIST_MAX]);
  },
  /* confirmações de postos que deixaram de existir na lista (depois de a lista ser substituída) */
  async limparOrfaos(ids) {
    await garantir();
    const v = new Set(ids.map(String)), lista = [];
    for (const t of ['confirmacoes', 'registos'])
      for (const r of await base.todos(`SELECT id, posto FROM ${t}`))
        if (!v.has(String(r.posto))) lista.push([`DELETE FROM ${t} WHERE id = ?`, [r.id]]);
    for (const r of await base.todos('SELECT DISTINCT posto FROM historico'))
      if (!v.has(String(r.posto))) lista.push(['DELETE FROM historico WHERE posto = ?', [r.posto]]);
    if (!lista.length) return 0;
    return (await base.lote(lista)).reduce((n, r) => n + r.changes, 0);
  },
  /* verificação de integridade da base e da coerência das confirmações */
  async integridade(validos) {
    await garantir();
    const prob = [];
    try {
      const ic = (await base.todos('PRAGMA integrity_check')).map(r => Object.values(r)[0]);
      if (!(ic.length === 1 && ic[0] === 'ok')) prob.push('integrity_check: ' + ic.join('; '));
    } catch (e) { if (!base.remota) throw e; /* a Turso pode não permitir este PRAGMA: verifica-se só o resto */ }
    const conf = new Map((await listar('confirmacoes')).map(r => [r.id, r.dados]));
    const reg = new Map((await listar('registos')).map(r => [r.id, r.dados]));
    for (const [id, c] of conf) {
      const m = /^c-(.+)-(GA|GO)$/.exec(id);
      if (!m) { prob.push(`${id}: identificador fora do formato`); continue; }
      if (String(c.posto) !== m[1] || c.prod !== m[2]) prob.push(`${id}: posto/produto não coincidem com o identificador`);
      if (validos && !validos.has(m[1])) prob.push(`${id}: posto ${m[1]} não existe na lista de postos`);
      if (!['venda', 'interrompida'].includes(c[m[2]])) prob.push(`${id}: estado inválido`);
      if (!Number.isFinite(c.hora)) prob.push(`${id}: hora inválida`);
      if (c.utilizador) prob.push(`${id}: nome do responsável na tabela pública`);
      const r = reg.get(id);
      if (!r) prob.push(`${id}: sem registo de quem confirmou`);
      else if (r.hora !== c.hora) prob.push(`${id}: hora diferente no registo de quem confirmou`);
    }
    for (const id of reg.keys()) if (!conf.has(id)) prob.push(`${id}: registo sem confirmação`);
    for (const h of await base.todos('SELECT posto, prod, COUNT(*) AS n FROM historico GROUP BY posto, prod HAVING n > ?', [HIST_MAX]))
      prob.push(`histórico do posto ${h.posto} ${h.prod}: ${h.n} entradas (máximo ${HIST_MAX})`);
    /* a entrada mais recente do histórico de cada posto e combustível (uma só consulta) */
    const ultima = new Map();
    for (const h of await base.todos('SELECT posto, prod, estado, hora FROM historico ORDER BY hora DESC, seq DESC')) {
      const k = h.posto + '|' + h.prod;
      if (!ultima.has(k)) ultima.set(k, h);
    }
    for (const [id, c] of conf) {
      if (c.inicial) continue;
      const m = /^c-(.+)-(GA|GO)$/.exec(id); if (!m) continue;
      const h = ultima.get(m[1] + '|' + m[2]);
      if (h && (Number(h.hora) !== c.hora || h.estado !== c[m[2]])) prob.push(`${id}: a última entrada do histórico não coincide com a confirmação actual`);
    }
    const dup = await base.todos('SELECT posto, prod, COUNT(*) AS n FROM confirmacoes GROUP BY posto, prod HAVING n > 1');
    for (const d of dup) prob.push(`posto ${d.posto} ${d.prod}: ${d.n} confirmações (devia ser 1)`);
    return { ok: prob.length === 0, problemas: prob, confirmacoes: conf.size };
  },
  async porId(id) {
    await garantir();
    return base.um('SELECT id, utilizador, nome, perfil, posto_id, activo, senha_hash FROM utilizadores WHERE id = ?', [Number(id)]);
  },
  async auditar(accao, { conta = null, utilizador = null, detalhe = null, ip = null } = {}) {
    try {
      await garantir();
      const r = await base.correr('INSERT INTO auditoria (hora, accao, conta, utilizador, detalhe, ip) VALUES (?, ?, ?, ?, ?, ?)',
        [Date.now(), String(accao).slice(0, 40), conta == null ? null : String(conta), utilizador == null ? null : String(utilizador).slice(0, 80),
          detalhe == null ? null : String(typeof detalhe === 'string' ? detalhe : JSON.stringify(detalhe)).slice(0, 500), ip == null ? null : String(ip).slice(0, 64)]);
      if (r.lastId % 500 === 0) await base.correr('DELETE FROM auditoria WHERE seq <= ?', [r.lastId - AUD_MAX]);
    } catch (e) { console.error('auditoria:', e.message); }
  },
  async auditoria(limite = 200) {
    await garantir();
    return base.todos('SELECT hora, accao, utilizador, detalhe, ip FROM auditoria ORDER BY seq DESC LIMIT ?', [Math.min(1000, Math.max(1, Number(limite) || 200))]);
  },
  async porNome(u) { await garantir(); return base.um('SELECT id, utilizador, nome, perfil, posto_id, activo FROM utilizadores WHERE utilizador = ?', [String(u)]); },
  async existeUtilizador(u) { await garantir(); return !!(await base.um('SELECT 1 AS x FROM utilizadores WHERE utilizador = ?', [String(u)])); },
  async mudarSenha(u, hash) { await garantir(); return (await base.correr('UPDATE utilizadores SET senha_hash = ? WHERE utilizador = ?', [hash, String(u)])).changes > 0; },
  async estadoConta(u, activo) { await garantir(); return (await base.correr('UPDATE utilizadores SET activo = ? WHERE utilizador = ?', [activo ? 1 : 0, String(u)])).changes > 0; },
  async desactivarUtilizador(utilizador) { await garantir(); return (await base.correr('UPDATE utilizadores SET activo = 0 WHERE utilizador = ?', [utilizador])).changes; },
  async contas() {
    await garantir();
    return base.todos('SELECT utilizador, nome, perfil, posto_id, activo FROM utilizadores ORDER BY perfil, utilizador');
  },

  /* ---------- limites (janela fixa): tentativas de entrada e escritas por endereço ---------- */
  /* soma 1 ao contador e devolve o novo valor */
  async somarLimite(chave, janela) {
    await garantir();
    const agora = Date.now();
    const r = await base.um(SOMA_LIMITE + ' RETURNING n', [String(chave), agora, janela, janela]);
    if (Math.random() < 0.01) await base.correr('DELETE FROM limites WHERE desde < ?', [agora - 24 * 3600e3]);
    return Number(r.n);
  },
  /* soma 1 a vários contadores, numa só ida à base de dados */
  async somarLimites(chaves, janela) {
    await garantir();
    const agora = Date.now();
    await base.lote(chaves.map(k => [SOMA_LIMITE, [String(k), agora, janela, janela]]));
  },
  /* valor actual de cada contador (0 se a janela já passou) */
  async contarLimites(chaves, janela) {
    await garantir();
    const agora = Date.now();
    const rs = await base.todos(`SELECT chave, n, desde FROM limites WHERE chave IN (${chaves.map(() => '?').join(', ')})`, chaves.map(String));
    const m = new Map(rs.map(r => [r.chave, agora - Number(r.desde) < janela ? Number(r.n) : 0]));
    return chaves.map(k => m.get(String(k)) || 0);
  },
  async limparLimite(chave) { await garantir(); await base.correr('DELETE FROM limites WHERE chave = ?', [String(chave)]); },

  /* ---------- versões das colecções (avisos em tempo real entre instâncias) ---------- */
  async versoes() {
    await garantir();
    return Object.fromEntries((await base.todos('SELECT col, v FROM versoes')).map(r => [r.col, Number(r.v)]));
  },
  async marcar(cols) {
    await garantir();
    await base.lote(cols.map(c => ['INSERT INTO versoes (col, v) VALUES (?, 1) ON CONFLICT(col) DO UPDATE SET v = versoes.v + 1', [String(c)]]));
  },

  async copiar(destino) { await garantir(); await base.copiar(destino); },
  /* todas as tabelas de dados, para cópia de segurança em .json (modo Turso) */
  async exportar() {
    await garantir();
    const out = { exportado_em: new Date().toISOString(), origem: base.descricao, tabelas: {} };
    for (const t of [...TABELAS, 'utilizadores', 'historico', 'auditoria', 'versoes']) out.tabelas[t] = await base.todos(`SELECT * FROM ${t}`);
    return out;
  },
  async fechar() { await base.fechar(); },
};
