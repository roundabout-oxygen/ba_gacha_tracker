@echo off
chcp 65001 > nul
title BA Gacha Live Tracker (v1.0.1)

echo ========================================================
echo   ブルアカ リアルタイムガチャ集計 (v1.0.1)
echo   Blue Archive Gacha Live Tracker
echo ========================================================
echo.
echo [1/2] ローカルサーバーを起動しています...

where python >nul 2>nul
if %ERRORLEVEL% equ 0 (
    echo Pythonが検出されました。ローカルWebサーバーを起動します (Port: 8080)...
    start "" http://localhost:8080/index.html
    python -m http.server 8080
) else (
    echo Pythonが見つからないため、既定のブラウザで直接 index.html を開きます...
    start "" "%~dp0index.html"
)

pause
