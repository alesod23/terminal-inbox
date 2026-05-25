$ErrorActionPreference = 'Stop'
$dir = Split-Path -Parent $MyInvocation.MyCommand.Path
$pidFile = Join-Path $dir 'daemon.pid'

if (-not (Test-Path $pidFile)) {
    Write-Host "No PID file. Daemon is not running (or was killed externally)."
    exit 0
}

$pidValue = Get-Content $pidFile -ErrorAction SilentlyContinue
if (-not $pidValue) {
    Remove-Item $pidFile -Force
    Write-Host "Empty PID file removed."
    exit 0
}

$proc = Get-Process -Id $pidValue -ErrorAction SilentlyContinue
if (-not $proc) {
    Remove-Item $pidFile -Force
    Write-Host "PID $pidValue not running. Stale PID file removed."
    exit 0
}

Stop-Process -Id $pidValue -Force
Start-Sleep -Milliseconds 500
Remove-Item $pidFile -Force -ErrorAction SilentlyContinue
Write-Host "Daemon (PID $pidValue) stopped."
