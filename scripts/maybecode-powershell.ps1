function global:pnpm {
    if ($args.Count -gt 0 -and $args[0] -eq 'maybecode') {
        $mayEntry = Join-Path $PSScriptRoot '../apps/maybecode/dist/bin.js'
        if (-not (Test-Path -LiteralPath $mayEntry -PathType Leaf)) {
            throw "Build required: pnpm --dir `"$(Split-Path $PSScriptRoot -Parent)`" build"
        }
        $mayArguments = @($args | Select-Object -Skip 1)
        if ($MyInvocation.ExpectingInput) {
            $input | & node $mayEntry @mayArguments
        } else {
            & node $mayEntry @mayArguments
        }
        $global:LASTEXITCODE = $LASTEXITCODE
        return
    }

    $mayPnpm = Get-Command pnpm.cmd -CommandType Application -ErrorAction Stop | Select-Object -First 1
    if ($MyInvocation.ExpectingInput) {
        $input | & $mayPnpm.Source @args
    } else {
        & $mayPnpm.Source @args
    }
    $global:LASTEXITCODE = $LASTEXITCODE
}
