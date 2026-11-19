import { spawn } from 'node:child_process'
import { win32 } from 'node:path'
import { PowerpointExportError } from './powerpoint-error.js'

// No file association, shell interpolation or persistent PowerShell policy changes.
// A child of the interactive Electron worker stays in that user's desktop/session.
export const WINDOWS_POWERPOINT_DETECT = String.raw`
$ErrorActionPreference='Stop'
$ProgressPreference='SilentlyContinue'
[Console]::OutputEncoding=[Text.UTF8Encoding]::new($false)
$paths=@()
foreach($view in @([Microsoft.Win32.RegistryView]::Registry64,[Microsoft.Win32.RegistryView]::Registry32)) {
  $base=$null;$key=$null
  try {
    $base=[Microsoft.Win32.RegistryKey]::OpenBaseKey([Microsoft.Win32.RegistryHive]::LocalMachine,$view)
    $key=$base.OpenSubKey('SOFTWARE\Microsoft\Windows\CurrentVersion\App Paths\POWERPNT.EXE')
    if($key){$paths+=[string]$key.GetValue('')}
  } finally {if($key){$key.Dispose()};if($base){$base.Dispose()}}
}
foreach($root in @($env:ProgramFiles,[Environment]::GetEnvironmentVariable('ProgramFiles(x86)'))) {
  if($root){$paths+=(Join-Path $root 'Microsoft Office\root\Office16\POWERPNT.EXE');$paths+=(Join-Path $root 'Microsoft Office\Office16\POWERPNT.EXE')}
}
foreach($path in $paths) {
  if($path -and (Test-Path -LiteralPath $path -PathType Leaf)) {
    $v=(Get-Item -LiteralPath $path).VersionInfo.FileVersion
    if($v){@{path=$path;version=[string]$v}|ConvertTo-Json -Compress;exit 0}
  }
}
'null'
`

export function windowsPowerpointExportScript(source: string, output: string): string {
  const payload = Buffer.from(JSON.stringify({ source, output }), 'utf8').toString('base64')
  return String.raw`
$ErrorActionPreference='Stop'
$ProgressPreference='SilentlyContinue'
[Console]::OutputEncoding=[Text.UTF8Encoding]::new($false)
$request=[Text.Encoding]::UTF8.GetString([Convert]::FromBase64String('${payload}'))|ConvertFrom-Json
$app=$null;$deck=$null;$presentations=$null;$printOptions=$null;$ranges=$null;$range=$null;$opening=$false
$result=@{ok=$false;cleanupConfirmed=$true}
try {
  try {$app=[Runtime.InteropServices.Marshal]::GetActiveObject('PowerPoint.Application')}
  catch {$app=New-Object -ComObject PowerPoint.Application}
  $presentations=$app.Presentations
  $opening=$true
  $deck=$presentations.Open([string]$request.source,-1,0,0)
  $opening=$false
  $printOptions=$deck.PrintOptions
  $printOptions.PrintHiddenSlides=0
  $ranges=$printOptions.Ranges
  $range=$ranges.Add(1,$deck.Slides.Count)
  # Explicitly exclude hidden slides; leave user-wide PowerPoint options alone.
  $deck.ExportAsFixedFormat([string]$request.output,2,2,0,1,1,0,$range,1,'',$true,$true,$true,$true,$false)
  $result.ok=$true
} catch {$result.error=$_.Exception.Message;if($opening){$result.cleanupConfirmed=$false}}
finally {
  if($deck){
    try {$deck.Saved=-1;$deck.Close()}
    catch {$result.cleanupConfirmed=$false;$result.cleanupError=$_.Exception.Message}
  }
  # PowerPoint is a multiuse COM server. A user can open even an empty window
  # during export. Release our references; never Quit the shared application.
  foreach($obj in @($range,$ranges,$printOptions,$deck,$presentations,$app)){
    if($null -ne $obj){try{[void][Runtime.InteropServices.Marshal]::FinalReleaseComObject($obj)}catch{}}
  }
}
[Console]::WriteLine(($result|ConvertTo-Json -Compress))
`
}

export function runPowerpointPowerShell(script: string, timeoutMs = 90_000): Promise<string> {
  return new Promise((resolve, reject) => {
    const binary = win32.join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe')
    const child = spawn(binary, ['-NoProfile', '-NonInteractive', '-STA', '-EncodedCommand', Buffer.from(script, 'utf16le').toString('base64')], {
      stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true,
    })
    let stdout = '', stderr = '', settled = false
    const finish = (error?: Error): void => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      if (error) reject(error)
      else resolve(stdout.trim().replace(/^\uFEFF/, ''))
    }
    // Killing the COM client cannot retract an already delivered call. Keep it
    // alive to run its finally block; an uncertain result halts the main queue.
    const timer = setTimeout(() => finish(new PowerpointExportError('PowerPoint COM export timed out', true)), timeoutMs)
    child.stdout.on('data', chunk => {
      if (settled) return
      stdout += String(chunk)
      if (stdout.length > 64 * 1024) finish(new PowerpointExportError('PowerPoint COM output exceeded limit', true))
    })
    child.stderr.on('data', chunk => { if (!settled) stderr = (stderr + String(chunk)).slice(-8192) })
    child.on('error', error => finish(new PowerpointExportError(`PowerPoint COM client: ${error.message}`)))
    child.on('close', code => finish(code === 0 ? undefined : new PowerpointExportError(`PowerPoint COM client exited ${code}: ${stderr}`, true)))
  })
}

export async function powerpointWindowsVersion(): Promise<string | null> {
  try {
    const result = JSON.parse(await runPowerpointPowerShell(WINDOWS_POWERPOINT_DETECT, 10_000)) as { version?: unknown } | null
    return result && typeof result.version === 'string' ? result.version : null
  } catch { return null }
}

/** Abort is checked after COM finishes and confirms closing our document. */
export async function exportPowerpointWindows(source: string, output: string, signal?: AbortSignal): Promise<void> {
  if (signal?.aborted) throw new PowerpointExportError('PowerPoint preparation cancelled')
  const raw = await runPowerpointPowerShell(windowsPowerpointExportScript(source, output))
  let result: { ok?: boolean; cleanupConfirmed?: boolean; error?: string; cleanupError?: string }
  try { result = JSON.parse(raw) }
  catch { throw new PowerpointExportError('PowerPoint COM returned an invalid response', true) }
  if (!result || typeof result !== 'object') throw new PowerpointExportError('PowerPoint COM returned an invalid response', true)
  if (result.cleanupConfirmed !== true) throw new PowerpointExportError(`PowerPoint COM cleanup: ${result.cleanupError || result.error || 'unconfirmed'}`, true)
  if (result.ok !== true) throw new PowerpointExportError(`PowerPoint PDF: ${result.error || 'export failed'}`)
  if (signal?.aborted) throw new PowerpointExportError('PowerPoint preparation cancelled')
}
