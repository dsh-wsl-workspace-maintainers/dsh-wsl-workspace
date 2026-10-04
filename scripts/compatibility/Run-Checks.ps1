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
  Run-Node 'conpty-relay' @('--experimental-strip-types',(Join-Path $r.plugin 'scripts/compatibility/conpty-relay.mjs'),$Manifest)
  Run-Node 'search-real' @('--experimental-strip-types',(Join-Path $r.plugin 'scripts/compatibility/search-real.mjs'))
  Run-Node 'host-api' @((Join-Path $r.plugin 'scripts/compatibility/host-api.mjs'),$Manifest)
}finally{
  $env:DSH_HOME=$previousHome
  $results | ConvertTo-Json | Set-Content (Join-Path $caseRoot 'checks.json')
}
if(@($results | Where-Object exitCode -NE 0).Count){exit 1}
