<#
.SYNOPSIS
  DSH 版本守卫 · 离线恢复页（PowerShell 启动器）

.DESCRIPTION
  插件冲突导致 DSH 打不开时，运行本脚本即可打开离线恢复页并回退版本。
  它不加载任何 DSH 代码，只需要一个 Node 可执行文件。

.EXAMPLE
  .\dsh-version-guard.ps1
  打开恢复页（自动打开浏览器）。

.EXAMPLE
  .\dsh-version-guard.ps1 -Rescue -DryRun
  只报告会回退到哪一版，不做任何修改。

.EXAMPLE
  .\dsh-version-guard.ps1 -Rescue
  直接回退到最近一次成功启动的版本。

.EXAMPLE
  .\dsh-version-guard.ps1 -Status
  打印当前 profile 的插件版本与启动健康状况。
#>
[CmdletBinding()]
param(
  [switch]$List,
  [switch]$Status,
  [switch]$Snapshot,
  [switch]$Rescue,
  [switch]$DryRun,
  [switch]$Install,
  [string]$Profile,
  [int]$Port,
  [string]$HostAddress,
  [switch]$NoOpen,
  [string]$NodePath
)

$ErrorActionPreference = 'Stop'
$here = Split-Path -Parent $MyInvocation.MyCommand.Path

function Find-Node {
  param([string]$Explicit)
  $candidates = @()
  if ($Explicit) { $candidates += $Explicit }
  $candidates += @(
    (Join-Path $here '..\..\..\resources\runtime\primary-runtime\dependencies\node\bin\node.exe'),
    (Join-Path $here '..\..\..\..\dsh-latest\resources\runtime\primary-runtime\dependencies\node\bin\node.exe'),
    'E:\dsh-latest\resources\runtime\primary-runtime\dependencies\node\bin\node.exe',
    (Join-Path $env:LOCALAPPDATA 'Programs\DeepSeek Harness\resources\runtime\primary-runtime\dependencies\node\bin\node.exe'),
    (Join-Path $env:ProgramFiles 'DeepSeek Harness\resources\runtime\primary-runtime\dependencies\node\bin\node.exe')
  )
  foreach ($candidate in $candidates) {
    if ($candidate -and (Test-Path -LiteralPath $candidate -PathType Leaf)) {
      return (Resolve-Path -LiteralPath $candidate).Path
    }
  }
  $onPath = Get-Command node -ErrorAction SilentlyContinue
  if ($onPath) { return $onPath.Source }
  return $null
}

$node = Find-Node -Explicit $NodePath
if (-not $node) {
  Write-Host ''
  Write-Host '  找不到 Node 运行时，无法启动离线恢复页。' -ForegroundColor Red
  Write-Host ''
  Write-Host '  请任选一种方式：'
  Write-Host '    1. 安装 Node.js 22 或更高版本后重试；'
  Write-Host '    2. 用 -NodePath 指定可执行文件，例如：'
  Write-Host '       .\dsh-version-guard.ps1 -NodePath "D:\node\node.exe"'
  Write-Host ''
  exit 1
}

$entry = Join-Path $here 'lib\bin\version-guard.js'
if (-not (Test-Path -LiteralPath $entry -PathType Leaf)) {
  Write-Host "  找不到入口文件：$entry" -ForegroundColor Red
  exit 1
}

$arguments = @($entry)
if ($List) { $arguments += '--list' }
if ($Status) { $arguments += '--status' }
if ($Snapshot) { $arguments += '--snapshot' }
if ($Rescue) { $arguments += '--rescue' }
if ($DryRun) { $arguments += '--dry-run' }
if ($Install) { $arguments += '--install' }
if ($Profile) { $arguments += @('--profile', $Profile) }
if ($Port -gt 0) { $arguments += @('--port', "$Port") }
if ($HostAddress) { $arguments += @('--host', $HostAddress) }
if ($NoOpen) { $arguments += '--no-open' }

& $node @arguments
exit $LASTEXITCODE
