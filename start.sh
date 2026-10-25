#!/usr/bin/env bash
# Один файл запуска для macOS / Linux — вызывает scripts/launch.py, который создаёт
# окружение, ставит зависимости и поднимает веб-приложение. Сделайте исполняемым один
# раз: chmod +x start.sh — затем запускайте ./start.sh
set -e
cd "$(dirname "$0")"

if command -v python3 >/dev/null 2>&1; then
  exec python3 scripts/launch.py
fi
if command -v python >/dev/null 2>&1; then
  exec python scripts/launch.py
fi

echo "Python 3.10+ не найден. Установите его (https://www.python.org/downloads/) и повторите."
exit 1
