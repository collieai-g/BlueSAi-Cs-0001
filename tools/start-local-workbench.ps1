param([int]$Port = 3101)
$ErrorActionPreference = 'Stop'
$projectDir = Split-Path $PSScriptRoot -Parent
$runtimeExe = Join-Path $env:LOCALAPPDATA 'Programs\REA\runtime\node-v24.22.0-win-x64\node.exe'
if (-not (Test-Path -LiteralPath $runtimeExe)) { $runtimeExe = (Get-Command node -ErrorAction Stop).Source }
$runtimeVersion = & $runtimeExe -p 'process.versions.node'
if ($runtimeVersion -notmatch '^24\.' -or [version]$runtimeVersion -lt [version]'24.22.0') { throw '需要 Node.js 24.22 或更新的 24.x。' }
$dataPath = Join-Path $env:USERPROFILE '.bluesai-local-workbench'
if (-not (Test-Path -LiteralPath $dataPath)) {
  New-Item -ItemType Directory -Path $dataPath | Out-Null
  $acl = Get-Acl -LiteralPath $dataPath
  $acl.SetAccessRuleProtection($true, $false)
  $identity = [System.Security.Principal.WindowsIdentity]::GetCurrent().Name
  $rule = New-Object System.Security.AccessControl.FileSystemAccessRule($identity, 'FullControl', 'ContainerInherit,ObjectInherit', 'None', 'Allow')
  $acl.AddAccessRule($rule)
  Set-Acl -LiteralPath $dataPath -AclObject $acl
}
if (Test-Path -LiteralPath (Join-Path $dataPath 'service.lock')) { throw '本機工作台資料已被程序鎖定。請先核對正在運行的工作台，不要直接刪除鎖檔。' }
$env:BLUESAI_WORKBENCH_DATA = $dataPath
$env:BLUESAI_WORKBENCH_PORT = [string]$Port
$service = Start-Process -FilePath $runtimeExe -ArgumentList @('src/workbench.js') -WorkingDirectory $projectDir -WindowStyle Hidden -RedirectStandardOutput (Join-Path $dataPath 'startup.log') -RedirectStandardError (Join-Path $dataPath 'startup-error.log') -PassThru
Write-Output "本機工作台程序：$($service.Id)；網址：http://127.0.0.1:$Port"
