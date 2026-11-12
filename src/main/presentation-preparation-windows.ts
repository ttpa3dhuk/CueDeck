import { writeFile } from 'node:fs/promises'
import { join } from 'node:path'

/**
 * Windows owns this entire conversion tree through a Job Object. Start the
 * converter suspended, assign it, then resume: no child can escape assignment.
 * Killing the supervisor closes the last non-inheritable job handle.
 * https://learn.microsoft.com/en-us/windows/win32/procthread/job-objects
 */
export const WINDOWS_CONVERSION_SUPERVISOR = String.raw`param([Parameter(Mandatory=$true)][string]$RequestFile)
$ErrorActionPreference='Stop'
Add-Type -TypeDefinition @'
using System;
using System.Text;
using System.Runtime.InteropServices;
using System.ComponentModel;
public static class CueDeckConversionJob {
  [StructLayout(LayoutKind.Sequential)] struct BasicLimits {
    public long ProcessTime, JobTime;
    public uint Flags;
    public UIntPtr MinWorking, MaxWorking;
    public uint ActiveProcesses;
    public UIntPtr Affinity;
    public uint Priority, Scheduling;
  }
  [StructLayout(LayoutKind.Sequential)] struct IoCounters {
    public ulong ReadOps, WriteOps, OtherOps, ReadBytes, WriteBytes, OtherBytes;
  }
  [StructLayout(LayoutKind.Sequential)] struct ExtendedLimits {
    public BasicLimits Basic;
    public IoCounters Io;
    public UIntPtr ProcessMemory, JobMemory, PeakProcess, PeakJob;
  }
  [StructLayout(LayoutKind.Sequential, CharSet=CharSet.Unicode)] struct Startup {
    public uint Size;
    public string Reserved, Desktop, Title;
    public uint X,Y,Width,Height,CharsX,CharsY,Fill,Flags;
    public ushort Show, ReservedSize;
    public IntPtr ReservedData, Input, Output, Error;
  }
  [StructLayout(LayoutKind.Sequential)] struct ProcessInfo {
    public IntPtr Process, Thread;
    public uint ProcessId, ThreadId;
  }
  [DllImport("kernel32.dll", CharSet=CharSet.Unicode, SetLastError=true)] static extern IntPtr CreateJobObject(IntPtr attrs,string name);
  [DllImport("kernel32.dll", SetLastError=true)] static extern bool SetInformationJobObject(IntPtr job,int info,IntPtr data,uint size);
  [DllImport("kernel32.dll", SetLastError=true)] static extern bool AssignProcessToJobObject(IntPtr job,IntPtr process);
  [DllImport("kernel32.dll", CharSet=CharSet.Unicode, SetLastError=true)] static extern bool CreateProcess(string app,StringBuilder command,IntPtr pa,IntPtr ta,bool inherit,uint flags,IntPtr env,string cwd,ref Startup startup,out ProcessInfo info);
  [DllImport("kernel32.dll", SetLastError=true)] static extern uint ResumeThread(IntPtr thread);
  [DllImport("kernel32.dll")] static extern uint WaitForSingleObject(IntPtr handle,uint milliseconds);
  [DllImport("kernel32.dll", SetLastError=true)] static extern bool GetExitCodeProcess(IntPtr process,out uint code);
  [DllImport("kernel32.dll")] static extern bool TerminateProcess(IntPtr process,uint code);
  [DllImport("kernel32.dll")] static extern bool CloseHandle(IntPtr handle);
  [DllImport("kernel32.dll")] static extern IntPtr GetStdHandle(int handle);
  static void Check(bool success) { if(!success) throw new Win32Exception(Marshal.GetLastWin32Error()); }
  static string Quote(string value) {
    var result=new StringBuilder("\""); int slashes=0;
    foreach(char c in value) {
      if(c=='\\') { slashes++; continue; }
      if(c=='"') { result.Append('\\',slashes*2+1); result.Append(c); slashes=0; continue; }
      result.Append('\\',slashes); slashes=0; result.Append(c);
    }
    result.Append('\\',slashes*2); result.Append('"'); return result.ToString();
  }
  public static int Run(string executable,string[] arguments) {
    IntPtr job=CreateJobObject(IntPtr.Zero,null);
    if(job==IntPtr.Zero) throw new Win32Exception(Marshal.GetLastWin32Error());
    var process=new ProcessInfo(); IntPtr data=IntPtr.Zero;
    try {
      var limits=new ExtendedLimits(); limits.Basic.Flags=0x2000;
      int size=Marshal.SizeOf(typeof(ExtendedLimits)); data=Marshal.AllocHGlobal(size);
      Marshal.StructureToPtr(limits,data,false);
      Check(SetInformationJobObject(job,9,data,(uint)size));
      var startup=new Startup(); startup.Size=(uint)Marshal.SizeOf(typeof(Startup)); startup.Flags=0x100;
      startup.Input=GetStdHandle(-10); startup.Output=GetStdHandle(-11); startup.Error=GetStdHandle(-12);
      var command=new StringBuilder(Quote(executable));
      foreach(string argument in arguments) command.Append(" ").Append(Quote(argument));
      Check(CreateProcess(executable,command,IntPtr.Zero,IntPtr.Zero,true,0x08000004,IntPtr.Zero,System.IO.Path.GetDirectoryName(executable),ref startup,out process));
      try {
        Check(AssignProcessToJobObject(job,process.Process));
        if(ResumeThread(process.Thread)==0xffffffff) throw new Win32Exception(Marshal.GetLastWin32Error());
      } catch { TerminateProcess(process.Process,1); throw; }
      Console.Error.WriteLine("CUEDECK_CONVERTER_PID="+process.ProcessId);
      if(WaitForSingleObject(process.Process,0xffffffff)==0xffffffff) throw new Win32Exception(Marshal.GetLastWin32Error());
      uint code; Check(GetExitCodeProcess(process.Process,out code)); return unchecked((int)code);
    } finally {
      // KILL_ON_JOB_CLOSE also covers descendants left behind by the launcher.
      CloseHandle(job);
      if(process.Thread!=IntPtr.Zero) CloseHandle(process.Thread);
      if(process.Process!=IntPtr.Zero) CloseHandle(process.Process);
      if(data!=IntPtr.Zero) Marshal.FreeHGlobal(data);
    }
  }
}
'@
$request=Get-Content -LiteralPath $RequestFile -Raw -Encoding UTF8 | ConvertFrom-Json
try { exit [CueDeckConversionJob]::Run([string]$request.executable,[string[]]$request.arguments) }
catch { [Console]::Error.WriteLine($_.Exception.ToString()); exit 1 }
`

export async function windowsConversionCommand(executable: string, args: string[], profileDir: string): Promise<{ executable: string; args: string[] }> {
  const script = join(profileDir, 'conversion-job.ps1')
  const request = join(profileDir, 'conversion-job.json')
  await writeFile(script, WINDOWS_CONVERSION_SUPERVISOR, 'utf8')
  await writeFile(request, JSON.stringify({ executable, arguments: args }), 'utf8')
  return {
    executable: join(process.env.SystemRoot ?? 'C:\\Windows', 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe'),
    args: ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', script, '-RequestFile', request],
  }
}
