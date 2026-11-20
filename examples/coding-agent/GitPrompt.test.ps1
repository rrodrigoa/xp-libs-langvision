$ErrorActionPreference = 'Stop'
$scriptPath = Join-Path $PSScriptRoot 'GitPrompt.ps1'
$fixture = Join-Path ([IO.Path]::GetTempPath()) ('lv-gitprompt-' + [guid]::NewGuid())
New-Item -ItemType Directory -Path $fixture | Out-Null
function Invoke-TestGit {
    & git @args
    if ($LASTEXITCODE -ne 0) { throw "git $args failed ($LASTEXITCODE)" }
}
function Assert-Prompt($Pattern) {
    $actual = prompt
    if ($actual -notmatch $Pattern) { throw "Expected $Pattern, got $actual" }
    Write-Output $actual
}
Push-Location $fixture
try {
    . $scriptPath
    $up = [char]0x2191
    $down = [char]0x2193
    Invoke-TestGit init --bare remote.git
    Invoke-TestGit init -b main repo
    Set-Location repo
    Assert-Prompt "\[repo, main\] \[$up\?, $down\?, =0\]"
    Invoke-TestGit config user.email test@example.invalid
    Invoke-TestGit config user.name 'Git Prompt Test'
    Set-Content seed.txt 'one'
    Invoke-TestGit add .
    Invoke-TestGit commit -m seed
    Invoke-TestGit remote add origin ../remote.git
    Invoke-TestGit push -u origin main
    Assert-Prompt "\[repo, main\] \[${up}0, ${down}0, =0\]"
    Set-Content seed.txt 'two'
    Invoke-TestGit commit -am ahead
    Set-Content seed.txt 'uncommitted'
    New-Item -ItemType Directory nested | Out-Null
    Set-Content nested/new.txt 'untracked'
    Set-Location nested
    Assert-Prompt "\[repo, main\] \[${up}1, ${down}0, dirty:2\]"
    Set-Location $fixture
    Invoke-TestGit clone --branch main ./remote.git peer
    Set-Location peer
    Invoke-TestGit config user.email test@example.invalid
    Invoke-TestGit config user.name 'Git Prompt Test'
    Set-Content peer.txt 'upstream'
    Invoke-TestGit add .
    Invoke-TestGit commit -m upstream
    Invoke-TestGit push
    Set-Location ../repo
    Invoke-TestGit fetch
    Assert-Prompt "\[repo, main\] \[${up}1, ${down}1, dirty:2\]"
    Invoke-TestGit checkout --detach
    Assert-Prompt "\[repo, detached:[a-f0-9]{7}\]"
    Set-Location $fixture
    if ((prompt) -match '^\[repo,') { throw 'A Git prompt leaked outside the repository.' }
}
finally {
    if (Get-Command Disable-LangVisionGitPrompt -ErrorAction SilentlyContinue) { Disable-LangVisionGitPrompt }
    Pop-Location
    $target = (Resolve-Path -LiteralPath $fixture).Path
    if ($target -ne $fixture -or (Split-Path -Leaf $target) -notmatch '^lv-gitprompt-[a-f0-9-]{36}$') { throw 'Unexpected cleanup target.' }
    Remove-Item -LiteralPath $target -Recurse -Force
}
