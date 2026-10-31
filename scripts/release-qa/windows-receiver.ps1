param([Parameter(Mandatory=$true)][string]$Root,[Parameter(Mandatory=$true)][string]$Source,[ValidateRange(5,120)][int]$Seconds=15)
$ErrorActionPreference='Stop'
[Console]::OutputEncoding=New-Object Text.UTF8Encoding($false)
if($Source -notmatch '^omt://[0-9.]+:[0-9]+$'){throw 'Expected a direct numeric OMT endpoint'}
$env:ELECTRON_RUN_AS_NODE='1'
$env:NODE_PATH='C:\Program Files\CueDeck\resources\app.asar\node_modules'
$env:OMT_LIB_DIR='C:\Program Files\CueDeck\resources\omt'
$output=Join-Path $Root ('network-'+[DateTime]::UtcNow.ToString('yyyyMMddTHHmmssfff'))
New-Item -ItemType Directory -Path $output -Force | Out-Null
$env:OMT_STORAGE_PATH=Join-Path $output 'settings'
New-Item -ItemType Directory -Path $env:OMT_STORAGE_PATH -Force | Out-Null
& 'C:\Program Files\CueDeck\CueDeck.exe' (Join-Path $Root 'receiver.cjs') $Source $output ([string]$Seconds)
if(-not(Test-Path (Join-Path $output 'result.json'))){throw 'Observer exited without final result'}
Get-Content -Raw (Join-Path $output 'result.json')
