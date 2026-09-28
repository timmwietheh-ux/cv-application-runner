<# Regenerate the copyable project-root shortcut after moving the repository. #>
[CmdletBinding()]
param(
    # Empty means the repository that contains this script (resolved below,
    # since Windows PowerShell 5.1 has no $PSScriptRoot in parameter defaults).
    [string]$ProjectRoot = ''
)

$ErrorActionPreference = 'Stop'
$scriptDir = Split-Path -Parent $MyInvocation.MyCommand.Path
if (-not $ProjectRoot) { $ProjectRoot = Join-Path $scriptDir '..\..' }
$ProjectRoot = (Resolve-Path -LiteralPath $ProjectRoot).Path
$launcher = Join-Path $scriptDir 'start-background.vbs'
$shortcutPath = Join-Path $ProjectRoot 'LaTeX Runner CV Edition.lnk'
$wscript = Join-Path $env:SystemRoot 'System32\wscript.exe'
$icon = Join-Path $scriptDir 'static\img\latex-runner.ico'
if (-not (Test-Path -LiteralPath $icon)) { throw "Runner icon is missing: $icon" }

$shell = New-Object -ComObject WScript.Shell
$shortcut = $shell.CreateShortcut($shortcutPath)
$shortcut.TargetPath = $wscript
$shortcut.Arguments = "`"$launcher`" `"$ProjectRoot`""
$shortcut.WorkingDirectory = $ProjectRoot
$shortcut.Description = 'Open the CV and applications workspace in LaTeX Runner CV Edition'
$shortcut.IconLocation = "$icon,0"
$shortcut.Save()

Write-Output $shortcutPath
