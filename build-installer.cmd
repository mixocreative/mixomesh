@echo off
rem One-click clean Windows installer build. Flags: --skip-tests  --keep-build
cd /d "%~dp0"
node scripts\build-installer.mjs %*
set RC=%ERRORLEVEL%
echo %cmdcmdline% | find /i "/c" >nul && pause
exit /b %RC%
