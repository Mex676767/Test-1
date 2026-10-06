param([string]$ProjectName = 'test-1')
$ErrorActionPreference = 'Stop'
$repoPath = Split-Path $PSScriptRoot -Parent
$releaseCommit = (git -C $repoPath rev-parse HEAD).Trim()
if ($LASTEXITCODE -ne 0) { throw 'Cannot resolve release commit' }
$releaseDir = Join-Path $env:TEMP ('widget-release-' + [guid]::NewGuid().ToString('N'))
$releaseZip = $releaseDir + '.zip'
git -C $repoPath archive --format=zip --output=$releaseZip HEAD
if ($LASTEXITCODE -ne 0) { throw 'Cannot archive release' }
Expand-Archive -LiteralPath $releaseZip -DestinationPath $releaseDir
$indexPath = Join-Path $releaseDir 'index.html'
$indexText = [IO.File]::ReadAllText($indexPath).Replace('name="widget-release" content="development"', 'name="widget-release" content="' + $releaseCommit + '"')
[IO.File]::WriteAllText($indexPath, $indexText)
[IO.File]::WriteAllText((Join-Path $releaseDir 'release.json'), (@{version=$releaseCommit} | ConvertTo-Json -Compress))
Push-Location $releaseDir
try {
  npx.cmd --yes wrangler pages deploy . --project-name $ProjectName --branch main --commit-hash $releaseCommit
  if ($LASTEXITCODE -ne 0) { throw 'Deployment failed' }
} finally { Pop-Location }
Write-Output "Release directory: $releaseDir"
