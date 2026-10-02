@echo off
setlocal
REM ============================================================
REM  ComfyUI worker 启动器 —— 供 dsh-tool-comfyui 插件调用
REM  用法: start-comfyui-worker.bat [端口]
REM  默认端口 8188。启动后插件即可用 comfyui_status 探测到本机。
REM  注意: 启动前建议先停矿 taskkill /F /IM pminer.exe
REM ============================================================
set PORT=%~1
if "%PORT%"=="" set PORT=8188

REM 停掉占卡的挖矿进程（存在才停）
taskkill /F /IM pminer.exe >nul 2>&1

cd /d D://ComfyUI
if errorlevel 1 (
  echo [ERROR] 找不到 D://ComfyUI，请修改本脚本中的路径。
  pause
  exit /b 1
)

if exist .venv\Scripts\python.exe (
  set PY=.venv\Scripts\python.exe
) else if exist venv\Scripts\python.exe (
  set PY=venv\Scripts\python.exe
) else (
  echo [ERROR] 找不到 venv，请检查 D://ComfyUI 下的虚拟环境。
  pause
  exit /b 1
)

echo Starting ComfyUI worker on port %PORT% ...
echo   地址: http://127.0.0.1:%PORT%
echo   局域网: http://%%COMPUTERNAME%%:%PORT%

REM 默认只听 127.0.0.1；若需跨机调用（如本机 dsh 调素材机），改成 0.0.0.0
set LISTEN=127.0.0.1
if "%~2"=="lan" set LISTEN=0.0.0.0

%%PY%% main.py --listen %%LISTEN%% --port %%PORT%% --cuda-device 0 --extra-model-paths-config D://ComfyUI//extra_model_paths.yaml

echo.
echo ComfyUI worker 已退出。
pause
