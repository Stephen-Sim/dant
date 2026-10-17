@echo off
cd /d "%~dp0"
set "DANT_DATA=%~dp0data"
if not exist "src-tauri\target\release\dant.exe" (
  echo Build the desktop app first: scripts\build-desktop.ps1
  pause
  exit /b 1
)
start "" "%~dp0src-tauri\target\release\dant.exe"
