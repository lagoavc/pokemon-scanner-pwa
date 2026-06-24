@echo off
chcp 65001 >nul
cd /d "%~dp0"
echo ================================================
echo   PokéScanner - Servidor Local
echo ================================================
echo.
echo NOTA: A app agora faz OCR diretamente do browser
echo com a API key do utilizador. Este servidor é
echo opcional (legado - proxy OCR.space).
echo.
echo Servidor: http://localhost:8080
echo Telemóvel: http://192.168.31.234:8080
echo.
echo Prima CTRL+C para parar
echo ================================================
python server.py
pause
