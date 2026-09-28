Option Explicit

Dim shell, fso, projectRoot, scriptDir, launcher, powerShell, command
Set shell = CreateObject("WScript.Shell")
Set fso = CreateObject("Scripting.FileSystemObject")

If WScript.Arguments.Count > 0 Then
  projectRoot = WScript.Arguments(0)
Else
  scriptDir = fso.GetParentFolderName(WScript.ScriptFullName)
  projectRoot = fso.GetAbsolutePathName(fso.BuildPath(scriptDir, "..\.."))
End If

scriptDir = fso.GetParentFolderName(WScript.ScriptFullName)
launcher = fso.BuildPath(scriptDir, "start-background.ps1")
powerShell = fso.BuildPath(shell.ExpandEnvironmentStrings("%SystemRoot%"), "System32\WindowsPowerShell\v1.0\powershell.exe")
command = Quote(powerShell) & " -NoProfile -NonInteractive -ExecutionPolicy Bypass -WindowStyle Hidden -File " & _
          Quote(launcher) & " -ProjectRoot " & Quote(projectRoot)

' Window style 0 is fully hidden. The PowerShell launcher opens only Chrome.
shell.Run command, 0, False

Function Quote(value)
  Quote = Chr(34) & value & Chr(34)
End Function
