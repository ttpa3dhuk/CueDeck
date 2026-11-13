import { spawn } from 'node:child_process'
import { createHash } from 'node:crypto'
import { copyFile, mkdir, rename, rm, stat } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import { basename, dirname, join } from 'node:path'

const appPath = '/Applications/Microsoft PowerPoint.app'
export class PowerpointExportError extends Error {
  constructor(message: string, readonly uncertain = false, readonly missing = false) { super(message) }
}
const script = `on run argv
 set expectedName to item 1 of argv
 set outputPath to item 2 of argv
 with timeout of 90 seconds
  tell application "Microsoft PowerPoint"
   repeat 100 times
    if exists presentation expectedName then exit repeat
    delay 0.1
   end repeat
   if not (exists presentation expectedName) then error "PowerPoint did not open the staged copy"
   set deck to presentation expectedName
   try
    set print hidden slides of print options of deck to false
    save deck in (POSIX file outputPath) as save as PDF
   on error messageText number errorNumber
    close deck saving no
    error messageText number errorNumber
   end try
   close deck saving no
  end tell
 end timeout
end run`

function command(binary: string, args: string[]): Promise<{ code: number; stderr: string; stdout: string }> {
  return new Promise((resolve, reject) => {
    const child = spawn(binary, args, { stdio: ['ignore', 'pipe', 'pipe'] })
    let stderr = ''; let stdout = ''
    child.stderr.on('data', (chunk) => { stderr += String(chunk) })
    child.stdout.on('data', (chunk) => { stdout += String(chunk) })
    child.on('error', reject)
    child.on('close', (code) => resolve({ code: code ?? -1, stderr, stdout }))
  })
}

export function powerpointCacheSha(sourceSha1: string, version: string): string {
  return createHash('sha1').update(`${sourceSha1}|powerpoint-native-frames-v8|${version}`).digest('hex')
}

/** Never edits the source. The unique staged filename is the only presentation we close. */
export async function exportPowerpointStatic(stagedPath: string, outputDir: string, outputSha: string, signal: AbortSignal | undefined, exchangeDir: string): Promise<string> {
  if (process.platform !== 'darwin' || !existsSync(appPath)) throw new PowerpointExportError('Microsoft PowerPoint не установлен на этом Mac', false, true) // i18n-ok: worker/main error
  if (signal?.aborted) throw new PowerpointExportError('PowerPoint preparation cancelled')
  await mkdir(exchangeDir, { recursive: true })
  const uniqueBase = `cuedeck-${basename(dirname(outputDir))}`
  const uniquePath = join(exchangeDir, `${uniqueBase}.pptx`)
  await copyFile(stagedPath, uniquePath)
  if (signal?.aborted) { await rm(uniquePath, { force: true }); throw new PowerpointExportError('PowerPoint preparation cancelled') }
  const output = join(exchangeDir, `${uniqueBase}.pdf`)
  const opened = await command('/usr/bin/open', ['-g', '-a', appPath, uniquePath])
  if (opened.code !== 0) throw new PowerpointExportError(`PowerPoint не открыл копию: ${opened.stderr.trim()}`) // i18n-ok: worker/main error
  // After open(0), the presentation may still be loading. Even if cancelled,
  // wait for the export script to find and close this copy before releasing
  // the queue; an immediate "if exists" could miss a late-opened deck.
  // Do not kill osascript on cancellation: an already delivered AppleEvent may
  // continue after its sender exits. The worker waits for a definite result.
  const exported = await command('/usr/bin/osascript', ['-e', script, basename(uniquePath), output])
  if (exported.code !== 0) throw new PowerpointExportError(`PowerPoint PDF: ${exported.stderr.trim() || exported.stdout.trim()}`, true)
  const pdf = await stat(output).catch(() => null)
  if (!pdf?.isFile() || pdf.size === 0) throw new PowerpointExportError('PowerPoint не создал PDF') // i18n-ok: worker/main error
  if (signal?.aborted) throw new PowerpointExportError('PowerPoint preparation cancelled')
  const target = join(outputDir, `${outputSha}.pdf`)
  const pending = `${target}.partial`
  await copyFile(output, pending)
  await rename(pending, target)
  await rm(uniquePath, { force: true })
  await rm(output, { force: true })
  return target
}
