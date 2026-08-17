@echo off
rem dsh-remote-gate launcher (dsh web + gateway + tunnel)
rem Console starts MINIMIZED (taskbar) - the panel window is the main UI.
rem Click the minimized console for logs; press Enter there to reopen the panel.
rem NOTE: keep this file pure ASCII (cmd parses .bat as GBK).
cd /d %~dp0
where node >nul 2>nul
if errorlevel 1 (
  echo [start] node not found in PATH. Install Node.js 18+ first.
  pause
  exit /b 1
)
start "dsh-remote-gate" /min node start.mjs %*
exit /b 0
