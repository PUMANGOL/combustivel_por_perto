@echo off
title Combustivel por Perto - teste de integridade
cd /d "%~dp0"
if not exist node_modules call npm install
echo Teste de consistencia e integridade das confirmacoes.
echo Usa um ficheiro de dados temporario: os seus dados nao sao tocados.
echo.
node scripts\teste-integridade.js
echo.
pause
