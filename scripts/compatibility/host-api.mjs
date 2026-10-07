import fs from 'node:fs/promises';
import path from 'node:path';
const manifest=JSON.parse((await fs.readFile(process.argv[2],'utf8')).replace(/^\uFEFF/,''));
const distro=process.env.WSL_COMPAT_DISTRO || 'Ubuntu';
const linux=process.env.WSL_COMPAT_ROOT || '/tmp/dsh-wsl-compat';
const unc=`\\\\wsl.localhost\\${distro}${linux.replaceAll('/','\\')}`;
await fs.mkdir(path.join(unc,'.agents'),{recursive:true});
const windows=path.resolve(path.join(path.dirname(process.argv[2]),'windows-fixture'));
await fs.mkdir(windows,{recursive:true});
const drive=/^([A-Za-z]):[\\/](.*)$/.exec(path.resolve(windows));
if(!drive)throw new Error('The Windows fixture must be on a drive');
const mnt=`/mnt/${drive[1].toLowerCase()}/${drive[2].replaceAll('\\','/')}`;
const results=[];
async function probe(name,method,params,verify){
  try{
    const response=await fetch(`http://127.0.0.1:${manifest.port}/wsl-workspace/api`,{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({method,params}),signal:AbortSignal.timeout(10000)});
    const body=await response.json();results.push({name,pass:response.ok&&!!verify(body),status:response.status,...!body.ok?{error:body.error}:{}});
  }catch(error){results.push({name,pass:false,error:String(error)});}
}
await probe('distros','listDistros',{},b=>b.ok&&b.value.includes(distro));
await probe('directory','check',{distro,path:linux},b=>b.ok&&b.value.exists&&b.value.isDirectory);
await probe('missing','check',{distro,path:linux+'/does-not-exist'},b=>b.ok&&!b.value.exists);
await probe('relative','check',{distro,path:'relative'},b=>!b.ok);
await probe('browse','listDir',{distro,path:linux},b=>b.ok&&b.value.entries.some(e=>e.name==='.agents'));
await probe('user','setUser',{path:unc,username:process.env.WSL_COMPAT_USER||'root'},b=>b.ok);
await probe('invalid-user','setUser',{path:unc,username:'bad;name'},b=>!b.ok);
await probe('clear-user','setUser',{path:unc,username:''},b=>b.ok);
await probe('windows','registerWindows',{distro,linuxPath:mnt,username:''},b=>b.ok);
await probe('windows-list','listWorkspaces',{},b=>b.ok&&b.value.some(p=>p.toLowerCase()===windows.toLowerCase()));
await probe('workspace-records','listWorkspaceRecords',{},b=>b.ok&&b.value.some(r=>r.path.toLowerCase()===windows.toLowerCase()&&r.distro===distro));
await probe('mnt','check',{distro,path:mnt},b=>b.ok&&b.value.isDirectory);
await probe('unknown-method','not-a-method',{},b=>!b.ok);
await fs.writeFile(path.join(path.dirname(process.argv[2]),'host-api.json'),JSON.stringify(results,null,2));
// Floor, the same class of hole `verify-lib` had: `some()` over an empty array is false, so a
// run that probed nothing printed "0/0 checks passed" and exited 0. The probe list is a
// contract, so a short run is a failure rather than a quieter pass.
const EXPECTED_PROBES = 13;
console.log(`${results.filter(r=>r.pass).length}/${results.length} checks passed`);
if(results.length !== EXPECTED_PROBES){
  console.error(`host-api: RED — ran ${results.length} probes, expected ${EXPECTED_PROBES}; `
    +'a run that probed nothing, or skipped a method, must not report green');
  process.exitCode=1;
}
if(results.some(r=>!r.pass))process.exitCode=1;
