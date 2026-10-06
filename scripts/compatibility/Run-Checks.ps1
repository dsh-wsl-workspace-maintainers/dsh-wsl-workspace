#requires -Version 7.2
param([Parameter(Mandatory)][string]$Manifest)
$ErrorActionPreference='Stop'
$Manifest=(Resolve-Path $Manifest).Path
$caseRoot=Split-Path $Manifest
$r=Get-Content $Manifest -Raw | ConvertFrom-Json
$repo=[IO.Path]::GetFullPath((Join-Path $PSScriptRoot '../..'))
$results=[Collections.Generic.List[object]]::new()
function Run-Node([string]$Name,[string[]]$Arguments){
  $log=Join-Path $caseRoot "$Name.log"
  & node @Arguments *> $log
  $code=$LASTEXITCODE
  $results.Add([pscustomobject]@{name=$Name;exitCode=$code;log=$log})
  Write-Host "$Name exit=$code"
}
# Name the plane before anything launches, because seven of the nineteen checks below are real
# drivers that resolve their subject through `plane.mjs`, which has **no default** and throws on an
# unset plane (issue #44 §1). The fix belongs here, in the one caller that launches all of them, and
# not in `plane.mjs`: that module is the single reader of DSH_WSL_TEST_PLANE and it must keep
# refusing, or a driver launched anywhere else would inherit a default nobody asked for. A sweep that
# cannot start is not a stricter sweep, it is an unavailable one.
if($env:DSH_WSL_TEST_PLANE -eq 'src' -or $env:DSH_WSL_TEST_PLANE -eq 'lib'){
  Write-Host "plane=$($env:DSH_WSL_TEST_PLANE) (named by DSH_WSL_TEST_PLANE, used as given)"
}elseif([string]::IsNullOrEmpty($env:DSH_WSL_TEST_PLANE)){
  $env:DSH_WSL_TEST_PLANE='src'
  Write-Host 'DSH_WSL_TEST_PLANE was unset, so this sweep named it src (the sources under --experimental-strip-types) rather than leaving seven drivers to throw; set $env:DSH_WSL_TEST_PLANE=lib before running to sweep the committed bundle that ships instead.'
}else{
  # Hard failure, never a downgrade to src. A misspelled plane silently rewritten to src would sweep
  # a plane nobody requested while checks.json came back looking green — the exact false green this
  # is here to remove (issue #44 §1). `Write-Error` under the Stop preference above would exit 1
  # anyway; Console.Error plus an explicit code says which rule was broken.
  [Console]::Error.WriteLine("Run-Checks: DSH_WSL_TEST_PLANE must be 'src' or 'lib', got '$($env:DSH_WSL_TEST_PLANE)' — refusing to run. It is not defaulted to src, because a sweep of a plane nobody asked for would report green for the wrong bytes.")
  exit 2
}
$previousHome=$env:DSH_HOME
try{
  $env:DSH_HOME=$r.home
  $unitFiles=@(Get-ChildItem (Join-Path $r.plugin 'tests') -File | Where-Object Name -Match '\.test\.(ts|mjs)$' | ForEach-Object FullName)
  Run-Node 'unit' (@('--experimental-strip-types','--test')+$unitFiles)
  Run-Node 'lib' @((Join-Path $r.plugin 'scripts/verify-lib.mjs'))
  Run-Node 'typecheck' @((Join-Path $repo '.test-runs/tooling/node_modules/typescript/bin/tsc'),'--project',(Join-Path $r.plugin 'tsconfig.json'),'--noEmit')
  Run-Node 'materialize' @((Join-Path $r.plugin 'tests/host-materialize.mjs'))
  Run-Node 'declare' @((Join-Path $r.plugin 'tests/host-declare.mjs'))
  Run-Node 'exec-shape' @('--experimental-strip-types',(Join-Path $r.plugin 'tests/exec-shape.mjs'))
  Run-Node 'rank' @((Join-Path $r.plugin 'scripts/check-rank-parity.mjs'),'--strict')
  Run-Node 'smoke-source' @('--experimental-strip-types',(Join-Path $r.plugin 'tests/smoke.ts'))
  $built=(Get-Content (Join-Path $r.plugin 'tests/smoke.ts') -Raw).Replace("'../src/fs.ts'","'../lib/fs.js'").Replace("'../src/shell.ts'","'../lib/shell.js'")
  $builtPath=Join-Path $r.plugin 'tests/smoke-built.ts'
  $built | Set-Content $builtPath
  Run-Node 'smoke-built' @('--experimental-strip-types',$builtPath)
  Run-Node 'shell-extra' @((Join-Path $r.plugin 'tests/shell-extra.mjs'))
  Run-Node 'skills-real' @('--experimental-strip-types',(Join-Path $r.plugin 'scripts/compatibility/skills-real.mjs'))
  Run-Node 'fs-real' @('--experimental-strip-types',(Join-Path $r.plugin 'scripts/compatibility/fs-real.mjs'))
  Run-Node 'relay-real' @('--experimental-strip-types',(Join-Path $r.plugin 'scripts/compatibility/relay-real.mjs'))
  Run-Node 'tool-bash-real' @('--experimental-strip-types',(Join-Path $r.plugin 'scripts/compatibility/tool-bash-real.mjs'))
  Run-Node 'bash-session-real' @('--experimental-strip-types',(Join-Path $r.plugin 'scripts/compatibility/bash-session-real.mjs'))
  Run-Node 'bash-parity-real' @('--experimental-strip-types',(Join-Path $r.plugin 'scripts/compatibility/bash-parity-real.mjs'))
  Run-Node 'conpty-relay' @('--experimental-strip-types',(Join-Path $r.plugin 'scripts/compatibility/conpty-relay.mjs'),$Manifest)
  Run-Node 'search-real' @('--experimental-strip-types',(Join-Path $r.plugin 'scripts/compatibility/search-real.mjs'))
  Run-Node 'host-api' @((Join-Path $r.plugin 'scripts/compatibility/host-api.mjs'),$Manifest)
}finally{
  $env:DSH_HOME=$previousHome
  $results | ConvertTo-Json | Set-Content (Join-Path $caseRoot 'checks.json')
}
if(@($results | Where-Object exitCode -NE 0).Count){exit 1}
