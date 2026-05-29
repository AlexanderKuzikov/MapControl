Set WshShell = CreateObject("WScript.Shell")
scriptDir = WshShell.CurrentDirectory
WshShell.Run "cmd /c """ & scriptDir & "\update.bat"""", 0, True
