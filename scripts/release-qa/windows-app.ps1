param(
  [ValidateSet('inspect','start')][string]$Action='inspect',
  [Parameter(Mandatory=$true)][string]$Root,
  [ValidateRange(1024,65535)][int]$CdpPort=9823,
  [ValidateRange(1024,65535)][int]$InspectorPort=9829
)
$ErrorActionPreference='Stop'
[Console]::OutputEncoding=New-Object Text.UTF8Encoding($false)
$app='C:\Program Files\CueDeck\CueDeck.exe'
$taskName='CueDeck-Release-QA'
if(-not(Test-Path -LiteralPath $app)){throw 'Installed CueDeck is missing'}
$mains=@(Get-CimInstance Win32_Process -Filter "Name='CueDeck.exe'" | Where-Object {
  $_.CommandLine -notmatch ' --type=' -and $_.CommandLine -notmatch '\.([cm]?js)\b'
})
foreach($main in $mains){if($main.ExecutablePath -ne $app){throw 'Unexpected CueDeck executable'}}
if($mains.Count -gt 1){throw 'More than one CueDeck main process'}
if($Action -eq 'inspect'){
  @{
    version=(((Get-Item -LiteralPath $app).VersionInfo.ProductVersion -split '\.')[0..2] -join '.')
    executable=$app
    executableSha256=(Get-FileHash -LiteralPath $app -Algorithm SHA256).Hash.ToLower()
    asarSha256=(Get-FileHash -LiteralPath 'C:\Program Files\CueDeck\resources\app.asar' -Algorithm SHA256).Hash.ToLower()
    processes=@($mains | Select-Object ProcessId,CommandLine,ExecutablePath)
  } | ConvertTo-Json -Depth 5 -Compress
  exit
}
if($mains.Count -gt 0){throw 'Initial setup: close CueDeck normally before its first QA launch'}
New-Item -ItemType Directory -Path $Root -Force | Out-Null
$launcher=Join-Path $Root 'launch.cmd'
$content="@echo off`r`nset ELECTRON_RUN_AS_NODE=`r`nset CUEDECK_NO_NAG=1`r`n`"$app`" --remote-debugging-address=127.0.0.1 --remote-debugging-port=$CdpPort --inspect=127.0.0.1:$InspectorPort 1>>`"$Root\app.log`" 2>&1`r`n"
[IO.File]::WriteAllText($launcher,$content,(New-Object Text.UTF8Encoding($false)))
if(Get-ScheduledTask -TaskName $taskName -ErrorAction SilentlyContinue){throw 'Existing QA task; inspect before reuse'}
$principal=New-ScheduledTaskPrincipal -UserId ([Environment]::UserName) -LogonType Interactive -RunLevel Limited
$actionObject=New-ScheduledTaskAction -Execute 'cmd.exe' -Argument ('/c "'+$launcher+'"')
try{
  Register-ScheduledTask -TaskName $taskName -Action $actionObject -Principal $principal | Out-Null
  Start-ScheduledTask -TaskName $taskName
  Start-Sleep -Seconds 3
  $started=@(Get-CimInstance Win32_Process -Filter "Name='CueDeck.exe'" | Where-Object {$_.CommandLine -notmatch ' --type='})
  if($started.Count -ne 1){throw 'Installed GUI did not start in the interactive desktop'}
}finally{
  Unregister-ScheduledTask -TaskName $taskName -Confirm:$false -ErrorAction SilentlyContinue
}
