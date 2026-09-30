param([string[]] $Tests = @(
    'packages/ui/tui/test/terminal/system-clipboard.test.mjs',
    'packages/ui/tui/test/terminal/editor-clipboard.test.mjs',
    'packages/ui/tui/test/terminal/maybecode-selection.test.mjs'
))

$ErrorActionPreference = 'Stop'
if ([System.Environment]::OSVersion.Platform -ne [System.PlatformID]::Win32NT) {
    throw 'This clipboard validation script requires Windows.'
}
if ([System.Threading.Thread]::CurrentThread.GetApartmentState() -ne [System.Threading.ApartmentState]::STA) {
    throw 'Start this script with powershell -NoProfile -STA -File scripts/test-terminal-clipboard.ps1.'
}
Add-Type -AssemblyName System.Windows.Forms
Add-Type -AssemblyName System.Drawing
$clipboardData = [System.Windows.Forms.Clipboard]::GetDataObject()
$snapshot = New-Object System.Windows.Forms.DataObject
$resources = New-Object System.Collections.Generic.List[System.IDisposable]
$formats = @()
if ($null -ne $clipboardData) {
    $formats = $clipboardData.GetFormats($false)
    foreach ($format in $formats) {
        $value = $clipboardData.GetData($format, $false)
        if ($null -eq $value) { throw "Cannot preserve clipboard format: $format" }
        if ($value -is [System.Drawing.Bitmap]) {
            $value = $value.Clone()
            $resources.Add($value)
        } elseif ($value -is [System.IO.MemoryStream]) {
            $value = New-Object System.IO.MemoryStream(,$value.ToArray())
            $resources.Add($value)
        } elseif ($value -is [byte[]] -or $value -is [string[]]) {
            $value = $value.Clone()
        } elseif ($value -isnot [string] -and $value.GetType().IsPrimitive -eq $false) {
            throw "Cannot preserve clipboard format $format with type $($value.GetType().FullName)"
        }
        $snapshot.SetData($format, $false, $value)
    }
}
$previousMode = $env:MAY_TEST_SYSTEM_CLIPBOARD
$resultCode = 1
Push-Location (Split-Path -Parent $PSScriptRoot)
try {
    [System.Windows.Forms.Clipboard]::SetText('MaybeCode clipboard verification baseline')
    $env:MAY_TEST_SYSTEM_CLIPBOARD = '1'
    & node --test --test-concurrency=1 @Tests
    $resultCode = $LASTEXITCODE
} finally {
    try {
        if ($formats.Count -eq 0) {
            [System.Windows.Forms.Clipboard]::Clear()
        } else {
            [System.Windows.Forms.Clipboard]::SetDataObject($snapshot, $true)
        }
    } finally {
        $env:MAY_TEST_SYSTEM_CLIPBOARD = $previousMode
        foreach ($resource in $resources) { $resource.Dispose() }
        Pop-Location
    }
}
exit $resultCode
