Option Explicit

Dim shell, fso, root, appPath
Set shell = CreateObject("WScript.Shell")
Set fso = CreateObject("Scripting.FileSystemObject")
root = fso.GetParentFolderName(WScript.ScriptFullName)
appPath = root & "\app\Hypixel Proxy.exe"

If fso.FileExists(appPath) Then
  shell.Run """" & appPath & """", 1, False
Else
  MsgBox "Hypixel Proxy.exe saknas. Kor build-app.ps1 for att bygga appen.", vbExclamation, "Hypixel Proxy"
End If
