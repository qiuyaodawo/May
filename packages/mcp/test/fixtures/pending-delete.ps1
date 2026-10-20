param([Parameter(Mandatory = $true)][string]$TargetPath)
$ErrorActionPreference = "Stop"
Add-Type -Path (Join-Path $PSScriptRoot "pending-delete.cs")
[PendingDelete]::Hold($TargetPath)
