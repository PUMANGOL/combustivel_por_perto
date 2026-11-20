@echo off
title Combustivel por Perto - teste de seguranca
cd /d "%~dp0"
if not exist node_modules call npm install
echo Teste de seguranca (auditoria tecnica). Usa dados temporarios: os seus dados nao sao tocados.
echo Demora cerca de um minuto.
echo.
node scripts\teste-seguranca.js
echo.
pause
