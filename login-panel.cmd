@echo off
setlocal
title HotDogAPI one-click login
echo.
echo Opening login window...
powershell -NoProfile -STA -ExecutionPolicy Bypass -File "%~dp0scripts\login-panel.ps1" %*
