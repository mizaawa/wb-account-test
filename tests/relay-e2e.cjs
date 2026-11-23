/* Real browser -> real Go relay -> local TLS fixture without upstream CORS headers.
 * Synthetic credentials only. WB_DOCKER_IMAGE switches to the built production image. */
const assert=require('node:assert/strict');
const fs=require('node:fs/promises');
const path=require('node:path');
const http=require('node:http');
const {spawn}=require('node:child_process');
const {chromium}=require('playwright');
const root=path.resolve(__dirname,'..');
const windows=process.platform==='win32';
const docker=process.env.WB_DOCKER_BIN || 'docker';
const image=process.env.WB_DOCKER_IMAGE;
const prefix=path.join(root,'test-results','relay-e2e');
const certificate=path.join(prefix,'fixture.pem');
const children=[];
let browser,reverse,containerStarted=false;
const containerName='wb-pulse-relay-e2e';
const delay=ms=>new Promise(r=>setTimeout(r,ms));
async function run(exe,args,env=process.env){return new Promise((resolve,reject)=>{const p=spawn(exe,args,{cwd:root,env,windowsHide:true});let out='',err='';p.stdout.on('data',d=>out+=d);p.stderr.on('data',d=>err+=d);p.on('error',reject);p.on('close',code=>code===0?resolve(out):reject(new Error(exe+' exited '+code+': '+err)));});}
function launch(exe,args,env){const p=spawn(exe,args,{cwd:root,env,windowsHide:true,stdio:'pipe'});children.push(p);p.on('error',e=>console.error(e));p.stderr.on('data',d=>process.stderr.write(d));return p;}
async function ready(url){for(let i=0;i<100;i++){try{if((await fetch(url)).ok)return;}catch{}await delay(100);}throw new Error('Not ready: '+url);}
(async()=>{
 if(windows && !image) throw new Error('On Windows, set WB_DOCKER_IMAGE to test inside Linux without changing system certificate trust');
 await fs.mkdir(prefix,{recursive:true});
 await run('go',['build','-o',path.join(prefix,'fixture'+(windows?'.exe':'')),'./tests/relayfixture']);
 launch(path.join(prefix,'fixture'+(windows?'.exe':'')),[],{...process.env,FIXTURE_ADDR:(image?'0.0.0.0':'127.0.0.1')+':18092',FIXTURE_CERT:certificate});
 await ready('http://127.0.0.1:18092/counts');
 if(image){
  await run(docker,['run','-d','--rm','--name',containerName,'--read-only','--cap-drop','ALL','--security-opt','no-new-privileges','-p','127.0.0.1:18093:8080','--add-host','host.docker.internal:host-gateway','--mount','type=bind,source='+prefix+',target=/test-ca,readonly','-e','HTTPS_PROXY=http://host.docker.internal:18092','-e','NO_PROXY=','-e','SSL_CERT_FILE=/test-ca/fixture.pem',image]);
  containerStarted=true;
 }else{
  launch(path.join(root,'test-results','server-test'+(windows?'.exe':'')),[],{...process.env,ADDR:'127.0.0.1:18093',HTTPS_PROXY:'http://127.0.0.1:18092',HTTP_PROXY:'http://127.0.0.1:18092',NO_PROXY:'',SSL_CERT_FILE:certificate});
 }
 await ready('http://127.0.0.1:18093/healthz');
 reverse=http.createServer((req,res)=>{
  if(!req.url.startsWith('/pulse/')){res.writeHead(404);res.end();return;}
  const upstream=http.request({hostname:'127.0.0.1',port:18093,path:req.url.slice(6),method:req.method,headers:req.headers},response=>{res.writeHead(response.statusCode,response.headers);response.pipe(res);});
  upstream.on('error',()=>{res.writeHead(502);res.end();});req.pipe(upstream);
 });
 await new Promise(r=>reverse.listen(18094,'127.0.0.1',r));
 browser=await chromium.launch({headless:true});
 for(const base of ['http://127.0.0.1:18093/','http://127.0.0.1:18094/pulse/']){
  const context=await browser.newContext({viewport:{width:390,height:844},isMobile:true,hasTouch:true});
  const page=await context.newPage();const requests=[],errors=[];
  page.on('request',req=>requests.push({url:req.url(),method:req.method()}));page.on('pageerror',e=>errors.push(e.message));
  await page.goto(base);
  const status=await (await context.request.get(base+'api/status')).json();assert.equal(status.version,'1.1.1');assert.equal(status.relay,'same-origin');
  await page.locator('#credential-input').fill(JSON.stringify(['cn','intl'].map(realm=>({uid:'synthetic-e2e',accessToken:'synthetic-e2e-'+realm,realm}))));
  await page.locator('#check-button').click();
  await page.waitForFunction(()=>document.getElementById('check-label').textContent==='开始测活');
  assert.equal(await page.locator('#stat-success').textContent(),'2',await page.locator('#results-body').textContent());
  assert.equal(await page.locator('#stat-failed').textContent(),'0');assert.deepEqual(errors,[]);
  assert.ok(requests.every(r=>r.url.startsWith(base)),'browser must never request official API hosts');
  assert.equal(requests.filter(r=>r.method==='OPTIONS').length,0,'same-origin requests need no CORS preflight');
  assert.equal(requests.filter(r=>(r.url.includes('/api/cn/') || r.url.includes('/api/intl/'))).length,4);
  console.log('PASS real '+(image?'Docker':'Go')+' relay, both realms, no upstream CORS, '+base);
  await context.close();
 }
 const counts=await (await fetch('http://127.0.0.1:18092/counts')).json();
 assert.equal(Object.values(counts).reduce((a,b)=>a+b,0),8);console.log('Verified server-side upstream requests:',JSON.stringify(counts));
})().catch(e=>{console.error(e);process.exitCode=1;}).finally(async()=>{if(browser)await browser.close();if(reverse){reverse.closeAllConnections();await new Promise(r=>reverse.close(r));}try { if(containerStarted)await run(docker,['rm','-f',containerName]); } finally { for(const p of children)p.kill(); }});
