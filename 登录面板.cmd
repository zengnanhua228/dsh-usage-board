@echo off
setlocal
title HotDogAPI one-click login
powershell -NoProfile -STA -ExecutionPolicy Bypass -File "%~dp0scripts\login-panel.ps1" %*
