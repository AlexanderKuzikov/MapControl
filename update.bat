@echo off
cd /d %~dp0

echo Checking if MapControl is running...
curl -s --max-time 2 http://127.0.0.1:5179/api/config >nul 2>&1
if %errorlevel% equ 0 (
    echo MapControl is running. Please close it before updating.
    pause
    exit /b 1
)

echo Pulling updates from GitHub...
git pull origin main
if %errorlevel% neq 0 (
    echo Git pull failed. Check your internet connection.
    pause
    exit /b 1
)

echo Installing dependencies...
call npm ci --omit=dev
if %errorlevel% neq 0 (
    echo npm install failed.
    pause
    exit /b 1
)

echo.
echo Update complete! You can start MapControl now.
pause
