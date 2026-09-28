<#
.SYNOPSIS
    Start LaTeX Runner without a console window and open its browser app.

.DESCRIPTION
    Intended as the target of the copyable "LaTeX Runner CV Edition.lnk" shortcut in the
    project root. An already running instance is reused. Otherwise the local
    Python server is started hidden, its health endpoint is awaited, and only
    then is the browser opened.
#>
[CmdletBinding()]
param(
    # Empty means the repository that contains this script. The default is
    # resolved below because Windows PowerShell 5.1, which the shortcut uses,
    # leaves $PSScriptRoot empty inside parameter defaults.
    [string]$ProjectRoot = '',
    [int]$Port = 8053,
    [switch]$NoBrowser
)

$ErrorActionPreference = 'Stop'
$scriptDir = Split-Path -Parent $MyInvocation.MyCommand.Path
if (-not $ProjectRoot) { $ProjectRoot = Join-Path $scriptDir '..\..' }
$url = "http://127.0.0.1:$Port"
$serverScript = Join-Path $scriptDir 'server.py'
$httpClient = $null

function Show-RunnerError([string]$Message) {
    try {
        Add-Type -AssemblyName PresentationFramework
        [System.Windows.MessageBox]::Show(
            $Message,
        'LaTeX Runner CV Edition',
            [System.Windows.MessageBoxButton]::OK,
            [System.Windows.MessageBoxImage]::Error
        ) | Out-Null
    } catch {
        # The background launcher has no console. The log remains available.
    }
}

function Get-LogTail([string]$Path) {
    try {
        $lines = Get-Content -LiteralPath $Path -Tail 6 -ErrorAction Stop
        return (($lines | Where-Object { $_ }) -join "`n").Trim()
    } catch {
        return ''
    }
}

function Get-RunnerHealth {
    try {
        $json = $httpClient.GetStringAsync("$url/api/health").GetAwaiter().GetResult()
        return $json | ConvertFrom-Json
    } catch {
        return $null
    }
}

function Find-Chrome {
    $candidates = @(
        (Join-Path ${env:ProgramFiles} 'Google\Chrome\Application\chrome.exe'),
        (Join-Path ${env:ProgramFiles(x86)} 'Google\Chrome\Application\chrome.exe'),
        (Join-Path $env:LOCALAPPDATA 'Google\Chrome\Application\chrome.exe')
    )
    foreach ($candidate in $candidates) {
        if ($candidate -and (Test-Path -LiteralPath $candidate)) { return $candidate }
    }
    $command = Get-Command chrome.exe -ErrorAction SilentlyContinue
    if ($command) { return $command.Source }
    return $null
}

function Open-RunnerBrowser {
    $chrome = Find-Chrome
    if ($chrome) {
        Start-Process -FilePath $chrome -ArgumentList "--app=$url"
    } else {
        Start-Process $url
    }
}

try {
    # Inside the try: without a console, an error here would otherwise vanish.
    Add-Type -AssemblyName System.Net.Http
    $httpHandler = New-Object System.Net.Http.HttpClientHandler
    $httpHandler.UseProxy = $false
    $httpClient = New-Object System.Net.Http.HttpClient($httpHandler)
    $httpClient.Timeout = [TimeSpan]::FromMilliseconds(900)

    $resolvedRoot = (Resolve-Path -LiteralPath $ProjectRoot).Path
    $health = Get-RunnerHealth
    if ($health) {
        if ($health.app -ne 'latex-runner' -or
            -not [string]::Equals((Resolve-Path -LiteralPath $health.root).Path, $resolvedRoot,
                [System.StringComparison]::OrdinalIgnoreCase)) {
            Show-RunnerError "Port $Port is already used by another application or project."
            exit 1
        }
        if (-not $NoBrowser) { Open-RunnerBrowser }
        exit 0
    }

    if (-not (Test-Path -LiteralPath $serverScript)) {
        throw "Server script not found: $serverScript"
    }

    $venvPythonw = Join-Path $resolvedRoot '.venv\Scripts\pythonw.exe'
    $venvPython = Join-Path $resolvedRoot '.venv\Scripts\python.exe'
    $python = $null
    if (Test-Path -LiteralPath $venvPythonw) {
        $python = [pscustomobject]@{ Source = $venvPythonw }
    } elseif (Test-Path -LiteralPath $venvPython) {
        $python = [pscustomobject]@{ Source = $venvPython }
    }
    if (-not $python) {
        $python = Get-Command pythonw.exe -All -ErrorAction SilentlyContinue |
            Where-Object { $_.Source -notlike '*\Microsoft\WindowsApps\*' } | Select-Object -First 1
    }
    if (-not $python) {
        $python = Get-Command python.exe -All -ErrorAction SilentlyContinue |
            Where-Object { $_.Source -notlike '*\Microsoft\WindowsApps\*' } | Select-Object -First 1
    }
    if (-not $python) { throw 'Python 3 was not found in PATH.' }

    $logDir = Join-Path $resolvedRoot 'build\runner'
    New-Item -ItemType Directory -Path $logDir -Force | Out-Null
    # One log pair per port: a second runner (another port) must not collide
    # with the files the first one still holds open.
    $stdout = Join-Path $logDir "server-$Port.log"
    $stderr = Join-Path $logDir "server-$Port-error.log"
    $arguments = @(
        ('"{0}"' -f $serverScript),
        '--root', ('"{0}"' -f $resolvedRoot),
        '--port', [string]$Port
    )
    $server = Start-Process -FilePath $python.Source -ArgumentList $arguments -WorkingDirectory $resolvedRoot `
        -WindowStyle Hidden -RedirectStandardOutput $stdout -RedirectStandardError $stderr -PassThru
    $null = $server.Handle  # keeps ExitCode readable after the process ends

    $deadline = [DateTime]::UtcNow.AddSeconds(15)
    do {
        Start-Sleep -Milliseconds 200
        $health = Get-RunnerHealth
        # A server that exits at once (import error, port taken) cannot become
        # ready; report it now instead of after the full timeout.
        if (-not $health -and $server.HasExited) { break }
    } until ($health -or [DateTime]::UtcNow -ge $deadline)

    if (-not $health) {
        $reason = (Get-LogTail $stderr)
        if (-not $reason) { $reason = (Get-LogTail $stdout) }
        $message = "The local server did not become ready."
        if ($server.HasExited) { $message = "The local server stopped with exit code $($server.ExitCode)." }
        if ($reason) { $message += "`n`n$reason" }
        throw "$message`n`nLogs: $logDir"
    }
    if (-not $NoBrowser) { Open-RunnerBrowser }
} catch {
    Show-RunnerError $_.Exception.Message
    exit 1
}
