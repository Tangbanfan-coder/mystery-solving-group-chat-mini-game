# 启动本地游戏服务
$ErrorActionPreference = 'Stop'
Set-Location -LiteralPath $PSScriptRoot

$key = [Environment]::GetEnvironmentVariable('role-playing-key', 'User')
if (-not $key) {
  Write-Host '没有找到环境变量 role-playing-key，请先设置它。' -ForegroundColor Yellow
  exit 1
}

$env:ROLE_PLAYING_KEY = $key
$env:PORT = '5178'

Write-Host ''
Write-Host '  日出小队 · 正在启动' -ForegroundColor Green
Write-Host '  打开浏览器访问: http://127.0.0.1:5178' -ForegroundColor Cyan
Write-Host '  关掉这个窗口就停止服务（进度会丢）' -ForegroundColor DarkGray
Write-Host ''

node server.js
