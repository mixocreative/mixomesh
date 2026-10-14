@echo off
rem One-click clean Windows installer build. Flags: --skip-tests  --keep-build  --no-pause
cd /d "%~dp0"
node scripts\build-installer.mjs %*
set RC=%ERRORLEVEL%
rem Pause only when double-clicked (Explorer runs "cmd /c"); scripts and other apps pass --no-pause.
echo %* | "%SystemRoot%\System32\find.exe" /i "--no-pause" >nul && exit /b %RC%
echo %cmdcmdline% | "%SystemRoot%\System32\find.exe" /i "/c" >nul && pause
exit /b %RC%
