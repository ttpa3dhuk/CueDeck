param(
  [ValidateSet('inspect','start','monitor','cleanup')][string]$Action='inspect',
  [string]$Root=(Join-Path $env:USERPROFILE 'CueDeck-Product-PDF-QA-20261114'),
  [string]$DisabledTaskToVerify='',
  [string]$Case='shared93'
)
$ErrorActionPreference='Stop'
[Console]::OutputEncoding=New-Object Text.UTF8Encoding($false)
$installed='C:\Program Files\CueDeck'
$task='CueDeck-Product-PDF-QA-20261114'
$runtime=Join-Path $Root 'runtime'
$exe=Join-Path $runtime 'CueDeckPdfQA.exe'
$output=Join-Path $Root $Case
function Status {
  $memory=Get-CimInstance Win32_PerfFormattedData_PerfOS_Memory
  @{
    at=[DateTime]::UtcNow.ToString('o')
    memory=@{committed=[double]$memory.CommittedBytes;limit=[double]$memory.CommitLimit;availableMiB=$memory.AvailableMBytes}
    processes=@(Get-Process CueDeckPdfQA -ErrorAction SilentlyContinue | Select-Object Id,Path,PrivateMemorySize64,WorkingSet64)
    installedProcesses=@(Get-Process CueDeck -ErrorAction SilentlyContinue | Select-Object Id,Path)
    services=@(Get-Service sshd,SunshineService | Select-Object Name,@{n='Status';e={$_.Status.ToString()}})
    backgroundTaskEnabled=$(if($DisabledTaskToVerify){(Get-ScheduledTask -TaskName $DisabledTaskToVerify -ErrorAction SilentlyContinue).Settings.Enabled}else{$null})
    installedAsar=(Get-FileHash -LiteralPath (Join-Path $installed 'resources\app.asar') -Algorithm SHA256).Hash.ToLower()
  }
}
if($Action -eq 'inspect') {Status | ConvertTo-Json -Depth 6 -Compress;exit}
if($Action -eq 'cleanup') {
  if(Get-Process CueDeckPdfQA -ErrorAction SilentlyContinue){throw 'QA still running; let its driver close it'}
  if(Get-ScheduledTask -TaskName $task -ErrorAction SilentlyContinue){throw 'Unexpected retained QA task'}
  Status | ConvertTo-Json -Depth 6 -Compress;exit
}
if($Action -eq 'start') {
  if(Get-Process CueDeckPdfQA -ErrorAction SilentlyContinue){throw 'Previous QA still running'}
  if(Get-ScheduledTask -TaskName $task -ErrorAction SilentlyContinue){throw 'QA task already exists'}
  if(-not(Test-Path -LiteralPath (Join-Path $Root 'app.asar'))){throw 'QA app.asar missing'}
  $before=Status
  if($before.installedProcesses.Count){throw 'Installed CueDeck is running'}
  if($before.backgroundTaskEnabled){throw 'Specified background task unexpectedly enabled; leave untouched'}
  New-Item -ItemType Directory -Path $runtime,$output,(Join-Path $runtime 'resources') -Force | Out-Null
  if(-not(Test-Path -LiteralPath $exe)) {
    # Exact known runtime files only. Never recurse into the installed resources.
    $files=@(Get-ChildItem -LiteralPath $installed -File)
    $locales=Join-Path $installed 'locales'
    $links=@($files | Where-Object {$_.Attributes -band [IO.FileAttributes]::ReparsePoint})
    $links+=@(Get-ChildItem -LiteralPath $locales -Recurse -Force | Where-Object {$_.Attributes -band [IO.FileAttributes]::ReparsePoint})
    if($links.Count){throw 'Runtime contains reparse points'}
    Copy-Item -LiteralPath (Join-Path $installed 'CueDeck.exe') -Destination $exe
    foreach($file in $files){if($file.Extension -ne '.exe'){Copy-Item -LiteralPath $file.FullName -Destination $runtime}}
    Copy-Item -LiteralPath $locales -Destination $runtime -Recurse
  }
  Copy-Item -LiteralPath (Join-Path $Root 'app.asar') -Destination (Join-Path $runtime 'resources\app.asar') -Force
  foreach($name in @('app.asar.unpacked','omt','spout','ffprobe')) {
    $source=if($name -eq 'app.asar.unpacked'){Join-Path $Root $name}else{Join-Path $installed ('resources\'+$name)}
    if(Test-Path -LiteralPath $source) {
      $links=@(Get-ChildItem -LiteralPath $source -Recurse -Force | Where-Object {$_.Attributes -band [IO.FileAttributes]::ReparsePoint})
      if($links.Count){throw 'QA resources contain reparse points'}
      Copy-Item -LiteralPath $source -Destination (Join-Path $runtime 'resources') -Recurse -Force
    }
  }
  $config=Join-Path $Root ($Case+'-config.json')
  if(-not(Test-Path -LiteralPath $config)){throw 'QA config missing'}
  $launcher=Join-Path $Root 'launch.cmd'
  $content="@echo off`r`nset ELECTRON_RUN_AS_NODE=`r`nset CUEDECK_PRODUCT_QA_CONFIG=$config`r`n`"$exe`" 1>>`"$Root\$Case.log`" 2>&1`r`n"
  [IO.File]::WriteAllText($launcher,$content,(New-Object Text.UTF8Encoding($false)))
  $principal=New-ScheduledTaskPrincipal -UserId ([Environment]::UserName) -LogonType Interactive -RunLevel Limited
  $actionObject=New-ScheduledTaskAction -Execute 'cmd.exe' -Argument ('/c "'+$launcher+'"')
  try {
    Register-ScheduledTask -TaskName $task -Action $actionObject -Principal $principal | Out-Null
    Start-ScheduledTask -TaskName $task
    Start-Sleep -Seconds 2
  } finally {Unregister-ScheduledTask -TaskName $task -Confirm:$false -ErrorAction SilentlyContinue}
  $before | ConvertTo-Json -Depth 6 -Compress
  exit
}
if($Action -eq 'monitor') {
  $rows=New-Object Collections.Generic.List[object]
  for($i=0;$i -lt 900;$i++) {
    $memory=Get-CimInstance Win32_PerfFormattedData_PerfOS_Memory
    $processes=@(Get-Process CueDeckPdfQA -ErrorAction SilentlyContinue | Select-Object Id,PrivateMemorySize64,WorkingSet64,CPU)
    $rows.Add(@{at=[DateTime]::UtcNow.ToString('o');committed=[double]$memory.CommittedBytes;limit=[double]$memory.CommitLimit;availableMiB=$memory.AvailableMBytes;processes=$processes})
    if([double]$memory.CommittedBytes -gt .90*[double]$memory.CommitLimit){
      [IO.File]::WriteAllText((Join-Path $output 'stop.flag'),'memory budget')
    }
    if($i -gt 2 -and -not $processes.Count){break}
    Start-Sleep -Seconds 1
  }
  $rows | ConvertTo-Json -Depth 6 | Set-Content -LiteralPath (Join-Path $Root ($Case+'-system.json')) -Encoding UTF8
  Status | ConvertTo-Json -Depth 6 -Compress
}
