@echo off
REM ================================================================
REM  Octogent — Collega Orchestration multi-tentacle dashboard
REM  Double-click anytime. Idempotent: if already running, just opens
REM  the browser + ensures Shazly and ShazlyAgent are spawned;
REM  otherwise starts a fresh instance and auto-spawns both.
REM
REM  Hierarchy:  Shazly (framework) -> ShazlyAgent (vault brain)
REM ================================================================
title Octogent (Collega Orchestration)

REM Path to the PowerShell helper that polls + spawns both agents
set "AGENT_HELPER=%~dp0scripts\ensure-shazly.ps1"

REM Jump to VS Code Repos/ (octogent's project root)
cd /d "%~dp0\..\.."

REM ---- Quick port check: is Octogent already running on :8787? ----
powershell -NoProfile -ExecutionPolicy Bypass -Command "$running=$false; try { $c=New-Object System.Net.Sockets.TcpClient; $r=$c.BeginConnect('127.0.0.1',8787,$null,$null); if($r.AsyncWaitHandle.WaitOne(300)){$c.EndConnect($r); $c.Close(); $running=$true} else {$c.Close()} } catch {}; if($running){ exit 0 } else { exit 1 }"

if %ERRORLEVEL%==0 (
    REM Already running — open browser, ensure agents exist, exit
    echo.
    echo   Octogent already running. Opening dashboard...
    echo   URL: http://127.0.0.1:8787
    start "" "http://127.0.0.1:8787"

    echo.
    echo   Ensuring Shazly + ShazlyAgent are spawned...
    powershell -NoProfile -ExecutionPolicy Bypass -File "%AGENT_HELPER%"
    exit /b 0
)

REM ---- Not running: start fresh and launch agent helper in parallel ----
echo.
echo ==============================================================
echo   Starting Octogent + auto-spawning Shazly and ShazlyAgent
echo   Project:   %CD%
echo   Dashboard: http://127.0.0.1:8787
echo.
echo   Hierarchy: Shazly (framework) - ShazlyAgent (vault brain)
echo.
echo   Expected (harmless) warning: "codex is not installed".
echo   We use Claude Code, not Codex. Ignore it.
echo.
echo   Both agents will auto-spawn once the API is ready (~5-10s).
echo ==============================================================
echo.

REM Launch the agent helper in a minimized background window. It polls the
REM API until ready, then spawns Shazly and ShazlyAgent idempotently.
start "Agent Spawner" /MIN powershell -NoProfile -ExecutionPolicy Bypass -File "%AGENT_HELPER%"

REM Now run octogent in the foreground — using the LOCAL freshly-built binary
REM (not the globally-installed npm copy, which is stale). It auto-opens the
REM browser on first start. The helper runs in parallel and attaches when ready.
node "%~dp0bin\octogent"

echo.
echo ==============================================================
echo   Octogent has stopped. Press any key to close this window.
echo ==============================================================
pause >nul
