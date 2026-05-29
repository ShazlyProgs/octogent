# ensure-shazly.ps1
# Polls the Octogent API until ready, then idempotently spawns ShazlyAgent
# at the reserved __octoboss__ position (octopus center, no tentacle id).
#
# ShazlyAgent runs in shared workspace mode (vault hooks fire; full vault read access).
# VaultAgent was removed Session 60 — the center ShazlyAgent handles vault context directly.
# Additional specialized tentacles spawn on demand from ShazlyAgent, not preemptively here.
#
# Invoked by start-octogent.bat after the daemon is up.
#
# Exit codes:
#   0 — ShazlyAgent running (just spawned or already existed)
#   1 — API not ready after timeout
#   2 — ShazlyAgent spawn failed

param(
  [int]$ApiPort = 8787,
  [int]$ReadyTimeoutSec = 45,
  [string]$OctogentRoot = $null
)

$ErrorActionPreference = "Stop"

if (-not $OctogentRoot) {
  $OctogentRoot = Split-Path -Parent (Split-Path -Parent $PSCommandPath)
}

$ApiBase = "http://127.0.0.1:$ApiPort"
$SnapshotsUrl = "$ApiBase/api/terminal-snapshots"

function Wait-ForApi {
  Write-Host ""
  Write-Host "  Waiting for Octogent API on $ApiBase ..." -ForegroundColor Cyan
  $deadline = (Get-Date).AddSeconds($ReadyTimeoutSec)
  while ((Get-Date) -lt $deadline) {
    try {
      $resp = Invoke-WebRequest -Uri $SnapshotsUrl -UseBasicParsing -TimeoutSec 2 -ErrorAction Stop
      if ($resp.StatusCode -eq 200) { return $true }
    } catch {
      # Keep polling
    }
    Start-Sleep -Milliseconds 750
  }
  return $false
}

function Get-Terminals {
  try {
    return Invoke-RestMethod -Uri $SnapshotsUrl -UseBasicParsing -TimeoutSec 5
  } catch {
    Write-Host "  ERROR: Failed to read terminal snapshots. $($_.Exception.Message)" -ForegroundColor Red
    return @()
  }
}

function Find-TerminalByTentacleId {
  param($Terminals, $TentacleId)
  return $Terminals | Where-Object { $_.tentacleId -eq $TentacleId } | Select-Object -First 1
}

function Ensure-Tentacle {
  param($TentacleId, $Description)
  Push-Location $OctogentRoot
  try {
    $raw = & node "bin/octogent" tentacle list 2>&1 | Out-String
    if ($raw -notmatch [regex]::Escape($TentacleId)) {
      Write-Host "  Creating '$TentacleId' tentacle ..." -ForegroundColor Cyan
      & node "bin/octogent" tentacle create $TentacleId --description $Description 2>&1 | Out-Null
      if ($LASTEXITCODE -ne 0) {
        Write-Host "  WARN: 'tentacle create $TentacleId' returned $LASTEXITCODE — continuing" -ForegroundColor Yellow
      }
    }
  } finally {
    Pop-Location
  }
}

function Spawn-Terminal {
  param($Name, $TentacleId, $PromptTemplate, $PromptVarsJson, $WorkspaceMode, $ParentTerminalId, $CwdScope)
  Push-Location $OctogentRoot
  try {
    $cliArgs = @(
      "bin/octogent", "terminal", "create",
      "--name", $Name,
      "--prompt-template", $PromptTemplate,
      "--prompt-variables", $PromptVarsJson,
      "--workspace-mode", $WorkspaceMode
    )
    if ($TentacleId) {
      $cliArgs += @("--tentacle-id", $TentacleId)
    }
    if ($ParentTerminalId) {
      $cliArgs += @("--parent-terminal-id", $ParentTerminalId)
    }
    if ($CwdScope) {
      $cliArgs += @("--cwd-scope", $CwdScope)
    }
    $output = & node $cliArgs 2>&1
    if ($LASTEXITCODE -ne 0) {
      Write-Host "  ERROR: terminal create failed ($LASTEXITCODE) for $Name" -ForegroundColor Red
      Write-Host $output -ForegroundColor Red
      return $false
    }
    return $true
  } finally {
    Pop-Location
  }
}

# ---- Step 1: Wait for API ----
if (-not (Wait-ForApi)) {
  Write-Host "  ERROR: Octogent API did not become ready within $ReadyTimeoutSec seconds." -ForegroundColor Red
  exit 1
}
Write-Host "  API ready." -ForegroundColor Green

# ---- Step 2: Ensure ShazlyAgent terminal (at __octoboss__ position, no tentacle-id) ----
# (No tentacle folder for ShazlyAgent — it sits at __octoboss__ which is Octogent's built-in root)
$terms = Get-Terminals
$shazly = Find-TerminalByTentacleId -Terminals $terms -TentacleId "__octoboss__"
if (-not $shazly) {
  Write-Host "  Spawning ShazlyAgent (at __octoboss__ center) ..." -ForegroundColor Cyan
  $shazlyVars = @{ apiPort = $ApiPort } | ConvertTo-Json -Compress
  # Spawn WITHOUT --tentacle-id so it lands at the reserved __octoboss__ position
  $ok = Spawn-Terminal `
    -Name "ShazlyBossAgent" `
    -TentacleId $null `
    -PromptTemplate "shazly-agent-init" `
    -PromptVarsJson $shazlyVars `
    -WorkspaceMode "shared" `
    -CwdScope "vault"
  if (-not $ok) { exit 2 }
  Start-Sleep -Seconds 2
  $terms = Get-Terminals
  $shazly = Find-TerminalByTentacleId -Terminals $terms -TentacleId "__octoboss__"
  if (-not $shazly) {
    Write-Host "  ERROR: ShazlyAgent did not appear at __octoboss__ position after spawn" -ForegroundColor Red
    exit 2
  }
  Write-Host "  ShazlyAgent spawned as $($shazly.terminalId) at __octoboss__" -ForegroundColor Green
} else {
  Write-Host "  ShazlyAgent already running as $($shazly.terminalId) — skipping" -ForegroundColor Yellow
}

# ---- Done ----
Write-Host ""
Write-Host "  ShazlyAgent: $($shazly.terminalId)  [center: __octoboss__]" -ForegroundColor Green
Write-Host ""
Write-Host "  Dashboard: $ApiBase" -ForegroundColor Green
Write-Host "  ShazlyAgent will emit its READY block once Claude Code boots in the terminal." -ForegroundColor Green
exit 0
