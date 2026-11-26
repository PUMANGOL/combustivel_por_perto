@echo off
title Combustivel por Perto - importar perfis de acesso
cd /d "%~dp0"
if not exist node_modules call npm install
echo Importa as contas do ficheiro deploy\perfis-acesso.csv (folha Perfis de Acesso).
echo So cria as contas que ainda nao existem; as existentes nao sao alteradas.
echo Os codigos de primeiro acesso ficam num ficheiro na pasta copias.
echo.
node scripts\importar-perfis.js deploy\perfis-acesso.csv
echo.
pause
