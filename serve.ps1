# Zero-install static server for Signal-Collab PoC (Windows PowerShell built-in).
# Run as Administrator (needed to listen on the LAN interface):
#   Right-click this file -> Run with PowerShell (as admin), or in an admin PowerShell:
#   powershell -ExecutionPolicy Bypass -File .\serve.ps1
param([int]$Port = 8080)

$root = $PSScriptRoot
# allow inbound connections on this port (idempotent)
netsh advfirewall firewall add rule name="signal-collab-$Port" dir=in action=allow protocol=TCP localport=$Port | Out-Null

$listener = New-Object System.Net.HttpListener
$listener.Prefixes.Add("http://+:$Port/")
$listener.Start()

$ips = (Get-NetIPAddress -AddressFamily IPv4 | Where-Object { $_.IPAddress -notlike '127.*' -and $_.IPAddress -notlike '169.254.*' }).IPAddress
Write-Host ""
Write-Host "Serving $root"
foreach ($ip in $ips) { Write-Host ("  phone/Keychat -> http://" + $ip + ":$Port") -ForegroundColor Green }
Write-Host "  this PC       -> http://localhost:$Port"
Write-Host "Press Ctrl+C to stop."
Write-Host ""

while ($listener.IsListening) {
  try {
    $ctx = $listener.GetContext()
    $path = $ctx.Request.Url.LocalPath.TrimStart('/')
    if ([string]::IsNullOrWhiteSpace($path)) { $path = 'index.html' }
    $file = Join-Path $root $path
    if ((Test-Path $file) -and -not (Get-Item $file).PSIsContainer) {
      $bytes = [IO.File]::ReadAllBytes($file)
      $ext = [IO.Path]::GetExtension($file).ToLower()
      $ctx.Response.ContentType = switch ($ext) {
        '.html' { 'text/html; charset=utf-8' }
        '.js'   { 'text/javascript; charset=utf-8' }
        '.css'  { 'text/css; charset=utf-8' }
        '.json' { 'application/json' }
        default { 'application/octet-stream' }
      }
      $ctx.Response.ContentLength64 = $bytes.Length
      $ctx.Response.OutputStream.Write($bytes, 0, $bytes.Length)
    } else {
      $ctx.Response.StatusCode = 404
    }
    $ctx.Response.Close()
  } catch { }
}
