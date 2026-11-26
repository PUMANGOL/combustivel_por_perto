# Combustível por Perto 6.0 — instalação em https://combustivel.por.perto.pumangol.co.ao

Guia para a equipa de informática da Pumangol. Os ficheiros de configuração estão na pasta `deploy/`. O relatório da auditoria de segurança está em `RELATORIO-SEGURANCA.md`.

## 1. O que é

Portal web público onde os clientes consultam em que postos Pumangol há gasolina e gasóleo. Os postos confirmam o estado dos combustíveis com a sua conta; gestores e administradores acompanham a rede.

```
Clientes (telemóvel, QR Code, VIA)
        │  HTTPS 443  ─  https://combustivel.por.perto.pumangol.co.ao
        ▼
Proxy inverso (Nginx ou IIS) + certificado TLS        ← na mesma máquina
        │  HTTP 127.0.0.1:3000
        ▼
Node.js — server.js (Express)
   └── dados/via-abastece.sqlite   contas, confirmações, histórico (5 por posto/combustível) e auditoria
```

| | |
|---|---|
| Aplicação | Node.js + Express; página única com tempo real (Server-Sent Events, `/api/eventos`) |
| Base de dados | SQLite num ficheiro, através do módulo `node:sqlite` do Node.js: **não exige servidor de base de dados** |
| Dependências externas em funcionamento | nenhuma (não liga a outros sistemas nem a serviços na internet) |
| Dependências npm | express 5, jsonwebtoken 9, bcryptjs, cookie-parser, dotenv: `npm audit` sem vulnerabilidades |
| Perfis | **Posto** (confirma o seu posto), **Gestor** (toda a rede), **Visualizador** (só consulta), **Admin** (contas, perfis, auditoria). O utilizador é o **email**; cada pessoa grava a sua senha no primeiro acesso, com um código pessoal |
| Segurança | CSP estrita, cookie `__Host-` Secure/HttpOnly/SameSite=Strict, bcrypt 12, bloqueio por tentativas, registo de auditoria (ver relatório) |

## 2. Requisitos

| Item | Requisito |
|---|---|
| Servidor | Linux (recomendado: Ubuntu 22.04/24.04) ou Windows Server 2019+ |
| Node.js | **22.13 ou superior**; recomendado a LTS 24 |
| Recursos | 1 vCPU, 512 MB RAM livres, menos de 300 MB de disco |
| Rede de entrada | 80 e 443 no proxy. A porta 3000 **não** deve ficar exposta (o portal escuta só em 127.0.0.1) |
| Rede de saída | só para a instalação (`npm ci`) e para renovar o certificado |
| DNS | registo **A** (e **AAAA**, se houver IPv6) `combustivel.por.perto.pumangol.co.ao` → IP público do servidor |
| Certificado | TLS para `combustivel.por.perto.pumangol.co.ao` (Let's Encrypt ou certificado da Pumangol) |

**HTTPS é obrigatório.** O endereço a divulgar é **https://**combustivel.por.perto.pumangol.co.ao. Os pedidos em `http://` são redireccionados. Sem HTTPS, os telemóveis não dão a localização ao portal, e o cookie de sessão não fica protegido.

## 3. Instalação em Linux (recomendada)

```bash
# 3.1 Node.js 24 LTS e Nginx (exemplo para Ubuntu)
curl -fsSL https://deb.nodesource.com/setup_24.x | sudo -E bash -
sudo apt-get install -y nodejs nginx
node -v                                     # v22.13+ ou v24.x

# 3.2 Utilizador de serviço e pasta
sudo useradd --system --home /opt/combustivel-por-perto --shell /usr/sbin/nologin cpp
sudo mkdir -p /opt/combustivel-por-perto
#     copiar para /opt/combustivel-por-perto o conteúdo da pasta combustivel-por-perto deste pacote
cd /opt/combustivel-por-perto
sudo npm ci --omit=dev
sudo cp deploy/env-producao.exemplo .env
sudo mkdir -p dados copias
sudo chown -R cpp:cpp /opt/combustivel-por-perto
sudo chmod 600 .env && sudo chmod 700 dados copias

# 3.3 Contas: importar a folha «Perfis de Acesso» (113 contas; o utilizador é o email)
sudo -u cpp node scripts/importar-perfis.js deploy/perfis-acesso.csv
#     → cria as contas «à espera do primeiro acesso» e grava os códigos pessoais em copias/codigos-acesso-*.csv (permissões 600)
#     → entregar esse ficheiro, por canal seguro, só ao responsável funcional, e apagá-lo do servidor depois
sudo -u cpp node scripts/verificar.js       # tudo com ✓ (2 admin, 9 gestor, 19 visualizador, 83 posto)

# 3.4 Serviço
sudo cp deploy/combustivel-por-perto.service /etc/systemd/system/
sudo systemctl daemon-reload
sudo systemctl enable --now combustivel-por-perto
curl -s http://127.0.0.1:3000/api/saude      # {"ok":true}

# 3.5 Certificado (Let's Encrypt), com o site por omissão do Nginx a responder na porta 80
#     (o DNS já tem de apontar para este servidor)
sudo apt-get install -y certbot
sudo certbot certonly --webroot -w /var/www/html -d combustivel.por.perto.pumangol.co.ao
#     com certificado da Pumangol: ajustar ssl_certificate / ssl_certificate_key no ficheiro do Nginx

# 3.6 Nginx
sudo cp deploy/nginx-combustivel.por.perto.pumangol.co.ao.conf /etc/nginx/sites-available/combustivel-por-perto
sudo ln -s /etc/nginx/sites-available/combustivel-por-perto /etc/nginx/sites-enabled/
sudo rm -f /etc/nginx/sites-enabled/default
sudo nginx -t && sudo systemctl reload nginx
echo 'deploy-hook = systemctl reload nginx' | sudo tee -a /etc/letsencrypt/cli.ini   # recarregar após renovação

# 3.7 Cópias de segurança diárias
sudo -u cpp crontab deploy/copia-diaria.cron
```

Registos do serviço: `journalctl -u combustivel-por-perto -f`.

## 4. Instalação em Windows Server (alternativa)

1. Instale o **Node.js 24 LTS** (nodejs.org).
2. Copie a pasta `combustivel-por-perto` para, por exemplo, `C:\Servicos\combustivel-por-perto` e, nessa pasta, corra:
   ```
   npm ci --omit=dev
   copy deploy\env-producao.exemplo .env
   node scripts\importar-perfis.js deploy\perfis-acesso.csv
   node scripts\verificar.js
   ```
   Restrinja as permissões NTFS de `.env`, `dados` e `copias` à conta do serviço e aos administradores.
3. **Serviço** com o [NSSM](https://nssm.cc):
   ```
   nssm install CombustivelPorPerto "C:\Program Files\nodejs\node.exe" server.js
   nssm set CombustivelPorPerto AppDirectory C:\Servicos\combustivel-por-perto
   nssm start CombustivelPorPerto
   ```
4. **IIS:** instale **URL Rewrite** e **Application Request Routing**. Crie o site `combustivel.por.perto.pumangol.co.ao` com a ligação HTTPS e o certificado, e use `deploy\iis-web.config` como `web.config`. No ARR, ao nível do servidor:
   - activar o proxy;
   - *Response buffer threshold* = 0 e *Time-out* = 3600 s (tempo real);
   - preservar o IP do cliente no cabeçalho `X-Forwarded-For`.
5. **Cópias:** no Agendador de Tarefas, uma tarefa diária com `node.exe`, os argumentos `scripts\copia-seguranca.js` e «Iniciar em» a pasta do portal.

Os ficheiros `.bat` servem para uso manual. Em produção, o portal corre como serviço.

## 5. Verificação depois de instalado

1. **https://combustivel.por.perto.pumangol.co.ao** abre o portal com «v6.0» no topo.
2. Cabeçalhos de segurança: `curl -sI https://combustivel.por.perto.pumangol.co.ao | grep -iE 'content-security|strict-transport|x-frame'` mostra os três.
3. `http://combustivel.por.perto.pumangol.co.ao` redirecciona para `https://`.
4. O responsável funcional entra em **Entrar › Primeiro acesso** com o seu email e o seu código, e grava a sua senha. Cada colaborador e cada posto faz o mesmo com o código que lhe for entregue. Novas contas criam-se em **Gestão › Criar conta** (o portal gera o código).
5. Num telemóvel: «📍 Usar a minha localização» pede autorização e mostra os postos mais próximos.
6. Testes automáticos (usam dados temporários e as portas 3997 a 3999, só em 127.0.0.1; não tocam nos dados reais):
   ```
   sudo -u cpp node scripts/teste-seguranca.js     # 115 verificações
   sudo -u cpp node scripts/teste-integridade.js   # 62 verificações
   ```

**Ligações a divulgar:**
- portal: `https://combustivel.por.perto.pumangol.co.ao/`
- ficha de um posto: `https://combustivel.por.perto.pumangol.co.ao/#p-<código>`, por exemplo `#p-9` para o Talatona

O QR Code do portal usa automaticamente este endereço.

## 6. Operação

| Tarefa | Como |
|---|---|
| Estado do serviço | `GET /api/saude` → `{"ok":true}` |
| Contas, perfis, códigos de acesso | no portal, pelo admin: **Gestão** (senha esquecida: «Repor acesso (novo código)») |
| Registo de auditoria | no portal, pelo admin: **Gestão › Registo de auditoria** |
| Admin sem senha (emergência) | `node scripts/repor-senha.js <utilizador>` (só muda a senha; fica registado na auditoria) |
| Cópia manual | `node scripts/copia-seguranca.js` (pode ser com o serviço ligado) → `copias/` |
| Repor uma cópia | parar o serviço, substituir `dados/via-abastece.sqlite` pela cópia, arrancar |
| Actualizar o portal | parar o serviço, substituir os ficheiros **mantendo `.env`, `dados/` e `copias/`**, `npm ci --omit=dev`, arrancar. As contas e os perfis criados nunca são alterados por uma actualização |
| Terminar todas as sessões | mudar `JWT_SECRET` no `.env` e reiniciar |

**Cópias de segurança:** incluam `dados/` (ou `copias/`) na política de backup do servidor. É o único sítio onde ficam as contas, as confirmações e a auditoria, e contém hashes de senhas: guardar com acesso restrito.

## 7. Notas de segurança para a equipa de IT

Ver `RELATORIO-SEGURANCA.md`, secção 5, em especial:
- manter `COOKIE_SECURE=true`, `HOST=127.0.0.1` e o proxy na mesma máquina (`TRUST_PROXY=loopback`);
- disco cifrado e cópias com acesso restrito;
- `npm audit` periódico;
- considerar um teste de intrusão independente antes da abertura ao público, e autenticação de dois factores ou acesso só pela rede interna para o separador Gestão.

## 8. Contacto funcional

Responsável pelo portal: Rufino Chipongue — _(contacto)_
