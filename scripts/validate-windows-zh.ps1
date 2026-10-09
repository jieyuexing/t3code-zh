# 仅在获准的 Windows 隔离根内运行。材料由最终 NSIS 提取；不运行安装器或 GUI。
param([Parameter(Mandatory=$true)][string]$Materials,[Parameter(Mandatory=$true)][string]$Output,[Parameter(Mandatory=$true)][string]$ExpectedMaterialsSha256)
$ErrorActionPreference='Stop'
$ProgressPreference='SilentlyContinue'
function Hash($File) { (Get-FileHash -Algorithm SHA256 -LiteralPath $File).Hash.ToLower() }
function Identity($File,$Relative) { @{path=$Relative;bytes=(Get-Item -LiteralPath $File).Length;sha256=(Hash $File)} }
function WriteJson($File,$Value) { [IO.File]::WriteAllText($File,($Value | ConvertTo-Json -Depth 30),(New-Object Text.UTF8Encoding($false))) }
function CheckAncestors($Directory) {
 $items=@();$cursor=$Directory
 while($cursor){
  $item=Get-Item -LiteralPath $cursor -Force
  $reparse=[bool]($item.Attributes -band [IO.FileAttributes]::ReparsePoint)
  $hasModules=Test-Path -LiteralPath (Join-Path $cursor 'node_modules')
  $items+=@{path=$cursor;nodeModules=$hasModules;reparse=$reparse}
  if($reparse -or $hasModules){throw 'Ancestor isolation failed'}
  $next=Split-Path $cursor -Parent;if($next -eq $cursor){break};$cursor=$next
 }
 return $items
}
$Materials=[IO.Path]::GetFullPath($Materials);$Output=[IO.Path]::GetFullPath($Output)
$manifestFile=Join-Path $Materials 'materials.json'
if((Hash $manifestFile) -ne $ExpectedMaterialsSha256){throw 'Material manifest hash mismatch'}
$manifest=Get-Content -Raw -LiteralPath $manifestFile | ConvertFrom-Json
if($manifest.schema -ne 1 -or $manifest.candidate.kind -ne 'nsis' -or $manifest.candidate.platform -ne 'win32' -or $manifest.candidate.arch -ne 'x64'){throw 'Wrong candidate identity'}
if(-not [Environment]::Is64BitOperatingSystem){throw 'Windows x64 required'}
if(Test-Path -LiteralPath $Output){throw 'Output already exists; inspect old receipts before retry'}
$ancestors=@(CheckAncestors $Materials)+@(CheckAncestors (Split-Path $Output -Parent))
function VerifyMaterials {
 if((Hash $manifestFile) -ne $ExpectedMaterialsSha256){throw 'Manifest changed'}
 $seen=@{}
 foreach($entry in $manifest.files){
  $name=[string]$entry.path
  if($name -match '[\\:\x00-\x1f]' -or $name.StartsWith('/') -or @($name.Split('/') | Where-Object {$_ -eq '' -or $_ -eq '.' -or $_ -eq '..'}).Count -or $seen.ContainsKey($name.ToLower())){throw 'Unsafe or duplicate material path'}
  $seen[$name.ToLower()]=$true;$file=Join-Path $Materials $name
  $cursor=$file
  while($cursor -ne $Materials){if((Get-Item -LiteralPath $cursor -Force).Attributes -band [IO.FileAttributes]::ReparsePoint){throw 'Material reparse point'};$cursor=Split-Path $cursor -Parent}
  if((Get-Item -LiteralPath $file).Length -ne $entry.bytes -or (Hash $file) -ne $entry.sha256){throw 'Material bytes/hash mismatch'}
 }
 foreach($sub in @('payload-unpacked','sidecar')){
  $actual=@(Get-ChildItem -LiteralPath (Join-Path $Materials $sub) -Force -Recurse | Where-Object {-not $_.PSIsContainer})
  $expected=@($manifest.files | Where-Object {$_.path.StartsWith($sub+'/')})
  if($actual.Count -ne $expected.Count){throw 'Extra material files'}
 }
 if((Hash $PSCommandPath) -ne ($manifest.files | Where-Object {$_.path -eq 'validate-windows-zh.ps1'}).sha256){throw 'Runner source mismatch'}
}
VerifyMaterials
[IO.Directory]::CreateDirectory($Output) | Out-Null
$good=Join-Path $Materials 'sidecar';$bad=Join-Path $Output 'sidecar-bad'
Copy-Item -LiteralPath $good -Destination $bad -Recurse
$dependency=Join-Path $bad 'node_modules\ffi-rs'
$removedFiles=@(Get-ChildItem -LiteralPath $dependency -Recurse -File).Count
if($removedFiles -lt 1){throw 'No ffi-rs dependency for real bad sample'}
Remove-Item -LiteralPath $dependency -Recurse
$exe=Join-Path $Materials 'payload-unpacked\T3 Code (Nightly).exe'
$probe=Join-Path $Materials 'windows-native-probe-zh.cjs'
$stages=@{}
foreach($stage in @('electron','node','bad','good','ffi','fff','keyring','pty')){
 $probeApp=$good;if($stage -eq 'bad'){$probeApp=$bad}
 $null=CheckAncestors (Split-Path $probeApp -Parent)
 if(@(Get-ChildItem -LiteralPath $probeApp -Force -Recurse | Where-Object {$_.Attributes -band [IO.FileAttributes]::ReparsePoint}).Count){throw 'Sidecar link refused'}
 $probeHome=Join-Path $Output ('homes\'+$stage);$probeTemp=Join-Path $Output ('temp\'+$stage)
 foreach($dir in @($probeHome,$probeTemp,(Join-Path $Output 'logs'),(Join-Path $probeHome 'AppData\Roaming'),(Join-Path $probeHome 'AppData\Local'))){[IO.Directory]::CreateDirectory($dir)|Out-Null}
 $arguments='--no-global-search-paths --version'
 if($stage -in @('bad','good')){$arguments='--no-global-search-paths "'+(Join-Path $probeApp 'apps\server\dist\bin.mjs')+'" --version'}
 elseif($stage -ne 'electron'){$arguments='--no-global-search-paths "'+$probe+'" "'+$probeApp+'" '+$stage}
 $info=New-Object Diagnostics.ProcessStartInfo
 $info.FileName=$exe;$info.Arguments=$arguments;$info.WorkingDirectory=$probeApp;$info.UseShellExecute=$false;$info.CreateNoWindow=$true;$info.RedirectStandardOutput=$true;$info.RedirectStandardError=$true
 $info.EnvironmentVariables.Clear()
 foreach($key in @('SystemRoot','WINDIR','SystemDrive','COMSPEC','OS','PROCESSOR_ARCHITECTURE','NUMBER_OF_PROCESSORS')){$value=[Environment]::GetEnvironmentVariable($key);if($value){$info.EnvironmentVariables[$key]=$value}}
 $info.EnvironmentVariables['PATH']=Join-Path $env:SystemRoot 'System32'
 foreach($key in @('HOME','USERPROFILE','T3CODE_HOME','CODEX_HOME','CLAUDE_CONFIG_DIR','XDG_CONFIG_HOME','XDG_DATA_HOME','XDG_CACHE_HOME')){$info.EnvironmentVariables[$key]=$probeHome}
 $info.EnvironmentVariables['APPDATA']=Join-Path $probeHome 'AppData\Roaming';$info.EnvironmentVariables['LOCALAPPDATA']=Join-Path $probeHome 'AppData\Local'
 $info.EnvironmentVariables['HOMEDRIVE']=[IO.Path]::GetPathRoot($probeHome).TrimEnd('\');$info.EnvironmentVariables['HOMEPATH']=$probeHome.Substring(2)
 foreach($key in @('TMP','TEMP','TMPDIR')){$info.EnvironmentVariables[$key]=$probeTemp}
 $info.EnvironmentVariables['NODE_PATH']='';$info.EnvironmentVariables['ELECTRON_RUN_AS_NODE']='1';$info.EnvironmentVariables['T3CODE_RESOURCE_MONITOR_ENABLED']='false'
 $info.EnvironmentVariables['NO_PROXY']='localhost,127.0.0.1,::1'
 $result=@{stage=$stage;startedUtc=[DateTime]::UtcNow.ToString('o');deadlineSeconds=20;timedOut=$false;exitCode=$null;error=$null;pid=$null;children=@()}
 $proc=New-Object Diagnostics.Process;$proc.StartInfo=$info;$tracked=@{};$out='';$err='';$started=$false
 try {
  if(-not $proc.Start()){throw 'Process start returned false'};$started=$true;$result.pid=$proc.Id
  WriteJson (Join-Path $Output ('active-'+$stage+'.json')) $result
  $outTask=$proc.StandardOutput.ReadToEndAsync();$errTask=$proc.StandardError.ReadToEndAsync();$clock=[Diagnostics.Stopwatch]::StartNew()
  while(-not $proc.HasExited -and $clock.Elapsed.TotalSeconds -lt 20){
   foreach($parentId in @($proc.Id)+@($tracked.Keys)){
    foreach($child in @(Get-CimInstance Win32_Process -Filter ('ParentProcessId='+$parentId))){
     if(-not $tracked.ContainsKey([int]$child.ProcessId)){$tracked[[int]$child.ProcessId]=@{pid=[int]$child.ProcessId;startEpochMs=([DateTimeOffset]$child.CreationDate).ToUnixTimeMilliseconds()}}
    }
   }
   [void]$proc.WaitForExit(100)
  }
  if(-not $proc.HasExited){$result.timedOut=$true;$proc.Kill();[void]$proc.WaitForExit(5000)}
  $result.exitCode=$proc.ExitCode
 } catch {$result.error=$_.Exception.Message} finally {
  if($started -and -not $proc.HasExited){$proc.Kill();[void]$proc.WaitForExit(5000)}
  foreach($item in $tracked.Values){$childProc=Get-Process -Id $item.pid -ErrorAction SilentlyContinue;if($childProc -and ([DateTimeOffset]$childProc.StartTime).ToUnixTimeMilliseconds() -eq $item.startEpochMs){$childProc.Kill();[void]$childProc.WaitForExit(5000);$item.cleanup='killed captured child'}else{$item.cleanup='already exited or PID reused'}}
  if($started){if(-not $outTask.Wait(5000) -or -not $errTask.Wait(5000)){$result.error='Output drain timeout';$result.timedOut=$true}else{$out=$outTask.Result;$err=$errTask.Result}}
  $result.children=@($tracked.Values);$result.finishedUtc=[DateTime]::UtcNow.ToString('o')
  foreach($stream in @('stdout','stderr')){$relative='logs/'+$stage+'.'+$stream+'.txt';$text=$out;if($stream -eq 'stderr'){$text=$err};[IO.File]::WriteAllText((Join-Path $Output $relative),$text,(New-Object Text.UTF8Encoding($false)));$result[$stream]=Identity (Join-Path $Output $relative) $relative}
  $relative='result-'+$stage+'.json';WriteJson (Join-Path $Output $relative) $result;$stages[$stage]=Identity (Join-Path $Output $relative) $relative
  $proc.Dispose()
 }
 $expectedExit=0;if($stage -eq 'bad'){$expectedExit=1}
 if($result.error -or $result.timedOut -or $result.exitCode -ne $expectedExit){throw ('Native stage failed: '+$stage)}
 if($stage -eq 'bad' -and ($err -notmatch 'ERR_MODULE_NOT_FOUND' -or $err -notmatch 'ffi-rs')){throw 'Wrong bad-sample failure'}
}
VerifyMaterials
# 坏样本也必须只缺那一个实际依赖，不能在运行期间补包或改内容。
foreach($entry in @($manifest.files | Where-Object {$_.path.StartsWith('sidecar/') -and -not $_.path.StartsWith('sidecar/node_modules/ffi-rs/')})){
 $file=Join-Path $bad $entry.path.Substring(8)
 if((Hash $file) -ne $entry.sha256){throw 'Bad sample changed unexpectedly'}
}
$receipt=@{schema=1;kind='nsis';version=$manifest.candidate.version;platform='win32';arch='x64';source=$manifest.candidate.source;artifactSha256=$manifest.candidate.sha256;materialsSha256=$ExpectedMaterialsSha256;integrityBefore=$ExpectedMaterialsSha256;integrityAfter=$ExpectedMaterialsSha256;removedDependency='ffi-rs';removedFiles=$removedFiles;isolation=@{environmentCleared=$true;noGlobalSearchPaths=$true;nodePath='';monitorEnabled=$false;ancestors=$ancestors};stages=$stages}
WriteJson (Join-Path $Output 'receipt.json') $receipt
Write-Output 'Private receipt written; replay locally before release. No GUI/install/provider acceptance.'
