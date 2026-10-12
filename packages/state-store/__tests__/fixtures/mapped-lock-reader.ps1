param([string]$TargetPath)
$ErrorActionPreference = 'Stop'
$reader = [System.IO.File]::Open($TargetPath, 'Open', 'Read', [System.IO.FileShare]::ReadWrite -bor [System.IO.FileShare]::Delete)
try {
  $mapping = [System.IO.MemoryMappedFiles.MemoryMappedFile]::CreateFromFile($reader, [NullString]::Value, 0, 'Read', [System.IO.HandleInheritability]::None, $true)
  try {
    $view = $mapping.CreateViewStream(0, $reader.Length, 'Read')
    try {
      $textReader = [System.IO.StreamReader]::new($view)
      $before = $textReader.ReadToEnd()
      [Console]::WriteLine($before)
      [Console]::Out.Flush()
      $null = [Console]::ReadLine()
      $view.Position = 0
      $textReader.DiscardBufferedData()
      [Console]::WriteLine($textReader.ReadToEnd())
      [Console]::Out.Flush()
    } finally { $view.Dispose() }
  } finally { $mapping.Dispose() }
} finally { $reader.Dispose() }
