@echo off
setlocal
title Configure HotDogAPI panel token
echo.
echo ============================================================
echo   Enable the money / balance panel (optional)
echo   Reads HotDogAPI panel usage with your panel login token.
echo   Without this, the token usage board still works.
echo ============================================================
echo.
powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0scripts\setup-panel-token.ps1" %*
echo.
pause
