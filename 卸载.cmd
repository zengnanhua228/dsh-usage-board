@echo off
setlocal
title Uninstall dsh-usage-board
echo.
echo ============================================================
echo   dsh-usage-board uninstaller
echo   Removes the plugin files and its config line.
echo   Your panel token / API keys are kept untouched.
echo ============================================================
echo.
powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0scripts\uninstall.ps1" %*
echo.
pause
