@echo off
chcp 65001 >nul
title Todo Splitter - stop
echo.
powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0stop.ps1"
echo.
rem timeout @ …%t ÉŒ X½Ð ý”ä. ping <\  P H˜ä.
ping -n 3 127.0.0.1 >nul
