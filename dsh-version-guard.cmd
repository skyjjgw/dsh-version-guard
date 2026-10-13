@echo off
rem ============================================================================
rem  DSH 版本守卫 · 离线恢复页
rem
rem  插件冲突导致 DSH 打不开时，双击本文件即可恢复。它不加载任何 DSH 代码，
rem  只需要一个 Node 可执行文件，所以 DSH 完全启动不了时它依然可用。
rem
rem  也可以直接传参数：
rem    dsh-version-guard.cmd --rescue --dry-run   先看看会退回哪一版
rem    dsh-version-guard.cmd --rescue             直接回退
rem    dsh-version-guard.cmd --status             查看版本状况
rem ============================================================================
setlocal EnableExtensions
set "VG_DIR=%~dp0"

rem --- 1. 用 DSH 自带的 Node（优先，避免用户没装 Node） ---------------------
set "VG_NODE="
for %%P in (
  "%VG_DIR%..\..\..\resources\runtime\primary-runtime\dependencies\node\bin\node.exe"
  "%VG_DIR%..\..\..\..\dsh-latest\resources\runtime\primary-runtime\dependencies\node\bin\node.exe"
  "E:\dsh-latest\resources\runtime\primary-runtime\dependencies\node\bin\node.exe"
  "%LOCALAPPDATA%\Programs\DeepSeek Harness\resources\runtime\primary-runtime\dependencies\node\bin\node.exe"
) do if not defined VG_NODE if exist %%P set "VG_NODE=%%~fP"

rem --- 2. 退回 PATH 上的 node -------------------------------------------------
if not defined VG_NODE for %%P in (node.exe) do set "VG_NODE=%%~$PATH:P"

if not defined VG_NODE (
  echo.
  echo   找不到 Node 运行时，无法启动离线恢复页。
  echo.
  echo   请任选一种方式：
  echo     1. 安装 Node.js 22 或更高版本后重试；
  echo     2. 用记事本打开本文件，把下面这行的路径改成你的 DeepSeek Harness 安装目录：
  echo        E:\dsh-latest\resources\runtime\primary-runtime\dependencies\node\bin\node.exe
  echo.
  pause
  exit /b 1
)

"%VG_NODE%" "%VG_DIR%lib\bin\version-guard.js" %*
set "VG_CODE=%ERRORLEVEL%"

rem 出错时留住窗口，方便看到原因；正常退出也停一下，避免双击后窗口一闪而过。
if not "%VG_CODE%"=="0" (
  echo.
  echo   版本守卫退出码：%VG_CODE%
  pause
) else (
  if "%~1"=="" pause
)
exit /b %VG_CODE%
