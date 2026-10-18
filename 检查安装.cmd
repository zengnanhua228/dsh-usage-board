@echo off
setlocal
title Check dsh-usage-board install
echo.
powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0scripts\verify.ps1" %*
echo.
pause
