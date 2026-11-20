@echo off
title Combustivel por Perto - portal
cd /d "%~dp0"
if not exist node_modules (
  echo A preparar o portal pela primeira vez...
  call npm install
)
echo.
echo Depois de aparecer "a correr", abra o navegador em:  http://localhost:3000
echo.
node server.js
echo.
echo O portal parou. Leia a mensagem acima.
pause
