@echo off
setlocal
title Install dsh-usage-board
echo.
echo ============================================================
echo   dsh-usage-board installer
echo   Copies the plugin into your DSH profile and registers it.
echo   Requires: DSH desktop app installed and started once.
echo ============================================================
echo.
powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0scripts\install.ps1" %*
echo.
pause
