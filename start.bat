@echo off
setlocal
cd /d "%~dp0"

if not exist node_modules (
  call npm.cmd install
  if errorlevel 1 goto error
)

call npm.cmd run build
if errorlevel 1 goto error

call npm.cmd start
if errorlevel 1 goto error
goto end

:error
echo.
echo Hypixel Proxy kunde inte starta. Felkod: %errorlevel%
echo Las felmeddelandet ovan och tryck sedan pa en tangent.
pause >nul

:end
