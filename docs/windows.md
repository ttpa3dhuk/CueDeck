# If CueDeck won't start on Windows

[Русский](windows.ru.md)

CueDeck isn't signed with a Microsoft certificate yet, so Windows sometimes refuses to run it. Signing costs money and we haven't bought it so far. Here's what to do, step by step.

## 1. Unzip the archive completely

CueDeck won't run from inside the zip. Right-click the archive, choose "Extract All…", and run `CueDeck.exe` from the extracted folder.

You'll get fewer warnings if, before extracting, you right-click the zip, open "Properties" and tick "Unblock" at the bottom.

## 2. Blue "Windows protected your PC" window

That's SmartScreen. Click "More info", then "Run anyway". It asks only once.

## 3. "This app has been blocked" and there's no "Run" button

Smart App Control is on. It usually is on a fresh Windows 11 install. Turn it off: Start, "Windows Security", "App & browser control", "Smart App Control settings", "Off".

Smart App Control can only be turned back on by reinstalling Windows. Antivirus and firewall keep working.

### Windows Security won't open or closes right away

We had exactly that on one of our machines. The same setting can be changed with a command. Open PowerShell as administrator (Start, right-click "Terminal" or "PowerShell", "Run as administrator"), paste the line and press Enter:

```
reg add HKLM\SYSTEM\CurrentControlSet\Control\CI\Policy /v VerifiedAndReputablePolicyState /t REG_DWORD /d 0 /f; citool -r
```

If CueDeck still won't start after that, restart the computer.

## 4. vMix or OBS can't see the OMT outputs

The first time you turn on OMT outputs, Windows asks for network access. Tick "Private networks" and click "Allow access". If the window was closed without an answer, Windows remembers "blocked". Then this command in PowerShell as administrator helps:

```
Get-NetFirewallRule -DisplayName CueDeck | Set-NetFirewallRule -Action Allow
```

## Still stuck

In CueDeck open the Help menu, "Report a problem…". A zip appears on the desktop: send it to the author or attach it to an [issue](https://github.com/ttpa3dhuk/CueDeck/issues/new/choose).
