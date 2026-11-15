param([Parameter(Mandatory=$true)][string]$Output,[Parameter(Mandatory=$true)][string]$Executable,[int]$ControllerPid,[int]$Seconds=1920)
$ErrorActionPreference='Stop'
$ProgressPreference='SilentlyContinue'
$Executable=[IO.Path]::GetFullPath($Executable)
$end=[DateTime]::UtcNow.AddSeconds($Seconds)
$encoding=New-Object Text.UTF8Encoding($false)
while([DateTime]::UtcNow -lt $end) {
  if(Test-Path -LiteralPath (Join-Path $Output 'sampler-stop.flag')){break}
  $memory=Get-CimInstance Win32_PerfFormattedData_PerfOS_Memory
  $processes=@(Get-Process CueDeckPdfQA -ErrorAction SilentlyContinue | Where-Object {$_.Id -ne $ControllerPid -and $_.Path -eq $Executable} | Select-Object Id,PrivateMemorySize64,WorkingSet64,CPU)
  $row=@{at=[DateTime]::UtcNow.ToString('o');committed=[double]$memory.CommittedBytes;limit=[double]$memory.CommitLimit;availableMiB=$memory.AvailableMBytes;processes=$processes}
  [IO.File]::AppendAllText((Join-Path $Output 'memory.jsonl'),(($row|ConvertTo-Json -Depth 4 -Compress)+"`n"),$encoding)
  if([double]$memory.CommittedBytes -gt .9*[double]$memory.CommitLimit){
    [IO.File]::WriteAllText((Join-Path $Output 'stop.flag'),'system commit above 90%',$encoding);break
  }
  Start-Sleep -Seconds 5
}
