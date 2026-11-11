@echo off
rem ============================================================
rem  XiangYeXingTu launcher (recommended)
rem  Starts a local-only server on 127.0.0.1 so the browser
rem  allows microphone access (voice input), then opens the
rem  app window. Falls back to opening the local file directly
rem  if PowerShell is blocked by policy.
rem  NOTE: ASCII only on purpose - .bat files break on non-ASCII.
rem ============================================================
setlocal
cd /d "%~dp0"

set "PAGE=%~dp0App\index.html"
set "PROFILE=%LOCALAPPDATA%\XiangYeXingTu"

if not exist "%PAGE%" (
  echo [ERROR] App\index.html not found. Please copy the whole folder.
  pause
  exit /b 1
)

where powershell >nul 2>nul
if errorlevel 1 goto fallback

rem pass "demo" as first argument to start with sample data loaded
set "DEMOARG="
if /i "%~1"=="demo" set "DEMOARG=-Demo"

rem start the local server without blocking this window;
rem serve.ps1 opens the app window itself once the port is ready
start "" /min powershell -NoProfile -ExecutionPolicy Bypass -WindowStyle Hidden -File "%~dp0serve.ps1" -Port 0 %DEMOARG%
exit /b 0

:fallback
set "EDGE=C:\Program Files (x86)\Microsoft\Edge\Application\msedge.exe"
if not exist "%EDGE%" set "EDGE=C:\Program Files\Microsoft\Edge\Application\msedge.exe"
set "CHROME=C:\Program Files\Google\Chrome\Application\chrome.exe"
if not exist "%CHROME%" set "CHROME=%LOCALAPPDATA%\Google\Chrome\Application\chrome.exe"

if exist "%EDGE%" (
  start "" "%EDGE%" --app="file:///%PAGE:\=/%" --user-data-dir="%PROFILE%" --window-size=1180,860 --no-first-run
  exit /b 0
)
if exist "%CHROME%" (
  start "" "%CHROME%" --app="file:///%PAGE:\=/%" --user-data-dir="%PROFILE%" --window-size=1180,860 --no-first-run
  exit /b 0
)

start "" "%PAGE%"
