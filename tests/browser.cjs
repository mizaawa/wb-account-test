/* Browser regressions use synthetic credentials only; no real upstream requests. */
const assert = require('node:assert/strict');
const { chromium } = require('playwright');
const { spawn } = require('node:child_process');
const fs = require('node:fs/promises');
const path = require('node:path');
const root = path.resolve(__dirname, '..');
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
const base = process.env.WB_TEST_URL || 'http://127.0.0.1:18081';
const server = process.env.WB_TEST_URL ? null : spawn(path.join(root, process.platform === 'win32' ? 'test-results/server-test.exe' : 'test-results/server-test'), [], { cwd: root, env: { ...process.env, ADDR: '127.0.0.1:18081' }, stdio: 'pipe', windowsHide: true });
let serverError;
if (server) { server.on('error', error => { serverError = error; }); }
let browser;
const errors = [];
async function waitFor(predicate, label) {
  for (let i = 0; i < 200; i++) { if (serverError) throw serverError; if (await predicate()) return; await delay(50); }
  throw new Error('Timed out: ' + label);
}
function fixtureFile(i, name) { return { name: name || ('fixture-' + i + '.json'), mimeType: 'application/json', buffer: Buffer.from(JSON.stringify({ uid: 'fixture-' + i, accessToken: 'synthetic-' + i })) }; }
async function assertWidth(page, width, label) {
  const sizes = await page.evaluate(() => ({ viewport: innerWidth, client: document.documentElement.clientWidth, doc: document.documentElement.scrollWidth, body: document.body.scrollWidth, results: document.querySelector('#results').getBoundingClientRect().width }));
  assert.equal(sizes.viewport, width, label + ': viewport should not auto-zoom out');
  assert.ok(sizes.doc <= sizes.client + 1 && sizes.body <= sizes.client + 1, label + ': page overflow ' + JSON.stringify(sizes));
  assert.ok(sizes.results <= width, label + ': results fit viewport');
}
(async () => {
  await fs.mkdir(path.join(root, 'test-results'), { recursive: true });
  await waitFor(async () => { try { return (await fetch(base + '/healthz')).ok; } catch { return false; } }, 'server ready');
  browser = await chromium.launch({ headless: true });
  for (const width of [320, 390, 430, 768, 1280]) {
    const context = await browser.newContext({ viewport: { width, height: 844 }, isMobile: width < 768, hasTouch: width < 768, deviceScaleFactor: 1 });
    const page = await context.newPage();
    page.on('pageerror', error => errors.push(error.message));
    let count = 0;
    await page.route('**/api/**', async route => {
      count++;
      const req = route.request(), url = req.url();
      assert.ok(url.startsWith(base + '/api/')); assert.equal(req.headers()['x-wb-pulse'], '1');
      await delay(15);
      if (url.endsWith('/profile')) return route.fulfill({ json: { code: 0, data: { email: 'fixture@example.test' } } });
      return route.fulfill({ json: { code: 0, data: { Packages: [{ CycleUsedCapacity: 25, CycleTotalCapacity: 100 }] } } });
    });
    await page.goto(base);
    await assertWidth(page, width, 'empty ' + width);
    if (width < 768) assert.ok(await page.locator('#credential-input').evaluate(el => parseFloat(getComputedStyle(el).fontSize) >= 16));
    // Slow just the browser's local reads so intermediate progress is observable.
    await page.evaluate(() => { const read = FileReader.prototype.readAsText; FileReader.prototype.readAsText = function(...args) { setTimeout(() => read.apply(this,args), 10); }; });
    await page.locator('#file-input').setInputFiles(Array.from({length:42},(_,i) => fixtureFile(i, i === 0 ? 'long-'.repeat(40) + '.json' : undefined)));
    await page.waitForFunction(() => document.getElementById('upload-button').getAttribute('aria-busy') === 'true');
    assert.ok(await page.locator('#import-progress').isVisible());
    assert.ok(await page.locator('#check-button').isDisabled());
    await page.waitForFunction(() => document.getElementById('import-percent').textContent === '100%' && !document.getElementById('upload-button').disabled);
    assert.match(await page.locator('#import-status').textContent(), /新增 42/);
    assert.equal(await page.locator('.file-chip').count(), 6);
    assert.ok(await page.locator('#file-chips').evaluate(el => el.getBoundingClientRect().height <= 112));
    await page.locator('.file-toggle').click();
    assert.equal(await page.locator('.file-chip').count(), 43);
    assert.ok(await page.locator('#file-chips').evaluate(el => el.getBoundingClientRect().height <= 180));
    await page.locator('.file-toggle').click();
    await assertWidth(page, width, 'imported ' + width);
    await page.locator('#file-input').setInputFiles([fixtureFile(0)]);
    await page.waitForFunction(() => !document.getElementById('upload-button').disabled);
    assert.match(await page.locator('#import-status').textContent(), /跳过 1/);
    assert.equal((await page.locator('#credential-input').inputValue()).trim().split(/\r?\n/).length,42);
    await page.locator('#check-button').click();
    await page.waitForFunction(() => document.getElementById('stat-success').textContent === '42' && document.getElementById('check-label').textContent === '开始测活');
    assert.equal(await page.locator('#progress-percent').textContent(),'100%');
    assert.equal(await page.locator('#results-body tr').count(),42);
    assert.equal(count,84);
    await assertWidth(page,width,'results ' + width);
    if (width < 768) assert.equal(await page.locator('#results-body tr').first().evaluate(el => getComputedStyle(el).display),'grid');
    if ([320,390,1280].includes(width)) { await page.locator('#results').scrollIntoViewIfNeeded(); await page.screenshot({path:path.join(root,'test-results/mobile-'+width+'.png')}); }
    // A double activation opens one picker; cancellation permits the next click.
    let choosers = 0; page.on('filechooser', () => { choosers++; });
    await page.locator('#upload-button').evaluate(button => { button.click(); button.click(); });
    await delay(100); assert.equal(choosers,1);
    await page.locator('#file-input').dispatchEvent('cancel');
    await page.locator('#upload-button').click();
    await delay(100); assert.equal(choosers,2);
    await page.locator('#file-input').dispatchEvent('cancel');
    console.log('PASS viewport/import/picker/results',width);
    await context.close();
  }
  const context=await browser.newContext({ viewport:{width:390,height:844},isMobile:true,hasTouch:true });
  const page=await context.newPage(); page.on('pageerror',e=>errors.push(e.message));
  let slow=false, failure=true;
  await page.route('**/api/**',async route=>{
    if(slow) await delay(200);
    const headers=route.request().headers(); const failing=failure && headers['authorization']==='Bearer synthetic-1';
    if(failing) return route.fulfill({status:401,json:{code:401}});
    return route.fulfill({json:route.request().url().endsWith('/profile')?{data:{email:headers['x-user-id']+'@example.test'}}:{data:{Packages:[{CycleUsedCapacity:1,CycleTotalCapacity:5}]}}});
  });
  await page.goto(base);
  await page.locator('#credential-input').fill(JSON.stringify([0,1,2].map(i=>({uid:'fixture-'+i,accessToken:'synthetic-'+i}))));
  await page.locator('#check-button').click(); await page.waitForFunction(()=>document.getElementById('check-label').textContent==='开始测活');
  await page.locator('[data-filter=failed]').click(); assert.equal(await page.locator('#results-body tr').count(),1);
  assert.equal(await page.locator('#results-body tr').getAttribute('data-index'),'1');
  failure=false; await page.locator('.row-retry').click();
  await page.waitForFunction(()=>document.getElementById('stat-success').textContent==='3');
  assert.equal(await page.locator('#results-body tr').count(),0);
  await page.locator('[data-filter=all]').click();
  assert.deepEqual(await page.locator('#results-body tr').evaluateAll(rows=>rows.map(r=>r.dataset.index)),['0','1','2']);
  assert.match(await page.locator('#results-body tr').nth(1).textContent(),/fixture-1@example.test/);
  slow=true;
  await page.locator('#credential-input').fill(JSON.stringify(Array.from({length:24},(_,i)=>({uid:'fixture-'+i,accessToken:'synthetic-'+i}))));
  await page.locator('#check-button').evaluate(button => { button.click(); button.click(); });
  await page.waitForFunction(()=>document.getElementById('check-label').textContent==='开始测活');
  assert.equal(await page.locator('#progress-percent').textContent(),'100%');
  assert.equal(await page.locator('.status-badge.pending, .status-badge.testing').count(),0);
  assert.match(await page.locator('#progress-label').textContent(),/停止/);
  await page.locator('#clear-button').click();
  await page.locator('#file-input').setInputFiles([{name:'broken.json',mimeType:'application/json',buffer:Buffer.from('{invalid')},fixtureFile(88)]);
  await page.waitForFunction(()=>!document.getElementById('upload-button').disabled);
  assert.ok(await page.locator('#import-error').isVisible());
  assert.match(await page.locator('#import-status').textContent(),/新增 1.*1 个文件失败/);
  assert.equal(await page.locator('#check-button').isDisabled(),false);
  await page.locator('#clear-button').click(); assert.equal(await page.locator('#import-progress').isVisible(),false);
  assert.equal(await page.locator('#credential-input').inputValue(),'');
  console.log('PASS filtered retry/cancel/partial failure/clear');
  await context.close();
  assert.deepEqual(errors,[],'no browser errors');
  console.log('All browser regression checks passed.');
})().catch(error=>{console.error(error);process.exitCode=1;}).finally(async()=>{if(browser)await browser.close();if(server)server.kill();});
