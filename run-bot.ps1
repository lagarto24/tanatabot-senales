# Arranca el bot de señales y lo reinicia si se cae. Lo lanza la tarea "Tanatabot Senales".
$dir = $PSScriptRoot
$bun = Join-Path $env:USERPROFILE ".bun\bin\bun.exe"
$log = Join-Path $dir "bot.log"
Set-Location $dir
while ($true) {
    if ((Test-Path $log) -and (Get-Item $log).Length -gt 5MB) { Move-Item $log "$log.old" -Force }
    "=== $(Get-Date) arrancando bot ===" | Out-File $log -Append -Encoding utf8
    cmd.exe /c "`"$bun`" signals.ts >> `"$log`" 2>&1"
    "=== $(Get-Date) el bot se detuvo (codigo $LASTEXITCODE), reinicio en 60 s ===" | Out-File $log -Append -Encoding utf8
    Start-Sleep 60
}
