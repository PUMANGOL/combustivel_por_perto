@echo off
title Combustivel por Perto - criar conta de administrador
cd /d "%~dp0"
if not exist node_modules (
  echo A preparar o portal pela primeira vez...
  call npm install
)
echo.
echo Cria a PRIMEIRA conta de administrador. So funciona se ainda nao existir nenhum admin.
echo Normalmente nao e preciso: use antes Importar perfis de acesso.bat.
echo As outras contas (postos, gestores, outros admins) criam-se no portal, no separador Gestao.
echo.
set /p U=Email (e o utilizador para entrar) - por exemplo rufino.chipongue@pumangol.co.ao: 
set /p N=Nome completo: 
echo.
echo A seguir o programa pede a SENHA duas vezes. As letras nao aparecem enquanto escreve.
node scripts\criar-utilizador.js "%U%" "%N%"
echo.
pause
