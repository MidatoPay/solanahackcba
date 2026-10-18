param(
  [ValidateSet('setup', 'check', 'start')]
  [string]$Action = 'check'
)

$ErrorActionPreference = 'Stop'
$PSNativeCommandUseErrorActionPreference = $false
$projectRoot = [System.IO.Path]::GetFullPath((Join-Path $PSScriptRoot '..'))
$ngrokLocalRoot = Join-Path $projectRoot '.netlify/tools/ngrok'
$ngrokExe = Join-Path $ngrokLocalRoot 'ngrok.exe'
$ngrokConfig = Join-Path $projectRoot '.netlify/ngrok-colombia.yml'

try {
  if (-not [System.Runtime.InteropServices.RuntimeInformation]::IsOSPlatform([System.Runtime.InteropServices.OSPlatform]::Windows) -or
      [System.Runtime.InteropServices.RuntimeInformation]::OSArchitecture -ne 'X64') {
    throw 'Este instalador local es para Windows x64. En otros sistemas usa la instalación oficial y la guía ONEPAY_WEBHOOK_LOCAL.md.'
  }
  if ($Action -eq 'setup') {
    New-Item -ItemType Directory -Path $ngrokLocalRoot -Force | Out-Null
    if (-not (Test-Path -LiteralPath $ngrokExe)) {
      # Official standalone download linked from https://ngrok.com/download/windows.
      $ngrokArchive = Join-Path $ngrokLocalRoot 'ngrok-windows-amd64.zip'
      Invoke-WebRequest -Uri 'https://bin.ngrok.com/c/bNyj1mQVY4c/ngrok-v3-stable-windows-amd64.zip' -OutFile $ngrokArchive
      Expand-Archive -LiteralPath $ngrokArchive -DestinationPath $ngrokLocalRoot
    }
    if (-not (Test-Path -LiteralPath $ngrokConfig)) {
      Copy-Item -LiteralPath (Join-Path $projectRoot 'config/ngrok.colombia.example.yml') -Destination $ngrokConfig
    }
  }
  if (-not (Test-Path -LiteralPath $ngrokExe)) { throw 'Ejecuta npm run ngrok:setup antes de usar ngrok local.' }
  $ngrokSignature = Get-AuthenticodeSignature -LiteralPath $ngrokExe
  $ngrokPublisher = if ($ngrokSignature.SignerCertificate) {
    $ngrokSignature.SignerCertificate.GetNameInfo([System.Security.Cryptography.X509Certificates.X509NameType]::SimpleName, $false)
  } else { '' }
  if ($ngrokSignature.Status -ne 'Valid' -or $ngrokPublisher -ne 'ngrok, Inc.') {
    throw 'No se pudo verificar la firma oficial de ngrok. El ejecutable no se inició.'
  }
  if ($Action -eq 'setup') {
    & $ngrokExe version
    if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }
    Write-Output 'ngrok local preparado. La configuración privada existente se conservó.'
    exit 0
  }
  if (-not (Test-Path -LiteralPath $ngrokConfig)) { throw 'Ejecuta npm run ngrok:setup para preparar la configuración local.' }
  $ngrokConfigText = [System.IO.File]::ReadAllText($ngrokConfig)
  $ngrokToken = ''
  if ($ngrokConfigText -match '(?m)^\s*authtoken:\s*(?<token>[^\r\n]+)') {
    $ngrokToken = $Matches['token'].Trim().Trim('"').Trim("'")
  }
  if ($Action -eq 'start' -and ($ngrokToken -like 'REEMPLAZAR*' -or $ngrokToken -notmatch '^[A-Za-z0-9_]{20,200}$' -or $ngrokToken -match '^(sk_|whsec_|whtok_)')) {
    throw 'Completa el authtoken del agente ngrok en .netlify/ngrok-colombia.yml; no es una clave de OnePay.'
  }
  # The selected developer config takes priority over an inherited account token.
  if ($Action -eq 'start') { $env:NGROK_AUTHTOKEN = $ngrokToken }
  $ngrokArgs = if ($Action -eq 'check') {
    @('config', 'check', '--config', $ngrokConfig)
  } else {
    @('start', 'onepay-colombia', '--config', $ngrokConfig, '--log', 'stdout', '--log-format', 'json')
  }
  & $ngrokExe @ngrokArgs 2>&1 | ForEach-Object {
    $ngrokLine = [string]$_
    if ($ngrokToken) { $ngrokLine = $ngrokLine.Replace($ngrokToken, '[redacted]') }
    Write-Output $ngrokLine
  }
  exit $LASTEXITCODE
} catch {
  # Operational messages only; never print the YAML or credentials.
  Write-Output $_.Exception.Message
  exit 1
}
