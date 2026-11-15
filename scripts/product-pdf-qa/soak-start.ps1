param([Parameter(Mandatory=$true)][string]$Root,[Parameter(Mandatory=$true)][ValidatePattern('^[a-z0-9-]+$')][string]$Case)
$ErrorActionPreference='Stop'
$task='CueDeck-PDF-Soak-20261115'
$exe=Join-Path $Root 'runtime\CueDeckPdfQA.exe'
$controller=Join-Path $Root 'soak.cjs'
$config=Join-Path $Root ($Case+'-controller.json')
if(!(Test-Path -LiteralPath $config)){throw 'Controller config missing'}
$cfg=Get-Content -LiteralPath $config -Raw | ConvertFrom-Json
if($cfg.seconds -lt 20 -or $cfg.seconds -gt 3600){throw 'Invalid bounded run duration'}
if(Get-ScheduledTask -TaskName $task -ErrorAction SilentlyContinue){throw 'Own soak task already exists'}
$processes=@(Get-CimInstance Win32_Process -Filter "Name='CueDeckPdfQA.exe'")
if(!($processes | Where-Object {$_.ExecutablePath -eq $exe -and $_.CommandLine -notmatch ' --type=' -and $_.CommandLine -notmatch 'soak\.cjs'})){throw 'Own GUI app is not running'}
if($processes | Where-Object {$_.CommandLine -match 'soak\.cjs'}){throw 'Own controller already running'}
if(Get-Process CueDeck -ErrorAction SilentlyContinue){throw 'Installed CueDeck is running'}
$launcher=Join-Path $Root ($Case+'-controller.cmd')
$log=Join-Path $Root ($Case+'-controller.log')
$content="@echo off`r`nset ELECTRON_RUN_AS_NODE=1`r`n`"$exe`" `"$controller`" `"$config`" 1>>`"$log`" 2>&1`r`n"
[IO.File]::WriteAllText($launcher,$content,(New-Object Text.UTF8Encoding($false)))
$principal=New-ScheduledTaskPrincipal -UserId ([Environment]::UserName) -LogonType Interactive -RunLevel Limited
$action=New-ScheduledTaskAction -Execute 'cmd.exe' -Argument ('/c "'+$launcher+'"')
$settings=New-ScheduledTaskSettingsSet -ExecutionTimeLimit (New-TimeSpan -Seconds ($cfg.seconds+180))
try {
 Register-ScheduledTask -TaskName $task -Action $action -Principal $principal -Settings $settings | Out-Null
 Start-ScheduledTask -TaskName $task
 Start-Sleep -Seconds 2
} finally {Unregister-ScheduledTask -TaskName $task -Confirm:$false -ErrorAction SilentlyContinue}
@{requestedSeconds=$cfg.seconds;output=$cfg.output;oneShotTaskRemoved=$true}|ConvertTo-Json -Compress
