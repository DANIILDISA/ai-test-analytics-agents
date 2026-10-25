#!/usr/bin/env python3
"""Однофайловый запуск КОРПУС — для проверяющего на чистой машине.

Делает всё сам и не требует Node:
  1) создаёт виртуальное окружение ``.venv`` (если его нет);
  2) ставит Python-зависимости из ``requirements.txt`` (один раз);
  3) проверяет, что собранный фронтенд ``web/frontend/dist`` на месте;
  4) поднимает веб-сервер ``web.serve:app`` на свободном порту;
  5) открывает браузер на главной странице.

Запуск: ``START.bat`` (Windows) / ``./start.sh`` (macOS, Linux) — они просто
вызывают этот файл. Можно и напрямую: ``python scripts/launch.py``.

Единственное требование к машине — установленный Python 3.10+ (с него и запускается
этот скрипт). API-ключи нейросетей НЕ обязательны: базовый анализ работает офлайн,
без обращения к LLM; ключи нужны только для ИИ-комментариев и чата (см. .env.example).
"""

from __future__ import annotations

import os
import subprocess
import sys
import time
import urllib.request
import webbrowser
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
VENV = ROOT / ".venv"
# Пакеты, по наличию которых судим, что зависимости уже стоят (быстрая проверка вместо
# повторного pip install при каждом запуске).
REQUIRED_IMPORTS = "fastapi, uvicorn, openpyxl, openai, gigachat, rapidfuzz, yaml, dotenv, pydantic"
HOST = "127.0.0.1"
FIRST_PORT = 8010


def _say(msg: str) -> None:
    print(f"[КОРПУС] {msg}", flush=True)


def _venv_python() -> Path:
    """Путь к python внутри .venv (раскладка отличается на Windows и Unix)."""
    if os.name == "nt":
        return VENV / "Scripts" / "python.exe"
    return VENV / "bin" / "python"


def _ensure_venv() -> Path:
    py = _venv_python()
    if py.exists():
        return py
    _say("Создаю виртуальное окружение .venv …")
    subprocess.run([sys.executable, "-m", "venv", str(VENV)], check=True)
    if not py.exists():  # pragma: no cover — defensive
        raise SystemExit("Не удалось создать .venv. Установлен ли модуль venv?")
    return py


def _deps_present(py: Path) -> bool:
    return subprocess.run(
        [str(py), "-c", f"import {REQUIRED_IMPORTS}"],
        stdout=subprocess.DEVNULL,
        stderr=subprocess.DEVNULL,
    ).returncode == 0


def _install_deps(py: Path) -> None:
    _say("Устанавливаю зависимости (один раз, нужен интернет) …")
    subprocess.run([str(py), "-m", "pip", "install", "--upgrade", "pip", "-q"], check=False)
    res = subprocess.run(
        [str(py), "-m", "pip", "install", "-q", "-r", str(ROOT / "requirements.txt")]
    )
    if res.returncode != 0 or not _deps_present(py):
        raise SystemExit(
            "Не удалось установить зависимости. Проверьте интернет-соединение и повторите "
            "запуск. Команда вручную: .venv\\Scripts\\python -m pip install -r requirements.txt"
        )


def _check_frontend() -> None:
    index = ROOT / "web" / "frontend" / "dist" / "index.html"
    if index.exists():
        return
    raise SystemExit(
        "Не найден собранный интерфейс web/frontend/dist. В поставке он должен быть включён.\n"
        "Если вы клонировали репозиторий без сборки — установите Node.js 18+ и выполните:\n"
        "    cd web/frontend && npm ci && npm run build"
    )


def _free_port(host: str, first: int, tries: int = 20) -> int:
    import socket

    for port in range(first, first + tries):
        with socket.socket(socket.AF_INET, socket.SOCK_STREAM) as s:
            if s.connect_ex((host, port)) != 0:  # порт свободен
                return port
    raise SystemExit(f"Не нашёл свободный порт в диапазоне {first}–{first + tries}.")


def _wait_until_up(url: str, proc: subprocess.Popen, timeout: float = 60.0) -> bool:
    deadline = time.monotonic() + timeout
    while time.monotonic() < deadline:
        if proc.poll() is not None:  # сервер упал на старте
            return False
        try:
            with urllib.request.urlopen(url, timeout=2) as r:
                if r.status == 200:
                    return True
        except Exception:
            time.sleep(0.5)
    return False


def main() -> int:
    if sys.version_info < (3, 10):
        raise SystemExit(
            f"Нужен Python 3.10 или новее (у вас {sys.version.split()[0]}). "
            "Скачать: https://www.python.org/downloads/"
        )

    # If the interpreter running this script already has the dependencies — the bundled
    # embeddable runtime (runtime/python) or an existing .venv — serve with it directly.
    # Only a bare system Python (no deps) triggers the .venv bootstrap + pip install.
    current = Path(sys.executable)
    if _deps_present(current):
        py = current
    else:
        py = _ensure_venv()
        if not _deps_present(py):
            _install_deps(py)
    _say(f"Интерпретатор: {py}")
    _check_frontend()

    if not (ROOT / ".env").exists():
        _say("Файл .env не найден — базовый анализ работает без ключей; "
             "для ИИ-комментариев и чата скопируйте .env.example в .env и впишите ключи.")

    port = _free_port(HOST, FIRST_PORT)
    url = f"http://{HOST}:{port}/"
    _say(f"Запускаю сервер на {url}")
    proc = subprocess.Popen(
        [str(py), "-m", "uvicorn", "web.serve:app", "--host", HOST, "--port", str(port),
         "--log-level", "warning"],
        cwd=str(ROOT),
    )
    try:
        if _wait_until_up(url, proc):
            _say("Готово. Открываю браузер. Чтобы остановить — закройте это окно или нажмите Ctrl+C.")
            webbrowser.open(url)
        else:
            _say("Сервер не ответил вовремя — откройте адрес вручную: " + url)
        proc.wait()
    except KeyboardInterrupt:
        _say("Останавливаю сервер …")
    finally:
        proc.terminate()
        try:
            proc.wait(timeout=10)
        except Exception:
            proc.kill()
    return 0


if __name__ == "__main__":
    sys.exit(main())
