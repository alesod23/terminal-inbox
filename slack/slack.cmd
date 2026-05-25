@echo off
REM Windows shim so callers can `slack.cmd <subcommand>` without typing python paths.
REM Uses bare `python` — if that hits the Microsoft Store stub, install Python from
REM python.org or set TRIAGE_PYTHON in your environment.
python "%~dp0slack.py" %*
