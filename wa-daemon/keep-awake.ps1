param(
    [Parameter(Mandatory=$true)]
    [int]$DaemonPid
)

$ErrorActionPreference = 'Stop'
$dir = Split-Path -Parent $MyInvocation.MyCommand.Path
$logFile = Join-Path $dir 'keep-awake.log'

function Log($msg) {
    $line = "[$([DateTime]::UtcNow.ToString('o'))] [pid=$pid daemon=$DaemonPid] $msg"
    try { $line | Out-File -FilePath $logFile -Append -Encoding utf8 } catch {}
}

Add-Type -TypeDefinition @'
using System;
using System.Runtime.InteropServices;
public class PowerMgmt {
    [DllImport("kernel32.dll", CharSet = CharSet.Auto, SetLastError = true)]
    public static extern uint SetThreadExecutionState(uint esFlags);
}
'@

# ES_CONTINUOUS       = 0x80000000 = 2147483648  (apply state until further notice)
# ES_SYSTEM_REQUIRED  = 0x00000001 =          1  (keep system awake)
# ES_AWAYMODE_REQUIRED= 0x00000040 =         64  (allow display sleep, system stays up)
$flagOn  = [uint32]2147483713   # ES_CONTINUOUS | ES_SYSTEM_REQUIRED | ES_AWAYMODE_REQUIRED
$flagOff = [uint32]2147483648   # ES_CONTINUOUS alone clears prior flags

# Sanity-check the daemon is actually alive before grabbing the power lock
if (-not (Get-Process -Id $DaemonPid -ErrorAction SilentlyContinue)) {
    Log "daemon PID $DaemonPid is already dead at startup; exiting without grabbing lock"
    exit 0
}

$prev = [PowerMgmt]::SetThreadExecutionState($flagOn)
Log "acquired sleep block (prev state was $prev)"

try {
    while ($true) {
        if (-not (Get-Process -Id $DaemonPid -ErrorAction SilentlyContinue)) {
            Log "daemon PID $DaemonPid is dead; releasing sleep block"
            break
        }
        Start-Sleep -Seconds 30
    }
} finally {
    [PowerMgmt]::SetThreadExecutionState($flagOff) | Out-Null
    Log "released sleep block; exiting cleanly"
}
