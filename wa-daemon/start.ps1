$ErrorActionPreference = 'Stop'
$dir = Split-Path -Parent $MyInvocation.MyCommand.Path
$pidFile = Join-Path $dir 'daemon.pid'
$logFile = Join-Path $dir 'daemon.log'

if (Test-Path $pidFile) {
    $existing = Get-Content $pidFile -ErrorAction SilentlyContinue
    if ($existing -and (Get-Process -Id $existing -ErrorAction SilentlyContinue)) {
        Write-Host "Daemon already running (PID $existing). Use stop.ps1 first."
        exit 1
    }
    Remove-Item $pidFile -Force
}

$proc = Start-Process -FilePath 'node' -ArgumentList "$dir\daemon.js" `
    -RedirectStandardOutput $logFile `
    -RedirectStandardError "$logFile.err" `
    -WindowStyle Hidden -PassThru

Start-Sleep -Milliseconds 800
if (Get-Process -Id $proc.Id -ErrorAction SilentlyContinue) {
    Write-Host "Daemon started (PID $($proc.Id))."
    Write-Host "Log: $logFile"

    # Spawn keep-awake watcher so Windows won't idle-sleep while the daemon runs.
    # The watcher self-terminates when the daemon PID dies (manual stop, crash, watchdog cycle).
    $keepAwake = Join-Path $dir 'keep-awake.ps1'
    if (Test-Path $keepAwake) {
        Start-Process -FilePath 'powershell.exe' `
            -ArgumentList '-NoProfile','-ExecutionPolicy','Bypass','-WindowStyle','Hidden','-File',$keepAwake,'-DaemonPid',$proc.Id `
            -WindowStyle Hidden | Out-Null
        Write-Host "Keep-awake watcher spawned (watching PID $($proc.Id))."
    } else {
        Write-Host "Warning: keep-awake.ps1 not found - Windows may idle-sleep and drop msgs."
    }
} else {
    Write-Host "Daemon failed to start. Check $logFile and $logFile.err"
    exit 1
}
