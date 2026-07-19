# HTTPS static server for Signal-Collab PoC — zero install, Windows built-ins only.
# Creates a self-signed cert for your LAN IPs, binds it to the port via http.sys,
# exports the cert so you can trust it on the phone.
#
# Run in an *Administrator* PowerShell:
#   powershell -ExecutionPolicy Bypass -File .\serve-https.ps1
param([int]$Port = 8443)

$root = $PSScriptRoot
$ErrorActionPreference = 'Stop'

# --- LAN IPs ---
$ips = (Get-NetIPAddress -AddressFamily IPv4 | Where-Object {
  $_.IPAddress -notlike '127.*' -and $_.IPAddress -notlike '169.254.*' }).IPAddress

# --- self-signed cert (reused across runs) ---
$cert = Get-ChildItem Cert:\LocalMachine\My | Where-Object { $_.FriendlyName -eq 'signal-collab-dev' } | Select-Object -First 1
if (-not $cert) {
  $names = @('localhost') + $ips
  $cert = New-SelfSignedCertificate -DnsName $names -FriendlyName 'signal-collab-dev' `
    -CertStoreLocation Cert:\LocalMachine\My -NotAfter (Get-Date).AddYears(2) `
    -KeyExportPolicy Exportable -KeyAlgorithm RSA -KeyLength 2048
  Write-Host "Created self-signed cert for: $($names -join ', ')"
}

# export public cert so the phone can trust it (Android: Settings > Security > Install certificate)
Export-Certificate -Cert $cert -FilePath (Join-Path $root 'signal-collab-dev.cer') -Force | Out-Null

# --- bind cert to port via http.sys ---
$appid = '{7f3a2c11-9b64-4c22-8e1a-signalcollab1}'.Replace('signalcollab1','000000000001')
netsh http delete sslcert ipport=0.0.0.0:$Port 2>$null | Out-Null
netsh http add sslcert ipport=0.0.0.0:$Port certhash=$($cert.Thumbprint) appid=$appid | Out-Null

# --- firewall ---
netsh advfirewall firewall add rule name="signal-collab-https-$Port" dir=in action=allow protocol=TCP localport=$Port | Out-Null

# --- serve ---
$listener = New-Object System.Net.HttpListener
$listener.Prefixes.Add("https://+:$Port/")
$listener.Start()

Write-Host ""
Write-Host "Serving $root over HTTPS (self-signed)"
foreach ($ip in $ips) { Write-Host ("  phone/Keychat -> https://" + $ip + ":$Port") -ForegroundColor Green }
Write-Host "  this PC       -> https://localhost:$Port"
Write-Host ""
Write-Host "Phone will warn about the certificate. Either proceed past the warning (Chrome),"
Write-Host "or install signal-collab-dev.cer (exported next to this script) on the phone first."
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
        '.cer'  { 'application/x-x509-ca-cert' }
        default { 'application/octet-stream' }
      }
      $ctx.Response.ContentLength64 = $bytes.Length
      $ctx.Response.OutputStream.Write($bytes, 0, $bytes.Length)
    } else { $ctx.Response.StatusCode = 404 }
    $ctx.Response.Close()
  } catch { }
}
