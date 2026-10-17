@echo off
cd /d "%~dp0"
if not exist node_modules call npm.cmd ci
if errorlevel 1 exit /b %errorlevel%
if not exist dist call npm.cmd run build
if errorlevel 1 exit /b %errorlevel%
start "" http://127.0.0.1:4317
node src/server.mjs
