<#
.SYNOPSIS
    在 Windows 上安装 Docker（Docker Desktop + WSL2 后端），并可选拉起本仓库的容器栈。
.DESCRIPTION
    必须以「管理员」身份运行（右键 -> 使用 PowerShell 运行 -> 以管理员身份运行）。
    原因：
      - 启用 WSL2 / 虚拟机平台需要管理员权限；
      - Docker Desktop 安装与守护进程需要管理员权限。
    当前沙箱里的 Agent 会话是非管理员、且无图形界面，无法在此自动完成安装，
    因此本脚本是给你（本机管理员）在本机一键执行的方案。
.NOTES
    执行前请确认：
      1. 当前用户属于 Administrators；
      2. 机器支持并允许 WSL2 / Hyper-V（Windows 10 21H2+ / Windows 11）；
      3. 安装后如需，按提示重启一次。
#>

$ErrorActionPreference = 'Stop'

# ---------- 0. 管理员自检 ----------
$current = [System.Security.Principal.WindowsIdentity]::GetCurrent()
$principal = New-Object System.Security.Principal.WindowsPrincipal($current)
if (-not $principal.IsInRole([System.Security.Principal.WindowsBuiltInRole]::Administrator)) {
    Write-Host "[错误] 请以管理员身份运行本脚本。" -ForegroundColor Red
    Write-Host "右键本文件 -> 使用 PowerShell 运行 -> 以管理员身份运行。" -ForegroundColor Yellow
    Read-Host "按回车退出"
    exit 1
}
Write-Host "[OK] 已确认为管理员。" -ForegroundColor Green

# ---------- 1. 启用 WSL2 + 虚拟机平台 ----------
Write-Host "[1/4] 启用 WSL2 与虚拟机平台特性..." -ForegroundColor Cyan
dism.exe /online /enable-feature /featurename:Microsoft-Windows-Subsystem-Linux /all /norestart | Out-Null
dism.exe /online /enable-feature /featurename:VirtualMachinePlatform /all /norestart | Out-Null
wsl --update
wsl --set-default-version 2
Write-Host "[OK] WSL2 特性已启用（如提示需重启，请安装完成后重启一次）。" -ForegroundColor Green

# ---------- 2. 安装 Docker Desktop（含 WSL2 后端） ----------
Write-Host "[2/4] 通过 winget 安装 Docker Desktop（静默）..." -ForegroundColor Cyan
winget install Docker.DockerDesktop --silent --accept-package-agreements --accept-source-agreements --disable-interactivity
if ($LASTEXITCODE -ne 0) {
    Write-Host "[警告] winget 安装返回非零（$LASTEXITCODE）。若已安装可忽略；否则请手动从 https://www.docker.com/products/docker-desktop 安装。" -ForegroundColor Yellow
} else {
    Write-Host "[OK] Docker Desktop 安装完成。" -ForegroundColor Green
}

# ---------- 3. 等待 Docker 守护进程就绪（需先启动 Docker Desktop） ----------
Write-Host "[3/4] 等待 Docker 守护进程就绪（请先手动启动 Docker Desktop，首次会初始化 WSL2）..." -ForegroundColor Cyan
$docker = "$env:ProgramFiles\Docker\Docker\Docker Desktop.exe"
if (Test-Path $docker) { Start-Process $docker } else { Write-Host "[提示] 未找到 Docker Desktop 可执行文件，请手动启动。" -ForegroundColor Yellow }

$ready = $false
for ($i = 0; $i -lt 60; $i++) {
    if (Get-Command docker -ErrorAction SilentlyContinue) {
        $info = docker info 2>&1
        if ($LASTEXITCODE -eq 0) { $ready = $true; break }
    }
    Start-Sleep -Seconds 5
}
if (-not $ready) {
    Write-Host "[提示] 守护进程尚未就绪。请启动 Docker Desktop 并在其设置中确认已勾选 'Use the WSL 2 based engine'，等待初始化完成后重新运行本脚本的剩余步骤。" -ForegroundColor Yellow
    Read-Host "按回车退出"
    exit 0
}
Write-Host "[OK] Docker 守护进程已就绪：`docker --version`" -ForegroundColor Green
docker --version

# ---------- 4. 拉起本仓库容器栈（docker-compose.yml） ----------
$repoRoot = Resolve-Path (Join-Path $PSScriptRoot '..')
$compose = Join-Path $repoRoot 'docker-compose.yml'
if (Test-Path $compose) {
    Write-Host "[4/4] 在 $repoRoot 执行 docker compose up -d ..." -ForegroundColor Cyan
    Push-Location $repoRoot
    docker compose up -d
    Pop-Location
    Write-Host "[OK] 容器栈已启动。可用 'docker compose ps' 查看状态。" -ForegroundColor Green
} else {
    Write-Host "[提示] 未找到 docker-compose.yml，跳过启动。" -ForegroundColor Yellow
}

Write-Host "全部完成。" -ForegroundColor Green
Read-Host "按回车退出"
