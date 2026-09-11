' run-hidden.vbs - run the sibling watchdog.ps1 with NO visible window.
'
' Task Scheduler launching powershell.exe directly flashes a console window every
' time the task fires (here: every minute). Running it through wscript with
' window style 0 suppresses that entirely.
'
' This script lives in scripts/ next to watchdog.ps1 and finds it by its own
' location, so the scheduled task needs no arguments (no quoting to get wrong).
Set fso = CreateObject("Scripting.FileSystemObject")
Set sh  = CreateObject("WScript.Shell")

scriptDir = fso.GetParentFolderName(WScript.ScriptFullName)
watchdog  = fso.BuildPath(scriptDir, "watchdog.ps1")

If Not fso.FileExists(watchdog) Then WScript.Quit 1

cmd = "powershell.exe -NoProfile -NonInteractive -ExecutionPolicy Bypass -File """ & watchdog & """"
' 0 = hidden window, False = do not wait for it to finish
sh.Run cmd, 0, False
