@echo off
REM Windows shim so callers can `gmail.cmd <subcommand>` without typing python paths.
REM Uses bare `python` — if that hits the Microsoft Store stub, install Python from
REM python.org or set TRIAGE_PYTHON / python_cmd in triage-config.json.
python "%~dp0gmail.py" %*
