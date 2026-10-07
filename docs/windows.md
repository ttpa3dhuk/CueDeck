# If CueDeck won't start on Windows

[Русский](windows.ru.md)

CueDeck isn't signed with a Microsoft certificate yet, so Windows sometimes refuses to run it. Here's what to do, step by step.

## 1. Unzip the archive completely

CueDeck won't run from inside the zip. Right-click the archive → **Extract All…** → run `CueDeck.exe` from the extracted folder.

For fewer warnings, before extracting: right-click the zip → **Properties** → tick **Unblock** at the bottom → OK.

## 2. Blue "Windows protected your PC" window

That's SmartScreen. Click **More info** → **Run anyway**. It asks only once.

## 3. "This app has been blocked", no "Run" button

**Smart App Control** is on (usually on a fresh Windows 11 install). Turn it off:

Start → **Windows Security** → **App & browser control** → **Smart App Control settings** → **Off**.

> ⚠️ Smart App Control can only be turned back on by reinstalling Windows. Antivirus and firewall keep working.

### Windows Security won't open or closes right away

Do the same with a command. Open PowerShell **as administrator** (Start → right-click "Terminal" or "PowerShell" → **Run as administrator**), paste the line and press Enter:

```
reg add HKLM\SYSTEM\CurrentControlSet\Control\CI\Policy /v VerifiedAndReputablePolicyState /t REG_DWORD /d 0 /f; citool -r
```

If CueDeck still won't start after that, restart the computer.

## 4. OMT outputs don't show up in vMix / OBS

The first time you turn on OMT outputs, Windows asks for network access: tick **Private networks** → **Allow access**. If the window was closed without an answer, Windows remembers "blocked". Then, in PowerShell as administrator:

```
Get-NetFirewallRule -DisplayName CueDeck | Set-NetFirewallRule -Action Allow
```

## Still stuck

In CueDeck: **Help → Report a problem…** → a zip appears on the desktop, send it to the author.
