# Starts Uptime Kuma (port 3001) and the Uptime Kuma MCP server (port 3005)
# as hidden background processes. Safe to run repeatedly: skips whatever is already running.
$ErrorActionPreference = "Stop"
$root = $PSScriptRoot
$logs = Join-Path $root "logs"
New-Item -ItemType Directory -Force $logs | Out-Null

function Test-Port($port) {
    [bool](Get-NetTCPConnection -LocalPort $port -State Listen -ErrorAction SilentlyContinue)
}

function Wait-Url($url, $seconds) {
    for ($i = 0; $i -lt $seconds; $i++) {
        try { Invoke-WebRequest $url -UseBasicParsing -TimeoutSec 2 | Out-Null; return $true } catch { Start-Sleep 1 }
    }
    return $false
}

if (Test-Port 3001) {
    Write-Host "Uptime Kuma already running on :3001"
} else {
    Start-Process node -ArgumentList "server/server.js" -WorkingDirectory "$root\uptime-kuma" -WindowStyle Hidden `
        -RedirectStandardOutput "$logs\uptime-kuma.log" -RedirectStandardError "$logs\uptime-kuma.err.log"
    if (Wait-Url "http://localhost:3001/api/entry-page" 180) { Write-Host "Uptime Kuma started: http://localhost:3001" }
    else { Write-Warning "Uptime Kuma did not answer within 180s - see $logs\uptime-kuma*.log" }
}

if (Test-Port 3005) {
    Write-Host "MCP server already running on :3005"
} else {
    Start-Process node -ArgumentList "--env-file=.env", "src/index.js" -WorkingDirectory "$root\uptime-kuma-mcp" -WindowStyle Hidden `
        -RedirectStandardOutput "$logs\mcp.log" -RedirectStandardError "$logs\mcp.err.log"
    if (Wait-Url "http://127.0.0.1:3005/health" 30) { Write-Host "MCP server started: http://127.0.0.1:3005/mcp" }
    else { Write-Warning "MCP server did not answer within 30s - see $logs\mcp*.log" }
}
