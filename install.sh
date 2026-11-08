#!/bin/bash
set -e
cd "$(dirname "$0")"
command -v node >/dev/null || { echo "Install Node.js first: https://nodejs.org"; exit 1; }
npm install
python3 -m venv .venv
.venv/bin/pip install -r requirements.txt
.venv/bin/python install_launch_agent.py
