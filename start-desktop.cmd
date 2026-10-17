@echo off
setlocal
cd /d "%~dp0"
rem Use the same profile as the installed app; offer the old checkout as an import source.
if not defined DANT_DATA set "DANT_DATA=%APPDATA%\com.dant.desktop\data"
set "DANT_VM_PROFILE_DIR=%~dp0data"
if not exist "src-tauri\target\release\dant.exe" (
  echo Build the desktop app first: scripts\build-desktop.ps1
  pause
  exit /b 1
)
start "" "%~dp0src-tauri\target\release\dant.exe"
