# Dot-source this file to enable the prompt for the current PowerShell session.
if (-not (Get-Command git -CommandType Application -ErrorAction SilentlyContinue)) {
    throw 'Git is not on PATH. Install Git for Windows before enabling GitPrompt.'
}

if (-not (Get-Variable LangVisionPreviousPrompt -Scope Global -ErrorAction SilentlyContinue)) {
    $global:LangVisionPreviousPrompt = (Get-Item Function:prompt).ScriptBlock
}

function global:prompt {
    $previousExit = $global:LASTEXITCODE
    # Windows PowerShell can surface redirected native stderr as a PowerShell error.
    $ErrorActionPreference = 'SilentlyContinue'
    $PSNativeCommandUseErrorActionPreference = $false
    try {
        if ((Get-Location).Provider.Name -ne 'FileSystem') {
            return & $global:LangVisionPreviousPrompt
        }
        $git = Get-Command git -CommandType Application -ErrorAction SilentlyContinue | Select-Object -First 1
        if (-not $git) { return & $global:LangVisionPreviousPrompt }
        $root = & $git.Source rev-parse --show-toplevel 2>$null
        if ($LASTEXITCODE -ne 0 -or -not $root) { return & $global:LangVisionPreviousPrompt }
        $repo = Split-Path -Leaf $root
        $status = & $git.Source --no-optional-locks status --porcelain=v2 --branch --untracked-files=all 2>$null
        if ($LASTEXITCODE -ne 0) { return & $global:LangVisionPreviousPrompt }

        $branch = 'unknown'
        $oid = ''
        $ahead = $behind = '?'
        $dirty = 0
        foreach ($line in $status) {
            if ($line -match '^# branch\.head (.+)$') { $branch = $Matches[1] }
            elseif ($line -match '^# branch\.oid (.+)$') { $oid = $Matches[1] }
            elseif ($line -match '^# branch\.ab \+(\d+) -(\d+)$') {
                $ahead = $Matches[1]
                $behind = $Matches[2]
            }
            elseif ($line -match '^[12u?] ') { $dirty++ }
        }
        if ($branch -eq '(detached)' -and $oid.Length -ge 7) {
            $branch = 'detached:' + $oid.Substring(0, 7)
        }
        $up = [char]0x2191
        $down = [char]0x2193
        $state = if ($dirty) { "dirty:$dirty" } else { '=0' }
        return "[$repo, $branch] [$up$ahead, $down$behind, $state]> "
    }
    finally {
        $global:LASTEXITCODE = $previousExit
    }
}

function global:Disable-LangVisionGitPrompt {
    Set-Item Function:global:prompt $global:LangVisionPreviousPrompt
    Remove-Variable LangVisionPreviousPrompt -Scope Global -ErrorAction SilentlyContinue
    Remove-Item Function:global:Disable-LangVisionGitPrompt
}
