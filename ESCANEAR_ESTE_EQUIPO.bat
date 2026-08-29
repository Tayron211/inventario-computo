@echo off
chcp 65001 >nul
title SYS-INVENTORY - AUDITORIA DE HARDWARE
color 0C

:: ====================================================================
:: AUTO-ELEVACION AUTOMATICA A PERMISOS DE ADMINISTRADOR POR DEFECTO
:: ====================================================================
net session >nul 2>&1
if %errorlevel% neq 0 (
    echo [*] Solicitando permisos de Administrador para auditar BIOS y Hardware...
    powershell -Command "Start-Process '%~f0' -Verb RunAs"
    exit /b
)

cd /d "%~dp0"
cls

echo ====================================================================
echo             SYS-INVENTORY - AUDITORIA TOTAL DE HARDWARE
echo ====================================================================
echo.
echo [*] Permisos de Administrador: [OK - CONCEDIDOS]
echo [*] Extrayendo BIOS, Motherboard, CPU, RAM, Discos y Perifericos...
echo.

powershell.exe -NoProfile -ExecutionPolicy Bypass -File "%~dp0scripts\collector.ps1" %*

echo.
echo ====================================================================
echo  [OK] Escaneo completado. Los datos se guardaron en el inventario.
echo ====================================================================
echo.
timeout /t 5 >nul
