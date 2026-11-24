@echo off
"%SystemRoot%\System32\WindowsPowerShell\v1.0\powershell.exe" -NoLogo -NoProfile -ExecutionPolicy Bypass -File "%~dp0diagnose.ps1"
set "RC=%ERRORLEVEL%"
echo.
pause
exit /b %RC%
