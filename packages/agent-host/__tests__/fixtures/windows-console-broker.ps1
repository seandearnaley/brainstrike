$ErrorActionPreference = 'Stop'
[Console]::InputEncoding = [Text.UTF8Encoding]::new($false)
[Console]::OutputEncoding = [Text.UTF8Encoding]::new($false)
$reporter = [Console]::Out
$control = [Console]::In
$owner = $null
function Report($value) {
  # ASCII JSON escapes also preserve metadata across a console code-page change.
  $reporter.WriteLine(($value | ConvertTo-Json -Compress -Depth 8 -EscapeHandling EscapeNonAscii))
  $reporter.Flush()
}
try {
  Add-Type -Path (Join-Path $PSScriptRoot 'windows-console-process.cs')
  $line = $control.ReadLine()
  if (!$line) { throw 'Missing owned console launch specification' }
  $spec = $line | ConvertFrom-Json
  $owner = [WindowsFixtureConsole]::Launch([string]$spec.executable, [string[]]$spec.arguments, [string]$spec.cwd)
  $brokerProcess = [Diagnostics.Process]::GetCurrentProcess()
  $brokerIdentity = @{pid=$brokerProcess.Id;start=[string]$brokerProcess.StartTime.ToFileTimeUtc();executable=$brokerProcess.MainModule.FileName}
  Report @{event='target-spawn';identity=@{pid=$owner.Pid;start=[string]$owner.Start;executable=$owner.Executable};commandLine=$owner.CommandLine;arguments=$spec.arguments;brokerPid=$PID;brokerIdentity=$brokerIdentity}
  while ($null -ne ($line = $control.ReadLine())) {
    $command = $line | ConvertFrom-Json
    switch ([string]$command.event) {
      'write' { $owner.Write([Text.Encoding]::UTF8.GetString([Convert]::FromBase64String([string]$command.base64))) }
      'end-input' { $owner.EndInput() }
      'interrupt' { $members = $owner.Interrupt(); Report @{event='console-interrupt';members=$members;identity=@{pid=$owner.Pid;start=[string]$owner.Start;executable=$owner.Executable}} }
      'crash' { Report @{event='explicit-crash'}; $owner.Crash() }
      default { throw 'Unknown fixture console control' }
    }
  }
} catch {
  Report @{event='broker-error';message=$_.Exception.Message}
  exit 1
} finally {
  if ($owner) { $owner.Dispose() }
}
