param([Parameter(Mandatory)][int]$OwnedPid, [Parameter(Mandatory)][long]$ExpectedStart)
$ErrorActionPreference = 'Stop'
$instance = $null
try {
  try {
    $instance = [Diagnostics.Process]::GetProcessById($OwnedPid)
  } catch [ArgumentException] {
    @{event='owner-already-gone';pid=$OwnedPid;start=[string]$ExpectedStart} | ConvertTo-Json -Compress
    exit 0
  }
  try {
    # GetProcessById associates only a PID. SafeHandle pins the process before
    # StartTime and WaitForExit; .NET reuses that retained handle for both.
    # https://github.com/dotnet/runtime/blob/v10.0.11/src/libraries/System.Diagnostics.Process/src/System/Diagnostics/Process.Windows.cs
    $handle = $instance.SafeHandle
  } catch [InvalidOperationException] {
    $failure = $_.Exception
    while ($failure -isnot [InvalidOperationException] -and $failure.InnerException) {
      $failure = $failure.InnerException
    }
    # Preserve query/access failures; only the open's plain exited-process
    # exception is absence evidence, not an underlying Win32 query failure.
    if ($failure -isnot [InvalidOperationException] -or $failure.InnerException) { throw }
    # The initial open can observe exit after PID lookup. No verified join is
    # claimed and no replacement process is waited upon.
    @{event='owner-gone-during-open';pid=$OwnedPid;start=[string]$ExpectedStart} | ConvertTo-Json -Compress
    exit 0
  }
  if ($handle.IsInvalid -or $handle.IsClosed) {
    throw 'Cannot pin the fixture owner process handle'
  }
  $actual = $instance.StartTime.ToUniversalTime().ToFileTimeUtc()
  if ($actual -ne $ExpectedStart) {
    @{event='owner-identity-gone';pid=$OwnedPid;start=[string]$ExpectedStart;reusedStart=[string]$actual} | ConvertTo-Json -Compress
    exit 0
  }
  @{event='owner-handle-verified';pid=$OwnedPid;start=[string]$actual} | ConvertTo-Json -Compress
  # Keep the pinned handle alive until wait completes. No signal, kill, retry or new
  # deadline is introduced; the existing enclosing fixture owns cancellation.
  $instance.WaitForExit()
  @{event='owner-physically-joined';pid=$OwnedPid;start=[string]$ExpectedStart;exitCode=$instance.ExitCode} | ConvertTo-Json -Compress
} finally {
  if ($instance) { $instance.Dispose() }
}
