# Stops whatever is listening on the Uptime Kuma (3001) and MCP (3005) ports.
foreach ($port in 3001, 3005) {
    $conns = Get-NetTCPConnection -LocalPort $port -State Listen -ErrorAction SilentlyContinue
    foreach ($procId in ($conns.OwningProcess | Sort-Object -Unique)) {
        Stop-Process -Id $procId -Force
        Write-Host "Stopped PID $procId (port $port)"
    }
}
