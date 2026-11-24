'use strict';
const assert = require('node:assert/strict');
const { chromium, webkit } = require('playwright');
const { spawn } = require('node:child_process');
const path = require('node:path');
const root = path.resolve(__dirname, '..');
const browserName = process.env.WB_TEST_BROWSER === 'webkit' ? 'webkit' : 'chromium';
const type = browserName === 'webkit' ? webkit : chromium;
const port = process.env.WB_TEST_PORT || '18081';
const address = process.env.WB_TEST_URL || `http://127.0.0.1:${port}`;
const binary = path.join(root, 'test-results', process.platform === 'win32' ? 'server-test.exe' : 'server-test');
const server = process.env.WB_TEST_URL ? null : spawn(binary, [], { cwd: root, env: { ...process.env, ADDR: `127.0.0.1:${port}` }, stdio: 'ignore', windowsHide: true });
const wait = ms => new Promise(resolve => setTimeout(resolve, ms));
async function ready() {
  for (let i=0;i<100;i++) { try { const res=await fetch(address+'/healthz'); if(res.ok)return; } catch {} await wait(80); }
  throw new Error('Go test server did not become ready');
}
(async()=>{
 let browser;
 try {
  await ready();
  browser = await type.launch({ headless: true });
  const page = await browser.newPage({ viewport: { width: 390, height: 844 }, deviceScaleFactor: 1, isMobile: browserName === 'webkit', hasTouch: browserName === 'webkit' });
  const errors=[]; const apiCalls=[]; const direct=[];
  page.on('pageerror',e=>errors.push(e.message));
  page.on('request',req=>{if(/workbuddy\.(?:cn|ai)|codebuddy\.cn/.test(req.url()))direct.push(req.url());if(req.url().includes('/api/'))apiCalls.push(req.url())});
  await page.route('**/api/status',route=>route.fulfill({status:200,contentType:'application/json',body:JSON.stringify({service:'wb-pulse',version:'2.0.1',relay:'same-origin'})}));
  await page.route('**/api/cn/**',route=>{
    const url=new URL(route.request().url());
    if(url.pathname.endsWith('/profile'))return route.fulfill({status:200,contentType:'application/json',body:JSON.stringify({code:0,data:{uid:'browser-fixture',email:'fixture@example.test'}})});
    if(url.pathname.endsWith('/summary'))return route.fulfill({status:200,contentType:'application/json',body:JSON.stringify({code:0,data:{Packages:[{CycleUsedCapacity:25,CycleTotalCapacity:100}]}})});
    return route.fulfill({status:404,contentType:'application/json',body:'{}'});
  });
  await page.goto(address,{waitUntil:'networkidle'});
  assert.match(await page.title(),/WB Pulse/);
  assert.match(await page.locator('h1').innerText(),/让每一份用量\s+一目了然。/);
  const realmSelect=page.locator('#realm-select');
  assert.equal(await realmSelect.inputValue(),'cn','Chinese WorkBuddy must remain the default realm');
  const realmTheme=await realmSelect.evaluate(el=>({
    color:getComputedStyle(el).color,
    colorScheme:getComputedStyle(el).colorScheme,
    selectedBackground:getComputedStyle(el.options[0]).backgroundColor,
    selectedColor:getComputedStyle(el.options[0]).color,
  }));
  assert.equal(realmTheme.colorScheme,'light');
  assert.equal(realmTheme.color,'rgb(37, 67, 106)');
  assert.equal(realmTheme.selectedBackground,'rgb(22, 113, 249)');
  assert.equal(realmTheme.selectedColor,'rgb(255, 255, 255)');
  const disabledActions=await page.locator('.paste-button:disabled,.run-button:disabled').evaluateAll(els=>els.map(el=>({
    opacity:getComputedStyle(el).opacity,
    background:getComputedStyle(el).backgroundColor,
    color:getComputedStyle(el).color,
  })));
  assert.equal(disabledActions.length,2);
  for(const action of disabledActions){
    assert.equal(action.opacity,'1','disabled actions should not be washed out with opacity');
    assert.equal(action.background,'rgb(234, 242, 255)');
    assert.equal(action.color,'rgb(82, 111, 150)');
  }
  await realmSelect.selectOption('intl');
  assert.equal(await realmSelect.inputValue(),'intl');
  await realmSelect.selectOption('cn');

  await page.locator('#credential-input').fill(JSON.stringify({uid:'browser-fixture',accessToken:'synthetic-browser-token',realm:'cn'}));
  await page.getByRole('button',{name:/解析并导入/}).click();
  await page.locator('.status-pending').waitFor();
  assert.match(await page.locator('.identity-copy').innerText(),/browser-fixture/);
  await page.getByRole('button',{name:/验证全部账号/}).click();
  await page.locator('.status-success').waitFor({timeout:10000});
  assert.match(await page.locator('.quota-cell').innerText(),/75/);
  assert.ok(apiCalls.some(url=>url.endsWith('/api/status')));
  assert.ok(apiCalls.some(url=>url.endsWith('/api/cn/profile')));
  assert.ok(apiCalls.some(url=>url.endsWith('/api/cn/summary')));
  assert.equal(direct.length,0,'browser must send account requests only to the same-origin Go API');

  const count=2505;
  const jsonl=Array.from({length:count},(_,i)=>JSON.stringify({uid:`bulk-${i}`,accessToken:`synthetic-bulk-${i}`,realm:'cn'})).join('\n');
  const appended=JSON.stringify({uid:'bulk-0',accessToken:'synthetic-bulk-0',realm:'cn'})+'\n'+JSON.stringify({uid:'bulk-extra',accessToken:'synthetic-bulk-extra',realm:'cn'});
  await page.locator('#file-input').setInputFiles([
    {name:'unlimited-fixture.jsonl',mimeType:'text/plain',buffer:Buffer.from(jsonl)},
    {name:'append-fixture.jsonl',mimeType:'text/plain',buffer:Buffer.from(appended)},
  ]);
  await page.locator('.import-progress').waitFor({state:'visible',timeout:5000});
  assert.equal(await page.locator('.import-progress').getAttribute('role'),'status');
  assert.match(await page.locator('.import-progress-copy strong').innerText(),/%/);
  await page.waitForFunction(()=>document.querySelector('.stat-card>strong')?.textContent?.replaceAll(',','')==='2507',null,{timeout:20000});
  assert.match(await page.locator('.stat-card>strong').first().innerText(),/2,507/);
  assert.match(await page.locator('.pagination').innerText(),/80 个账号/);
  await page.getByRole('button',{name:'下一页'}).click();
  assert.match(await page.locator('.pagination').innerText(),/第 2 \/ /);
  assert.ok(errors.length===0,errors.join('\n'));
  const widths=await page.evaluate(()=>({client:document.documentElement.clientWidth,scroll:document.documentElement.scrollWidth}));
  assert.ok(widths.scroll<=widths.client+1,`horizontal overflow at ${JSON.stringify(widths)}`);
  console.log(`${browserName}: Vue UI, >2k unlimited import, pagination, mock WorkBuddy check through same-origin Go API, no browser CORS, no mobile overflow — passed`);
 } finally { if(browser) await browser.close(); if(server){server.kill();await wait(150);} }
})().catch(error=>{console.error(error);process.exitCode=1});
