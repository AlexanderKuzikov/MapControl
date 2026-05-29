@echo off
cd /d %~dp0

echo Checking if MapControl is running...
curl -s --max-time 2 http://127.0.0.1:5179/api/config >nul 2>&1
if %errorlevel% equ 0 (
    echo MapControl is running. Please close it before updating.
    timeout /t 5 >nul
    exit /b 1
)

echo Pulling updates from GitHub...
git pull origin main
if %errorlevel% neq 0 (
    echo Git pull failed. Check your internet connection.
    timeout /t 5 >nul
    exit /b 1
)

echo Installing dependencies...
call npm ci --omit=dev
if %errorlevel% neq 0 (
    echo npm install failed.
    timeout /t 5 >nul
    exit /b 1
)

echo Update complete!
timeout /t 3 >nul
