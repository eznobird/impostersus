@echo off
echo Installing dependencies...
pip install -r requirements.txt --quiet
echo.
echo Starting TSP Route Optimizer...
python server.py
pause
