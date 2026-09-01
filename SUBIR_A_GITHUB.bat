@echo off
cd /d "%~dp0"
title SUBIR INVENTARIO A GITHUB
cls

echo ====================================================================
echo             SUBIENDO PROYECTO A GITHUB (Render Auto-Deploy)
echo ====================================================================
echo.
echo [*] Guardando cambios y preparando actualizacion...
git add .
git commit -m "Actualizacion de UI/UX, conteo de laptops y correcciones de diseno"

echo.
echo [*] Enviando cambios a GitHub (origin main)...
git branch -M main
git push origin main

echo.
echo ====================================================================
echo  [OK] Proyecto subido exitosamente a GitHub!
echo  Render detectara los cambios y actualizara tu web en 1-2 minutos.
echo ====================================================================
pause
