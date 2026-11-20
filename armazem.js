/* Dados próprios do portal (confirmações, decisões, contas…) num ficheiro SQLite dentro da pasta do portal.
   Usa o SQLite que já vem com o Node.js (22.13 ou superior): não é preciso instalar nenhuma base de dados. */
'use strict';
const fs = require('fs');
const path = require('path');

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
fs.mkdirSync(path.dirname(ficheiro), { recursive: true });
const db = new DatabaseSync(ficheiro);
db.exec('PRAGMA journal_mode=WAL; PRAGMA busy_timeout=5000; PRAGMA foreign_keys=ON;');

const TABELAS = ['postos', 'runouts', 'confirmacoes', 'decisoes', 'registos', 'config'];
for (const t of TABELAS) {
  db.exec(`CREATE TABLE IF NOT EXISTS ${t} (
    id TEXT PRIMARY KEY, posto TEXT, prod TEXT, dados TEXT NOT NULL,
    actualizado_em INTEGER NOT NULL, actualizado_por INTEGER)`);
}
db.exec(`CREATE INDEX IF NOT EXISTS ix_conf_posto ON confirmacoes (posto, prod);
  CREATE INDEX IF NOT EXISTS ix_runouts_posto ON runouts (posto, prod);
  CREATE TABLE IF NOT EXISTS utilizadores (
    id INTEGER PRIMARY KEY AUTOINCREMENT, utilizador TEXT NOT NULL UNIQUE COLLATE NOCASE, nome TEXT NOT NULL,
    senha_hash TEXT NOT NULL, perfil TEXT NOT NULL CHECK (perfil IN ('posto','gestor','admin')), posto_id TEXT,
    activo INTEGER NOT NULL DEFAULT 1, criado_em INTEGER NOT NULL)`);
/* versões anteriores (perfis posto/gestao): converter uma única vez, mantendo ids, senhas e estado.
   «gestao» tinha acesso total, por isso passa a «admin». Nada mais é alterado. */
{
  const def = db.prepare("SELECT sql FROM sqlite_master WHERE type='table' AND name='utilizadores'").get();
  if (def && /'gestao'/.test(def.sql)) {
    db.exec(`BEGIN IMMEDIATE;
      CREATE TABLE utilizadores_v5 (
        id INTEGER PRIMARY KEY AUTOINCREMENT, utilizador TEXT NOT NULL UNIQUE COLLATE NOCASE, nome TEXT NOT NULL,
        senha_hash TEXT NOT NULL, perfil TEXT NOT NULL CHECK (perfil IN ('posto','gestor','admin')), posto_id TEXT,
        activo INTEGER NOT NULL DEFAULT 1, criado_em INTEGER NOT NULL);
      INSERT INTO utilizadores_v5 (id, utilizador, nome, senha_hash, perfil, posto_id, activo, criado_em)
        SELECT id, utilizador, nome, senha_hash, CASE perfil WHEN 'gestao' THEN 'admin' ELSE perfil END, posto_id, activo, criado_em FROM utilizadores;
      DROP TABLE utilizadores;
      ALTER TABLE utilizadores_v5 RENAME TO utilizadores;
      COMMIT;`);
    console.log('Contas convertidas para os perfis posto / gestor / admin (as contas de gestão passaram a admin).');
  }
}
/* registo de auditoria: acções sobre contas, sessões e dados (só acrescenta; guarda as 20 000 mais recentes) */
const AUD_MAX = 20000;
db.exec(`CREATE TABLE IF NOT EXISTS auditoria (
    seq INTEGER PRIMARY KEY AUTOINCREMENT, hora INTEGER NOT NULL, accao TEXT NOT NULL,
    conta TEXT, utilizador TEXT, detalhe TEXT, ip TEXT);`);
/* histórico: no máximo as 5 últimas confirmações de cada posto e combustível */
const HIST_MAX = 5;
db.exec(`CREATE TABLE IF NOT EXISTS historico (
    seq INTEGER PRIMARY KEY AUTOINCREMENT, posto TEXT NOT NULL, prod TEXT NOT NULL CHECK (prod IN ('GA','GO')),
    estado TEXT NOT NULL CHECK (estado IN ('venda','interrompida')), hora INTEGER NOT NULL, momento TEXT,
    utilizador TEXT NOT NULL, conta TEXT);
  CREATE INDEX IF NOT EXISTS ix_hist ON historico (posto, prod, hora DESC, seq DESC);`);
db.prepare('INSERT OR IGNORE INTO config (id, dados, actualizado_em) VALUES (?, ?, ?)').run('geral', JSON.stringify({ validadeMin: 240 }), Date.now());
/* versão 4: só existe a última confirmação de cada posto e combustível (id c-<posto>-<GA|GO>).
   Registos de versões anteriores, com outro formato, são retirados. Os runouts deixaram de ser usados. */
for (const t of ['confirmacoes', 'registos']) db.prepare(`DELETE FROM ${t} WHERE id NOT GLOB 'c-*-GA' AND id NOT GLOB 'c-*-GO'`).run();
db.prepare('DELETE FROM runouts').run();

const ok = t => { if (!TABELAS.includes(t)) throw new Error('Tabela desconhecida: ' + t); return t; };

module.exports = {
  ficheiro,
  TABELAS,
  listar(t) {
    return db.prepare(`SELECT id, dados FROM ${ok(t)}`).all().map(r => ({ id: r.id, dados: JSON.parse(r.dados) }));
  },
  existe(t, id) { return !!db.prepare(`SELECT 1 FROM ${ok(t)} WHERE id = ?`).get(id); },
  gravar(t, id, obj, por) {
    db.prepare(`INSERT INTO ${ok(t)} (id, posto, prod, dados, actualizado_em, actualizado_por) VALUES (?, ?, ?, ?, ?, ?)
      ON CONFLICT(id) DO UPDATE SET posto = excluded.posto, prod = excluded.prod, dados = excluded.dados,
        actualizado_em = excluded.actualizado_em, actualizado_por = excluded.actualizado_por`)
      .run(id, obj.posto != null ? String(obj.posto) : null, obj.prod || null, JSON.stringify(obj), Date.now(), por ?? null);
  },
  apagar(t, id) { db.prepare(`DELETE FROM ${ok(t)} WHERE id = ?`).run(id); },
  contar(t) { return db.prepare(`SELECT COUNT(*) AS n FROM ${ok(t)}`).get().n; },
  utilizador(nome) {
    return db.prepare('SELECT id, utilizador, nome, senha_hash, perfil, posto_id FROM utilizadores WHERE utilizador = ? AND activo = 1').get(String(nome).trim());
  },
  /* só cria: uma conta existente nunca é alterada por aqui (perfis só mudam por acção do admin) */
  criarUtilizador({ utilizador, nome, hash, perfil, posto }) {
    db.prepare(`INSERT INTO utilizadores (utilizador, nome, senha_hash, perfil, posto_id, activo, criado_em) VALUES (?, ?, ?, ?, ?, 1, ?)`)
      .run(utilizador, nome, hash, perfil, posto ?? null, Date.now());
  },
  alterarPerfil(u, perfil, posto) {
    return db.prepare('UPDATE utilizadores SET perfil = ?, posto_id = ? WHERE utilizador = ?').run(perfil, posto ?? null, String(u)).changes > 0;
  },
  /* confirmação de um posto: o estado público e quem confirmou são gravados juntos, ou nada é gravado */
  confirmar(linhas, por) {
    const agora = Date.now();
    const ins = t => db.prepare(`INSERT INTO ${t} (id, posto, prod, dados, actualizado_em, actualizado_por) VALUES (?, ?, ?, ?, ?, ?)
      ON CONFLICT(id) DO UPDATE SET posto = excluded.posto, prod = excluded.prod, dados = excluded.dados,
        actualizado_em = excluded.actualizado_em, actualizado_por = excluded.actualizado_por`);
    const iC = ins('confirmacoes'), iR = ins('registos');
    const iH = db.prepare('INSERT INTO historico (posto, prod, estado, hora, momento, utilizador, conta) VALUES (?, ?, ?, ?, ?, ?, ?)');
    const corta = db.prepare(`DELETE FROM historico WHERE posto = ? AND prod = ? AND seq NOT IN
      (SELECT seq FROM historico WHERE posto = ? AND prod = ? ORDER BY hora DESC, seq DESC LIMIT ${HIST_MAX})`);
    db.exec('BEGIN IMMEDIATE');
    try {
      for (const { conf, registo } of linhas) {
        iC.run(conf.id, String(conf.posto), conf.prod, JSON.stringify(conf), agora, por ?? null);
        iR.run(registo.id, String(registo.posto), registo.prod, JSON.stringify(registo), agora, por ?? null);
        const pid = String(conf.posto);
        iH.run(pid, conf.prod, conf[conf.prod], conf.hora, conf.momento || null, registo.utilizador, registo.conta ?? null);
        corta.run(pid, conf.prod, pid, conf.prod);
      }
      db.exec('COMMIT');
    } catch (e) { db.exec('ROLLBACK'); throw e; }
  },
  /* estado inicial: cada posto e combustível sem confirmação fica «Disponível» por defeito.
     Nunca substitui uma confirmação existente. Devolve quantas foram criadas. */
  semear(ids) {
    const agora = Date.now();
    const ins = t => db.prepare(`INSERT INTO ${t} (id, posto, prod, dados, actualizado_em, actualizado_por) VALUES (?, ?, ?, ?, ?, NULL) ON CONFLICT(id) DO NOTHING`);
    const iC = ins('confirmacoes'), iR = ins('registos');
    let n = 0;
    db.exec('BEGIN IMMEDIATE');
    try {
      for (const pid of ids) for (const prod of ['GA', 'GO']) {
        const id = `c-${pid}-${prod}`, pv = /^\d+$/.test(pid) ? Number(pid) : pid;
        const r = iC.run(id, String(pid), prod, JSON.stringify({ id, posto: pv, prod, hora: agora, [prod]: 'venda', momento: 'Estado inicial', inicial: true }), agora);
        if (r.changes) { n++; iR.run(id, String(pid), prod, JSON.stringify({ id, posto: pv, prod, hora: agora, utilizador: 'Estado inicial do portal', conta: null }), agora); }
      }
      db.exec('COMMIT');
    } catch (e) { db.exec('ROLLBACK'); throw e; }
    return n;
  },
  /* as últimas confirmações (no máximo 5) de um posto e combustível, da mais recente para a mais antiga */
  historico(posto, prod) {
    return db.prepare('SELECT prod, estado, hora, momento, utilizador FROM historico WHERE posto = ? AND prod = ? ORDER BY hora DESC, seq DESC LIMIT ?')
      .all(String(posto), prod, HIST_MAX);
  },
  /* confirmações de postos que deixaram de existir na lista (depois de a lista ser substituída) */
  limparOrfaos(ids) {
    const v = new Set(ids.map(String)); let n = 0;
    db.exec('BEGIN IMMEDIATE');
    try {
      for (const t of ['confirmacoes', 'registos'])
        for (const r of db.prepare(`SELECT id, posto FROM ${t}`).all())
          if (!v.has(String(r.posto))) n += db.prepare(`DELETE FROM ${t} WHERE id = ?`).run(r.id).changes;
      for (const r of db.prepare('SELECT DISTINCT posto FROM historico').all())
        if (!v.has(String(r.posto))) n += db.prepare('DELETE FROM historico WHERE posto = ?').run(r.posto).changes;
      db.exec('COMMIT');
    } catch (e) { db.exec('ROLLBACK'); throw e; }
    return n;
  },
  /* verificação de integridade da base e da coerência das confirmações */
  integridade(validos) {
    const prob = [];
    const ic = db.prepare('PRAGMA integrity_check').all().map(r => Object.values(r)[0]);
    if (!(ic.length === 1 && ic[0] === 'ok')) prob.push('integrity_check: ' + ic.join('; '));
    const conf = new Map(this.listar('confirmacoes').map(r => [r.id, r.dados]));
    const reg = new Map(this.listar('registos').map(r => [r.id, r.dados]));
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
    for (const h of db.prepare('SELECT posto, prod, COUNT(*) n FROM historico GROUP BY posto, prod HAVING n > ?').all(HIST_MAX))
      prob.push(`histórico do posto ${h.posto} ${h.prod}: ${h.n} entradas (máximo ${HIST_MAX})`);
    for (const [id, c] of conf) {
      if (c.inicial) continue;
      const m = /^c-(.+)-(GA|GO)$/.exec(id); if (!m) continue;
      const h = db.prepare('SELECT estado, hora FROM historico WHERE posto = ? AND prod = ? ORDER BY hora DESC, seq DESC LIMIT 1').get(m[1], m[2]);
      if (h && (h.hora !== c.hora || h.estado !== c[m[2]])) prob.push(`${id}: a última entrada do histórico não coincide com a confirmação actual`);
    }
    const dup = db.prepare('SELECT posto, prod, COUNT(*) n FROM confirmacoes GROUP BY posto, prod HAVING n > 1').all();
    for (const d of dup) prob.push(`posto ${d.posto} ${d.prod}: ${d.n} confirmações (devia ser 1)`);
    return { ok: prob.length === 0, problemas: prob, confirmacoes: conf.size };
  },
  porId(id) { return db.prepare('SELECT id, utilizador, nome, perfil, posto_id, activo, senha_hash FROM utilizadores WHERE id = ?').get(Number(id)); },
  auditar(accao, { conta = null, utilizador = null, detalhe = null, ip = null } = {}) {
    try {
      const r = db.prepare('INSERT INTO auditoria (hora, accao, conta, utilizador, detalhe, ip) VALUES (?, ?, ?, ?, ?, ?)')
        .run(Date.now(), String(accao).slice(0, 40), conta == null ? null : String(conta), utilizador == null ? null : String(utilizador).slice(0, 80),
          detalhe == null ? null : String(typeof detalhe === 'string' ? detalhe : JSON.stringify(detalhe)).slice(0, 500), ip == null ? null : String(ip).slice(0, 64));
      if (Number(r.lastInsertRowid) % 500 === 0) db.prepare('DELETE FROM auditoria WHERE seq <= ?').run(Number(r.lastInsertRowid) - AUD_MAX);
    } catch (e) { console.error('auditoria:', e.message); }
  },
  auditoria(limite = 200) {
    return db.prepare('SELECT hora, accao, utilizador, detalhe, ip FROM auditoria ORDER BY seq DESC LIMIT ?').all(Math.min(1000, Math.max(1, Number(limite) || 200)));
  },
  porNome(u) { return db.prepare('SELECT id, utilizador, nome, perfil, posto_id, activo FROM utilizadores WHERE utilizador = ?').get(String(u)); },
  existeUtilizador(u) { return !!db.prepare('SELECT 1 FROM utilizadores WHERE utilizador = ?').get(String(u)); },
  mudarSenha(u, hash) { return db.prepare('UPDATE utilizadores SET senha_hash = ? WHERE utilizador = ?').run(hash, String(u)).changes > 0; },
  estadoConta(u, activo) { return db.prepare('UPDATE utilizadores SET activo = ? WHERE utilizador = ?').run(activo ? 1 : 0, String(u)).changes > 0; },
  desactivarUtilizador(utilizador) {
    return db.prepare('UPDATE utilizadores SET activo = 0 WHERE utilizador = ?').run(utilizador).changes;
  },
  contas() {
    return db.prepare('SELECT utilizador, nome, perfil, posto_id, activo FROM utilizadores ORDER BY perfil, utilizador').all();
  },
  /* cópia de segurança consistente, mesmo com o portal ligado */
  copiar(destino) { db.exec(`VACUUM INTO '${String(destino).replace(/'/g, "''")}'`); },
  fechar() { db.close(); },
};
