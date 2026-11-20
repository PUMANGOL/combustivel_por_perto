/* Entrada do portal na Vercel. Todos os pedidos (página, ficheiros e API) chegam aqui pelo vercel.json e passam
   pela mesma aplicação Express do servidor próprio, com os mesmos cabeçalhos de segurança e as mesmas regras.
   Configuração e passos: VERCEL.md. */
'use strict';
module.exports = require('../server');
