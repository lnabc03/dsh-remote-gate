@echo off
rem dsh-remote-gate launcher (dsh web + gateway + tunnel)
rem Console starts MINIMIZED (taskbar) - the panel window is the main UI.
rem Click the minimized console for logs; press Enter there to reopen the panel.
rem The console hosts node via PowerShell (pwsh preferred, powershell fallback)
rem instead of bare node: PowerShell disables QuickEdit on startup, so clicking
rem the window no longer freezes output and Enter works on the FIRST press.
rem NOTE: keep this file pure ASCII (cmd parses .bat as GBK).
cd /d %~dp0
where node >nul 2>nul
if errorlevel 1 (
  echo [start] node not found in PATH. Install Node.js 18+ first.
  pause
  exit /b 1
)
node -e "process.exit(Number(process.versions.node.split('.')[0])>=18?0:1)"
if errorlevel 1 (
  echo [start] Node.js 18+ required. Please upgrade Node.js and retry.
  pause
  exit /b 1
)
where pwsh >nul 2>nul
if errorlevel 1 (
  start "dsh-remote-gate" /min powershell -Command "node start.mjs %*"
) else (
  start "dsh-remote-gate" /min pwsh -Command "node start.mjs %*"
)
exit /b 0
