' Runs tools\briefing.js without a console window.
' Called by the Task Scheduler entry "TodoApp-MorningBriefing" (daily 09:00 and at logon).
Option Explicit

Dim sh, fso, here
Set sh  = CreateObject("WScript.Shell")
Set fso = CreateObject("Scripting.FileSystemObject")

here = fso.GetParentFolderName(WScript.ScriptFullName)
sh.CurrentDirectory = fso.GetParentFolderName(here)

' Wait until the briefing window is closed; if this script exits first,
' Task Scheduler ends the task and closes the window with it.
sh.Run """C:\Program Files\nodejs\node.exe"" """ & fso.BuildPath(here, "briefing.js") & """", 0, True
