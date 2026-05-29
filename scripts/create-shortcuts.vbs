Set WshShell = CreateObject("WScript.Shell")
Set FSO = CreateObject("Scripting.FileSystemObject")

scriptDir = FSO.GetParentFolderName(WScript.ScriptFullName)
repoDir = FSO.GetParentFolderName(scriptDir)

Set scMap = WshShell.CreateShortcut(scriptDir & "\MapControl.lnk")
scMap.TargetPath = "wscript.exe"
scMap.Arguments = """""" & repoDir & "\start.vbs""""
scMap.WorkingDirectory = repoDir
scMap.IconLocation = repoDir & "\public\favicon.ico, 0"
scMap.Description = "Launch MapControl"
scMap.Save

Set scUpd = WshShell.CreateShortcut(scriptDir & "\Update MapControl.lnk")
scUpd.TargetPath = "wscript.exe"
scUpd.Arguments = """""" & repoDir & "\update.vbs""""
scUpd.WorkingDirectory = repoDir
scUpd.IconLocation = "%SystemRoot%\System32\shell32.dll, 14"
scUpd.Description = "Update MapControl"
scUpd.Save

MsgBox "Shortcuts created in:" & vbCrLf & scriptDir & vbCrLf & vbCrLf & "Copy .lnk files to Desktop.", vbInformation, "MapControl Setup"
