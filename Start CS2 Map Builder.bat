@echo off
setlocal
cd /d "%~dp0"
title CS2 Map Builder

where node >nul 2>nul
if errorlevel 1 (
  echo.
  echo Node.js was not found on this computer.
  echo Install Node.js 22 or later from https://nodejs.org ^(choose LTS^),
  echo restart the computer, then double-click this file again.
  echo.
  pause
  exit /b 1
)

if not exist "node_modules" (
  echo First start: installing dependencies. This can take a few minutes ...
  call npm install
  if errorlevel 1 (
    echo.
    echo Installation failed. Check your internet connection and try again.
    pause
    exit /b 1
  )
)

echo Starting CS2 Map Builder ...
call npm start
if errorlevel 1 (
  echo.
  echo Something went wrong during startup. Read the messages above.
  pause
  exit /b 1
)
