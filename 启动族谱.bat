@echo off
chcp 65001 >nul
cd /d "%~dp0"
echo ================================
echo   电子族谱系统 - 启动中...
echo ================================
echo.
start http://localhost:5500/
node server.js
pause