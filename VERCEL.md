# Combustível por Perto na Vercel

Este guia publica o portal na **Vercel**, com os dados numa base de dados **Turso**. A Vercel não tem disco onde o portal possa guardar o ficheiro SQLite; a Turso é SQLite na nuvem, por isso o portal usa exactamente as mesmas tabelas e regras.

A instalação num servidor próprio (Linux ou Windows Server, `INSTALAR-SERVIDOR.md`) continua a funcionar como antes, com o ficheiro em `dados/`.

## Como fica montado

| Peça | Na Vercel |
|---|---|
| Página, ficheiros e API | Uma só função, `api/index.js`, que usa o mesmo `server.js` do servidor próprio. O `vercel.json` envia todos os pedidos para ela, por isso os cabeçalhos de segurança (CSP, HSTS…) aplicam-se a tudo. |
| Ficheiros do projecto | Não são publicados: a pasta estática da Vercel só tem um `robots.txt` (criado no build). |
| Dados | Turso, indicada por `TURSO_DATABASE_URL` e pelo token: `TURSO_DATABASE_TURSO_AUTH_TOKEN` (criado pela integração da Vercel; tem prioridade) ou `TURSO_AUTH_TOKEN`. As tabelas são criadas sozinhas no primeiro pedido. |
| Tempo real | Continua por ligação SSE. A Vercel corta as ligações longas, por isso o portal renova-a a cada ~5 minutos (o navegador religa sozinho e recarrega só o que mudou). Uma alteração feita noutra instância chega aos ecrãs em até 5 segundos. |
| Limites de tentativas e de escritas | Guardados na base de dados, para valerem em todas as instâncias. |
| Sessões | Cookie `__Host-sessao`, só por HTTPS. |

## 1. Criar a base de dados Turso

**Opção A (mais simples): pelo Marketplace da Vercel**

1. No projecto da Vercel: **Storage › Create Database › Turso** (ou **Marketplace › Turso**).
2. Escolha uma região na Europa, a mais próxima de Angola entre as da Turso (por exemplo **AWS eu-west-1, Irlanda**).
3. Ligue a base de dados ao projecto (todos os ambientes). A Vercel cria as variáveis `TURSO_DATABASE_URL` e `TURSO_DATABASE_TURSO_AUTH_TOKEN`.
4. O portal usa estas duas tal como estão: **não crie `TURSO_AUTH_TOKEN` à mão** (se já o criou, apague-o; de qualquer forma, o token da integração tem prioridade).

**Opção B: directamente na Turso**

1. Crie a conta em turso.tech e uma base de dados numa região na Europa (por exemplo **aws-eu-west-1**).
2. Copie o URL (`libsql://<nome>-<organização>.turso.io`) e crie um token de acesso (*Create Token*, com leitura e escrita).
3. Guarde os dois valores para o passo 2.

## 2. Variáveis de ambiente na Vercel

Em **Settings › Environment Variables**, para **Production** e **Preview**:

| Variável | Valor |
|---|---|
| `TURSO_DATABASE_URL` | URL da base de dados Turso (`libsql://…`). Com a integração (opção A), já existe. |
| `TURSO_AUTH_TOKEN` | Token da Turso — **só na opção B**. Com a integração, o token já está em `TURSO_DATABASE_TURSO_AUTH_TOKEN`. |
| `JWT_SECRET` | Chave secreta das sessões, nova e só para a Vercel. Gere-a no PC com: `node -e "console.log(require('crypto').randomBytes(48).toString('hex'))"` |

Opcionais: `LIMITE_ESCRITAS_MIN` (predefinição 120) e `SSE_DURACAO_SEG` (predefinição 280; ver «Problemas»).

**Não defina** `COOKIE_SECURE`, `TRUST_PROXY`, `HOST`, `PORT` nem `DADOS_FICHEIRO`: na Vercel o portal já usa os valores certos (HTTPS e o endereço real do visitante).

Se faltar alguma variável obrigatória, o build pára com a lista do que falta.

## 3. Definições do projecto

Em **Settings › Build and Deployment**:

- **Framework Preset**: deixe como está (o `vercel.json` define *Other*). Os campos *Build Command*, *Output Directory* e *Install Command* ficam **sem** *Override*: vêm do `vercel.json`.
- **Root Directory**: vazio (a raiz do repositório).
- **Node.js Version**: 22.x ou 24.x.

Em **Settings › Functions**:

- **Fluid compute**: ligado (é o normal em projectos novos). É o que permite ligações de tempo real até 300 segundos.
- **Function Region**: a região da Vercel junto da base de dados Turso (EUA Leste, `aws-us-east-1`: **Washington, iad1**, a predefinição; Irlanda: **Dublin, dub1**; Frankfurt: **fra1**). Cada pedido fala várias vezes com a base de dados; com as duas na mesma região o portal responde mais depressa.

## 4. Publicar

1. Envie o código para o GitHub (branch `main`). A Vercel publica sozinha a cada envio; também pode usar **Deployments › Redeploy**.
2. No registo do build deve aparecer: `Configuração da Vercel completa`.
3. Abra o endereço do projecto (`https://<projecto>.vercel.app`). A página deve mostrar a rede com todos os postos «Disponível» (estado inicial).

## 5. Criar a primeira conta de administrador

A primeira conta de admin cria-se a partir de um PC com esta pasta e o Node.js 22.13 ou superior, ligado à mesma base de dados Turso. Numa janela do **PowerShell**, na pasta do portal:

```powershell
$env:TURSO_DATABASE_URL = "libsql://<nome>-<organização>.turso.io"
$env:TURSO_AUTH_TOKEN = "<token>"
npm install
node scripts/criar-utilizador.js <utilizador> "<Nome completo>"
```

O programa pede a senha duas vezes (mínimo 10 caracteres) e só funciona enquanto não existir nenhum admin. Na primeira linha mostra a base de dados que está a usar: confirme que começa por `Turso libsql://`.

Na mesma janela, `node scripts/verificar.js` confirma a ligação, as contas e a integridade dos dados.

Depois entre no portal com essa conta e crie as contas de posto e de gestor no separador **Gestão**, como no servidor próprio.

## 6. Domínio combustivel.por.perto.pumangol.co.ao

1. **Settings › Domains › Add**: `combustivel.por.perto.pumangol.co.ao`.
2. A Vercel indica o registo DNS a criar (normalmente um **CNAME** de `combustivel.por.perto` para o valor que a Vercel mostrar). Quem gere o DNS de `pumangol.co.ao` cria-o.
3. O certificado HTTPS é emitido sozinho, e os pedidos `http://` passam para `https://`.

## 7. Cópias de segurança

- A Turso guarda o histórico da base de dados e permite repor um momento anterior (o período depende do plano).
- Para ter também uma cópia vossa, no PowerShell com as duas variáveis do passo 5: `npm run copia`. Grava um ficheiro `.json` com todas as tabelas na pasta `copias/`.

## Problemas

| Sintoma | Causa e solução |
|---|---|
| O build pára com «Faltam variáveis de ambiente» | Defina as variáveis do passo 2 (também para *Preview*, se publicar outros branches) e faça **Redeploy**. |
| Erro de deploy sobre `maxDuration` | O plano não permite 300 segundos (Fluid compute desligado). Ligue o Fluid compute, ou mude `maxDuration` para `60` no `vercel.json` e defina `SSE_DURACAO_SEG=50`. |
| A página abre mas dá «Erro no servidor» | Veja **Logs** no projecto da Vercel. A linha `Turso respondeu HTTP …` mostra a resposta da Turso. Normalmente é o URL ou o token da Turso errado ou expirado. |
| `Turso respondeu HTTP 400` com «Namespace … does not exist» (ou outro texto sobre a base de dados) | O `TURSO_DATABASE_URL` não aponta para uma base de dados que exista: copie de novo o URL da base de dados (no painel da Turso, ou o que a integração da Vercel criou). |
| `Turso respondeu HTTP 401` | Token recusado: crie um token novo para a base de dados (leitura e escrita) e substitua o `TURSO_AUTH_TOKEN`. |
| Mudanças demoram uns segundos a aparecer noutros ecrãs | Normal na Vercel: até 5 segundos quando a alteração foi feita noutra instância. |

## Consumo

Cada ecrã aberto mantém uma ligação de tempo real com a função, renovada a cada ~5 minutos. Com muitos ecrãs abertos todo o dia, acompanhe o consumo em **Usage** na Vercel e na Turso, sobretudo no plano gratuito.

## Testar antes de publicar

Os testes automáticos correm também no modo usado na Vercel (cliente Turso, com uma base temporária local):

```powershell
$env:TESTE_TURSO = "1"
node scripts/teste-integridade.js
node scripts/teste-seguranca.js
Remove-Item Env:TESTE_TURSO
```
