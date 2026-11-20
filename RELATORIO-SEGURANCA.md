# Combustível por Perto 5.13 — Relatório de auditoria e cibersegurança

**Data:** 20/11/2026 · **Auditoria inicial:** versão 5.6, corrigida para 5.7 · **Reauditoria:** versão **5.13** (a enviar à equipa de IT)
**Âmbito:** servidor Node.js (`server.js`, `armazem.js`, `postos.js`), página web (`public/index.html`), scripts de administração, dependências e configuração.

## 1. Resumo

| Resultado | |
|---|---|
| Dependências (`npm audit`) | **0 vulnerabilidades** (express 5.3, jsonwebtoken 9.0, bcryptjs 2.4, cookie-parser 1.4, dotenv 16) |
| Teste de segurança automático | **92 de 92** verificações passaram |
| Teste de integridade das confirmações | **62 de 62** verificações passaram |
| Teste no navegador (XSS e CSP) | nenhum código injectado executou; nenhuma violação de CSP; mapa e QR Code funcionam com a CSP activa |
| Constatações corrigidas na auditoria inicial | **17** (nenhuma crítica; 6 de risco médio, 11 de risco baixo) |
| Reauditoria da 5.13 | sem constatações novas (ver secção 3-A) |
| Vulnerabilidades abertas conhecidas | **nenhuma** |

## 2. Método

1. **Revisão de código** de todas as rotas da API, da gestão de sessões, do controlo de acessos, da validação de dados e da página web.
2. **Testes automáticos** (`scripts/teste-seguranca.js`): cabeçalhos HTTP, exposição de ficheiros, sessões e cookies, falsificação de sessões, CSRF, matriz de acessos por perfil, injecção SQL e HTML, limites de tamanho, força bruta, enumeração de contas, ligações de tempo real, armazenamento de senhas, registo de auditoria e configuração HTTPS.
3. **Teste no navegador**: dados maliciosos gravados directamente na base, ou seja, sem passar pelas validações do servidor (`<img onerror>`, `<script>`) em nomes de contas, responsáveis, momentos, postos e auditoria. Percorreram-se todos os ecrãs, à procura de execução de código e de violações da CSP.
4. **Análise de dependências** com `npm audit`.

## 3. Constatações e correcções

| # | Constatação | Risco | Correcção na 5.7 |
|---|---|---|---|
| S1 | Sem Content-Security-Policy | Médio | CSP estrita: só recursos do próprio portal; o script da página é autorizado pelo seu hash SHA-256; sem `unsafe-inline` nem `unsafe-eval` nos scripts; `object-src 'none'`, `base-uri 'none'`, `frame-ancestors 'self'` |
| S2 | Mudar ou repor uma senha não terminava as sessões abertas | Médio | A sessão leva uma «versão» da senha: ao mudá-la, todas as sessões dessa conta terminam; quem mudou a própria senha recebe uma sessão nova |
| S3 | Força bruta limitada só por IP; contava entradas bem-sucedidas; memória sem limpeza | Médio | Bloqueio de 15 min após **5 senhas erradas por conta** ou **20 por IP**; só contam as falhas; limpeza periódica |
| S4 | Sem limite de ligações de tempo real (negação de serviço) | Médio | Máximo de 50 ligações por visitante e 5000 no total |
| S5 | Sem registo de auditoria das acções administrativas | Médio | Novo **registo de auditoria** (entradas, falhas, bloqueios, saídas, contas, perfis, senhas, confirmação da rede, alterações de dados, acções na consola), visível só ao admin; não se apaga pelo portal |
| S6 | Atrás do túnel ou do proxy, todos os visitantes pareciam ter o mesmo IP (os limites bloqueariam toda a gente) | Médio | `TRUST_PROXY=loopback`: confia no endereço do visitante só quando o proxy está na própria máquina; um cliente remoto não o consegue falsificar |
| S7 | Tempo de resposta revelava se uma conta existia | Baixo | Verificação contra um hash falso quando a conta não existe |
| S8 | Algoritmo da sessão (JWT) não fixado | Baixo | HS256 fixo na assinatura e na verificação (recusa `none` e outros) |
| S9 | Página carregava fontes do Google (privacidade e dependência externa) | Baixo | Removido; o portal usa as fontes do sistema |
| S10 | Atributo `onclick` na página | Baixo | Substituído por um gestor de eventos |
| S11 | Gravações do admin (lista de postos, configuração) sem validação; colecções antigas com escrita | Baixo | Validação estrita (campos permitidos, tamanhos, sem `<` `>`, coordenadas dentro de Angola); colecções antigas só de leitura |
| S12 | Nomes com HTML aceites (já eram mostrados de forma segura) | Baixo | Recusados no servidor, como defesa adicional |
| S13 | Senhas com mais de 72 bytes eram truncadas pelo bcrypt | Baixo | Limite de 10 a 72 caracteres |
| S14 | JSON mal formado devolvia erro 500 | Baixo | 400 ou 413, sem pormenores internos; rotas inexistentes da API devolvem 404 em JSON |
| S15 | Cookie sem prefixo `__Host-`; sem HSTS no servidor | Baixo | Em HTTPS: cookie `__Host-sessao` com `Secure`, e `Strict-Transport-Security` |
| S16 | Respostas da API podiam ficar em cache | Baixo | `Cache-Control: no-store` em toda a API |
| S17 | Sem limite geral de escritas | Baixo | 120 escritas por minuto por visitante (configurável: `LIMITE_ESCRITAS_MIN`) |

## 3-A. Reauditoria da versão 5.13

Entre a 5.7 e a 5.13, as alterações foram só na página de consulta:
- novos textos de abertura;
- nota de salvaguarda (discreta, por cima do QR Code) e caixas de dicas por cima de «Onde há combustível?»;
- caixas de dicas;
- mapa com Luanda, Benguela, Huambo e Huíla;
- QR Code no fim da página;
- «Loja de Conveniência»;
- remoção das designações COCO e COFO.

| Verificação | Resultado |
|---|---|
| Revisão do código alterado | os textos novos são fixos; os nomes de províncias e postos continuam a ser escapados; sem `eval`, sem atributos de evento em linha, sem recursos externos |
| `npm audit` | 0 vulnerabilidades |
| Teste de segurança automático | 92 de 92 |
| Teste de integridade | 62 de 62 |
| Teste no navegador com dados maliciosos (incluindo a nova pesquisa por província do mapa) | nenhum código executou; nenhuma violação de CSP |

**Manutenção:** existem versões principais mais recentes de `bcryptjs` (3.x) e de `dotenv` (18.x), sem vulnerabilidades conhecidas nas versões usadas. Actualizar numa manutenção futura, testando antes.

## 4. Controlos verificados

- **Sessões:** cookie `HttpOnly`, `SameSite=Strict` e `Secure` com `__Host-` em HTTPS, válido 12 h. Sessões alteradas, assinadas com outra chave, expiradas ou com `alg: none` são recusadas. Uma conta desactivada ou com o perfil alterado perde a sessão de imediato.
- **CSRF:** todas as escritas exigem um cabeçalho próprio do portal e cookie `SameSite=Strict`; pedidos de formulário são recusados.
- **Controlo de acessos:** 16 combinações de perfil e rota testadas: cliente, posto, gestor e admin só acedem ao que lhes cabe. As confirmações só se escrevem pela rota própria, com validação, nem mesmo pelo admin por outra via.
- **Injecção:** consultas SQL sempre parametrizadas; identificadores validados por expressão regular; nomes de tabelas de uma lista fechada. Tentativas de injecção SQL recusadas, e a base continua íntegra (`integrity_check`).
- **XSS:** todo o texto vindo de dados é escapado antes de ser mostrado. A CSP impede a execução de código, mesmo que um dia algo escape a essa protecção.
- **Ficheiros:** só a pasta `public/` é servida. `.env`, `dados/`, código do servidor, `package.json` e `node_modules` não se descarregam, incluindo tentativas com `../` codificado.
- **Senhas:** bcrypt com custo 12; nunca guardadas nem registadas em texto; ausentes das sessões, da lista de contas e do registo de auditoria.
- **Informação ao cliente:** o cliente nunca recebe «Indisponível» nem os nomes de quem confirmou; o histórico e a auditoria exigem conta.

## 5. Riscos residuais e recomendações para a equipa de IT

1. **HTTPS obrigatório em produção**, com `COOKIE_SECURE=true`. Sem ele, os telemóveis não dão a localização e o cookie não tem `Secure`.
2. **Proteger o ficheiro `.env`** (permissões 600), que contém a chave das sessões. Mudar `JWT_SECRET` termina todas as sessões.
3. **Base de dados e cópias:** o SQLite não está cifrado. Recomenda-se disco cifrado no servidor e cópias de segurança guardadas com acesso restrito: contêm hashes de senhas, nomes e o registo de auditoria.
4. **Limites em memória:** os contadores de tentativas e de ligações reiniciam quando o serviço reinicia. Para protecção adicional, pode aplicar-se limitação de pedidos também no Nginx ou IIS.
5. **Autenticação de dois factores** para o admin não está implementada. Recomenda-se para uma fase seguinte, ou acesso ao separador Gestão só a partir da rede interna.
6. **Retenção:** por requisito funcional, o histórico de confirmações guarda só as 5 últimas por posto e combustível. O registo de auditoria guarda as 20 000 acções mais recentes. Se a política da Pumangol exigir mais, ajusta-se.
7. **Endereço temporário da Cloudflare** (trycloudflare.com): só para testes. Em produção, usar o domínio da Pumangol.
8. **Actualizações:** correr `npm audit` periodicamente e aplicar as versões corrigidas das dependências.
9. **Senha da base `pumangolprd`:** foi partilhada durante o desenvolvimento das versões anteriores. Esta versão já não usa essa base, mas a senha deve ser alterada, se ainda não o foi.
10. **Integridade da informação ao cliente:** por decisão funcional, no arranque toda a rede aparece com «Disponibilidade confirmada». Recomenda-se que os postos façam a primeira confirmação logo no início; o cartão «Postos que não confirmaram manualmente» mostra quais faltam.

## 6. Como repetir os testes

```
node scripts/teste-seguranca.js      (ou dois cliques em «Teste de seguranca.bat»)
node scripts/teste-integridade.js    (ou «Teste de integridade.bat»)
npm audit --omit=dev
```

Os testes usam ficheiros de dados temporários e portas próprias (3997, 3998 e 3999); não tocam nos dados reais.
