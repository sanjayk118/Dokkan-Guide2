@echo off
cd /d "%~dp0"
echo ================================
echo   Dokkan Guide Starting...
echo   Open http://localhost:3000
echo ================================
echo.
"C:\Program Files\nodejs\node.exe" "%~dp0server.js"
if %errorlevel% neq 0 (
  echo.
  echo ERROR: Something went wrong. Check above for details.
  echo.
)
pause
