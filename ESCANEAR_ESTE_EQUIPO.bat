@echo off
chcp 65001 >nul
title AUDITORIA DE HARDWARE - INVENTARIO DE COMPUTO
color 0C
cls

echo ====================================================================
echo             SISTEMA DE AUDITORIA Y ESCANEO DE HARDWARE
echo ====================================================================
echo.
echo  Iniciando escaneo de componentes, numeros de serie y perifericos...
echo.

powershell.exe -NoProfile -ExecutionPolicy Bypass -File "%~dp0scripts\collector.ps1" %*

echo.
pause
