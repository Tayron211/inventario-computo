@echo off
cd /d "%~dp0"
title INVENTARIO DE COMPUTO
cls

echo ====================================================================
echo             INICIANDO SISTEMA DE INVENTARIO DE COMPUTO
echo ====================================================================
echo.

:: Liberar el puerto 3000 si quedo una instancia previa abierta
for /f "tokens=5" %%a in ('netstat -aon ^| findstr ":3000" ^| findstr "LISTENING"') do (
    taskkill /F /PID %%a >nul 2>&1
)

echo [*] Abriendo panel en tu navegador (http://localhost:3000)...
echo [*] Servidor activo para PC y celulares en la misma red Wi-Fi.
echo.

start "" "http://localhost:3000"
node server.js

pause
