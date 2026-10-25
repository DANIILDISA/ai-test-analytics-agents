@echo off
cd /d "%~dp0"

rem One-click launcher. Interpreter preference:
rem   1) runtime\python  - bundled embeddable Python (zero-install, deps included)
rem   2) .venv           - local virtual environment
rem   3) system Python (py / python) - first run creates .venv and installs deps
rem Then hands off to scripts\launch.py (starts the web app, opens the browser).
rem ASCII-only on purpose so cmd.exe parses it in any console codepage.

if exist "runtime\python\python.exe" (
    "runtime\python\python.exe" "scripts\launch.py"
    goto end
)

if exist ".venv\Scripts\python.exe" (
    ".venv\Scripts\python.exe" "scripts\launch.py"
    goto end
)

where py >nul 2>nul
if %errorlevel% equ 0 (
    py -3 "scripts\launch.py"
    goto end
)

where python >nul 2>nul
if %errorlevel% equ 0 (
    python "scripts\launch.py"
    goto end
)

echo.
echo Python was not found and no bundled runtime is present.
echo Either use the package that includes the runtime\ folder, or install
echo Python 3.10+ from https://www.python.org/downloads/ (enable "Add Python
echo to PATH") and run START.bat again.
echo.

:end
pause
