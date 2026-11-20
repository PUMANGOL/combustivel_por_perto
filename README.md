# Combustível por Perto · Pumangol — versão 5.13

Portal onde os clientes vêem em que postos Pumangol há gasolina e gasóleo. Endereço de produção: **https://combustivel.por.perto.pumangol.co.ao**. A instalação no servidor está descrita em **INSTALAR-SERVIDOR.md**.

## O que o cliente vê

- Para cada combustível, só **dois estados**: **✓ Disponibilidade confirmada** (verde) ou **? Disponibilidade por confirmar** (laranja). «Indisponível» nunca é mostrado ao cliente: aparece como «Disponibilidade por confirmar».
- **📍 Usar a minha localização** (recomendado): a província e o município do posto mais próximo ficam preenchidos sozinhos. Também se pode escolher a província e o município à mão.
- **Por defeito, toda a rede começa com gasolina e gasóleo «Disponível»**, até cada posto confirmar. O cliente vê «Disponibilidade confirmada»; só os perfis com conta vêem que se trata do estado inicial.
- O **mapa dos postos da rede**, com atalhos para **Angola, Luanda, Benguela, Huambo e Huíla**: cada província mostra todos os seus postos, do mais próximo ao mais distante.
- A dica do **localizador do VIA**, logo abaixo da escolha do combustível, e no fim da página o **QR Code**.
- No fim da página, por cima do QR Code e em letra pequena, uma **nota** a salvaguardar a Pumangol: a informação é actualizada periodicamente e a disponibilidade deve ser confirmada no momento do abastecimento.
- Loja de Conveniência e outros serviços sempre disponíveis.

## Perfis

| Perfil | Vê | Faz |
|---|---|---|
| **Posto** | Consulta, Posto, Estado da Rede **de toda a rede** e Histórico **do seu posto** | Confirma só o seu posto |
| **Gestor** | Consulta, Posto, Estado da Rede e Histórico de toda a rede | Confirma qualquer posto; **fica gravado o nome do gestor** |
| **Admin** | Tudo, incluindo **Gestão** | Cria contas, altera perfis, repõe senhas, lista de postos e **confirma toda a rede de uma só vez** (Estado da Rede) |

**As contas criam-se uma só vez e mantêm-se nas actualizações do portal.** Só o admin as altera, no separador Gestão. A primeira conta de admin cria-se com **Criar conta de administrador.bat**, que só funciona enquanto não existir nenhum admin.

No **Estado da Rede**, os três estados aparecem com as suas cores: **Disponível** (verde), **Indisponível** (vermelho) e **Por confirmar**.

## Histórico

Novo separador **Histórico**, para todas as contas: escolhe-se o posto e o combustível (**Gasolina** / **Gasóleo**) e vêem-se as **5 últimas confirmações**, com produto, data/hora, nome de quem confirmou, estado e momento. Guardam-se no máximo 5 por posto e combustível; a sexta apaga a mais antiga. Uma conta de **posto** vê só o histórico do seu posto. O cliente não vê o histórico. O estado inicial do portal não conta como confirmação.

## Confirmação no ecrã Posto

Para cada combustível: **Disponível**, **Indisponível** ou **Sem alteração** (por defeito). Momentos:

| Momento | Pode usar-se com |
|---|---|
| Início de turno | Disponível ou Indisponível |
| Reconfirmação | Disponível ou Indisponível |
| Combustível esgotado | só Indisponível |
| Venda retomada | só Disponível |

O portal impede combinações erradas, no ecrã e no servidor. Cada confirmação substitui a anterior desse combustível, é gravada com a hora do servidor e renovada automaticamente a cada 3 horas até nova confirmação.

## Testar num computador (antes do servidor)

Precisa do **Node.js 22.13 ou superior** (versão LTS em nodejs.org).

1. Extraia o ZIP para uma pasta nova, por exemplo `Documentos › Combustivel por Perto`.
2. Dois cliques em **Criar conta de administrador.bat** (da primeira vez, prepara o portal sozinho).
3. Dois cliques em **Ligar portal.bat** e abra **http://localhost:3000**. Entre com a conta de admin.
4. No separador **Gestão**, crie uma conta de **posto** (escolha o posto e a senha) e uma de **gestor**.

## Ficheiros desta pasta

| Ficheiro | Para quê |
|---|---|
| `Criar conta de administrador.bat` | primeira conta de admin |
| `Ligar portal.bat` | liga o portal |
| `Verificar.bat` | confirma a configuração, as contas e a integridade dos dados |
| `Teste de integridade.bat` | teste automático da gravação das confirmações (62 verificações, com dados temporários) |
| `Teste de seguranca.bat` | teste de segurança automático (92 verificações, com dados temporários) |
| `Copia de seguranca.bat` | cópia dos dados para a pasta `copias` |
| `dados/` | contas e confirmações: **não apague** |

O relatório da auditoria de segurança está em **RELATORIO-SEGURANCA.md**. O admin consulta o **registo de auditoria** no separador Gestão.

Em emergência (admin sem senha): `node scripts/repor-senha.js <utilizador>`. Só muda a senha; o perfil fica igual.

## Vindo da versão 4.9

Se copiar a pasta `dados` da versão 4.9 para esta, as contas mantêm-se: as de **gestão** passam a **admin**, as de posto ficam iguais. As confirmações antigas mantêm-se.
