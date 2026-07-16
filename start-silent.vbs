Set objShell = CreateObject("WScript.Shell")
objShell.CurrentDirectory = "C:\Users\aizyaguev\lab-manager\backend"
objShell.Run "cmd /c ""C:\Users\aizyaguev\AppData\Local\Programs\Python\Python312\python.exe"" -m uvicorn app.main:app --host 0.0.0.0 --port 8000 >> C:\Users\aizyaguev\lab-manager\server.log 2>&1", 0, False
