/* Local release builder: no authentication and no publication. */
const fs = require('node:fs/promises');
const path = require('node:path');
const {spawn} = require('node:child_process');
const root = path.resolve(__dirname,'..');
const version = require('../package.json').version;
if (!/^\d+\.\d+\.\d+$/.test(version)) throw new Error('Invalid semver');
const out = path.join(root,'test-results','release-v'+version);
const assets = path.join(out,'assets');
const windows = process.platform === 'win32';
const dockerRoot = path.join(process.env.ProgramFiles || 'C:/Program Files','Docker/Docker/resources');
const buildx = windows ? path.join(dockerRoot,'cli-plugins/docker-buildx.exe') : 'docker';
const compose = windows ? path.join(dockerRoot,'cli-plugins/docker-compose.exe') : 'docker';
async function run(exe,args,env=process.env) {
 return new Promise((resolve,reject)=>{const p=spawn(exe,args,{cwd:root,env,stdio:'inherit',windowsHide:true});p.on('error',reject);p.on('close',code=>code===0?resolve():reject(new Error(exe+' exited '+code)));});
}
async function docs(dir,type,arch) {
 for(const file of ['README.md','CHANGELOG.md']) await fs.copyFile(path.join(root,file),path.join(dir,file));
 const templates=path.join(__dirname,'packaging',type);
 for(const file of await fs.readdir(templates)) {
  let text=(await fs.readFile(path.join(templates,file),'utf8')).replaceAll('@VERSION@',version).replaceAll('@ARCH@',arch);
  if(file.endsWith('.sh')) text=text.replaceAll('\r\n','\n');
  await fs.writeFile(path.join(dir,file),text);
 }
}
(async()=>{
 await fs.mkdir(assets,{recursive:true});
 await run(process.execPath,['node_modules/vite/bin/vite.js','build']);
 for(const os of ['windows','linux']) for(const arch of ['amd64','arm64']) {
  const name='wb-pulse-'+version+'-'+os+'-'+arch, dir=path.join(out,name);
  await fs.mkdir(dir,{recursive:true});
  await run('go',['build','-trimpath','-buildvcs=true','-ldflags=-s -w','-o',path.join(dir,os==='windows'?'wb-pulse.exe':'wb-pulse'),'./cmd/server'],{...process.env,CGO_ENABLED:'0',GOOS:os,GOARCH:arch});
  await docs(dir,os,arch);
  if(os==='windows') await run('tar',['-a','-cf',path.join(assets,name+'.zip'),'-C',out,name]);
  else await run('tar',['-czf',path.join(assets,name+'.tar.gz'),'-C',out,name]);
  console.log('Built '+name);
 }
 const template=await fs.readFile(path.join(root,'docker-compose.yaml'),'utf8');
 await fs.writeFile(path.join(assets,'docker-compose.yaml'),template.replace(':latest',':'+version));
 for(const file of ['README.md','CHANGELOG.md']) await fs.copyFile(path.join(root,file),path.join(assets,file));
 for(const arch of ['amd64','arm64']) {
  const name='wb-pulse-'+version+'-docker-linux-'+arch,dir=path.join(out,name),image='ghcr.io/mizaawa/wb-account-test:'+version+'-'+arch;
  await fs.mkdir(dir,{recursive:true});
  await run(buildx,[...(windows?[]:['buildx']),'build','--platform','linux/'+arch,'--tag',image,'--output','type=docker,dest='+path.join(dir,'image.tar'),'--metadata-file',path.join(out,'docker-'+arch+'-metadata.json'),'--progress','plain','.']);
  await docs(dir,'docker',arch);
  const offline=template.replace(/image: .+/, 'image: '+image).replace('    ports:','    pull_policy: never\n    platform: linux/'+arch+'\n    ports:');
  await fs.writeFile(path.join(dir,'docker-compose.yaml'),offline);
  await run(compose,[...(windows?[]:['compose']),'-f',path.join(dir,'docker-compose.yaml'),'config','--quiet']);
  await run('tar',['-czf',path.join(assets,name+'.tar.gz'),'-C',out,name]);
  console.log('Built '+name);
 }
 console.log('Artifacts: '+assets);
})().catch(e=>{console.error(e);process.exitCode=1;});
