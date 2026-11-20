@echo off
chcp 65001 >nul
title Todo Splitter
cd /d "%~dp0"
node server.js
if errorlevel 1 pause
