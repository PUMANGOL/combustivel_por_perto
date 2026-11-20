@echo off
title Combustivel por Perto - verificar
cd /d "%~dp0"
if not exist node_modules call npm install
node scripts\verificar.js
echo.
pause
