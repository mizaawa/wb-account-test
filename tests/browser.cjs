/* Browser regressions use synthetic credentials only; no real upstream requests. */
const assert = require('node:assert/strict');
const browserName = process.env.WB_TEST_BROWSER || 'chromium';
const browserType = require('playwright')[browserName];
if (!browserType) throw new Error('Unsupported test browser: ' + browserName);
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
  const painted = await page.evaluate(() => {
    const limit = document.documentElement.clientWidth;
    return { visual: visualViewport.width, offset: visualViewport.offsetLeft,
      outside: Array.from(document.body.children).filter(el => {
        const rect = el.getBoundingClientRect();
        return rect.width > 0 && (rect.left < -1 || rect.right > limit + 1);
      }).map(el => el.id || el.className || el.tagName) };
  });
  assert.deepEqual(painted.outside, [], label + ': offscreen page layers');
  assert.ok(Math.abs(painted.visual - width) <= 1 && Math.abs(painted.offset) <= 1, label + ': visual viewport ' + JSON.stringify(painted));
}
(async () => {
  await fs.mkdir(path.join(root, 'test-results'), { recursive: true });
  await waitFor(async () => { try { return (await fetch(base + '/healthz')).ok; } catch { return false; } }, 'server ready');
  browser = await browserType.launch({ headless: true });
  for (const width of [320, 390, 430, 768, 1280]) {
    const context = await browser.newContext({ viewport: { width, height: 844 }, isMobile: browserName !== 'firefox' && width < 768, hasTouch: width < 768, deviceScaleFactor: 1 });
    const page = await context.newPage();
    page.on('pageerror', error => errors.push(error.message));
    let count = 0;
    await page.route('**/api/**', async route => {
      const req = route.request(), url = req.url();
      if (url.endsWith('/api/status')) return route.continue();
      count++;
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
    const chosen = page.waitForEvent('filechooser');
    await page.locator('#file-input').click();
    const picker = await chosen;
    assert.equal(picker.isMultiple(), true, 'native chooser must allow multiple files');
    assert.equal(await page.locator('#file-input').getAttribute('accept'), null, 'do not hide mobile provider files with MIME filters');
    await picker.setFiles(Array.from({length:42},(_,i) => fixtureFile(i, i === 0 ? 'long-'.repeat(40) + '.json' : undefined)));
    await page.waitForFunction(() => document.getElementById('upload-button').getAttribute('aria-busy') === 'true');
    assert.ok(await page.locator('#import-progress').isVisible());
    assert.ok(await page.locator('#check-button').isDisabled());
    await page.waitForFunction(() => document.getElementById('import-percent').textContent === '100%' && !document.getElementById('upload-button').disabled);
    assert.equal(await page.locator('#import-progress').isVisible(), false);
    assert.equal(await page.locator('#file-chips, .file-chip, .file-toggle, #line-count').count(), 0);
    assert.equal(await page.locator('#toast').textContent(), '导入完成');
    await assertWidth(page, width, 'imported ' + width);
    await page.locator('#file-input').setInputFiles([fixtureFile(0)]);
    await page.waitForFunction(() => !document.getElementById('upload-button').disabled);
    await page.waitForFunction(()=>document.getElementById('toast').textContent==='这些凭证已在输入框中');
    assert.equal(await page.locator('#import-progress').isVisible(),false);
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
    await page.locator('#file-input').click();
    await delay(100); assert.equal(choosers,2);
    await page.locator('#file-input').dispatchEvent('cancel');
    console.log('PASS viewport/import/picker/results',width);
    await context.close();
  }
  // Rotate a phone, and simulate touch with a desktop-sized layout viewport.
  for (const desktopMode of [false, true]) {
    const context = await browser.newContext({isMobile: !desktopMode && browserName !== 'firefox', hasTouch:true, deviceScaleFactor:2, viewport:{width:desktopMode ? 980 : 390, height:844}});
    const page = await context.newPage();
    await page.goto(base);
    for (const [width,height] of (desktopMode ? [[980,844],[1024,390]] : [[390,844],[844,390],[390,844]])) {
      await page.setViewportSize({width,height});
      await page.locator('#credential-input').focus();
      await page.evaluate(() => new Promise(r => requestAnimationFrame(() => requestAnimationFrame(r))));
      await assertWidth(page,width,(desktopMode?'desktop-touch':'phone-rotate')+' focused '+width);
      assert.ok(await page.locator('#credential-input').evaluate(el => parseFloat(getComputedStyle(el).fontSize) >= 16));
      await page.locator('#credential-input').blur();
    }
    await context.close();
  }
  // Native user chooser + real DataTransfer objects: every visible import surface.
  for (const width of [390, 1280]) {
    const context = await browser.newContext({ viewport:{width,height:844}, isMobile:browserName !== 'firefox' && width < 768, hasTouch:width < 768 });
    const page = await context.newPage(); page.on('pageerror', error => errors.push(error.message));
    const requests = []; page.on('request', req => requests.push(req.url()));
    await page.goto(base);
    await page.evaluate(() => { const read = FileReader.prototype.readAsText; FileReader.prototype.readAsText = function(...args) { setTimeout(() => read.apply(this,args), 30); }; });
    let expected = 0;
    async function dropAt(selector, ids, itemsOnly = false) {
      const transfer = await page.evaluateHandle(({ids,itemsOnly}) => {
        const dt = new DataTransfer();
        for (const id of ids) dt.items.add(new File([JSON.stringify({uid:'drop-'+id,accessToken:'synthetic-drop-'+id})], 'credential-'+id+'.json', {type:''}));
        if (itemsOnly) Object.defineProperty(dt,'files',{value:[]});
        return dt;
      }, {ids,itemsOnly});
      await page.locator(selector).dispatchEvent('dragenter', {dataTransfer:transfer});
      await page.locator(selector).dispatchEvent('dragover', {dataTransfer:transfer});
      await page.locator(selector).dispatchEvent('drop', {dataTransfer:transfer});
      await transfer.dispose();
    }
    const surfaces = width < 768 ? ['#credential-input','#file-input','#import-workspace'] : ['.drop-copy','#file-input','#credential-input','#import-workspace'];
    for (const [i,selector] of surfaces.entries()) {
      await dropAt(selector,[i*2,i*2+1],i===2);
      expected+=2;
      await page.waitForFunction(n=>document.getElementById('credential-input').value.trim().split(/\r?\n/).length===n && !document.getElementById('upload-button').disabled,expected);
      assert.equal(await page.locator('#import-progress').isVisible(),false);
    }
    await dropAt('#import-workspace',[100,101]);
    await page.waitForFunction(()=>document.getElementById('upload-button').disabled);
    await dropAt('#import-workspace',[102,103]);
    expected+=4;
    await page.waitForFunction(n=>document.getElementById('credential-input').value.trim().split(/\r?\n/).length===n && !document.getElementById('upload-button').disabled,expected);
    assert.equal(await page.locator('#import-percent').textContent(),'100%');
    await dropAt('#import-workspace',[100,101]);
    await page.waitForFunction(()=>document.getElementById('toast').textContent==='这些凭证已在输入框中');
    assert.equal((await page.locator('#credential-input').inputValue()).split(/\r?\n/).length,expected);
    assert.ok(requests.every(url=>url.startsWith(base)), 'import must not upload files to any server');
    assert.equal(requests.filter(url=>url.includes('/api/')).length,0,'import only reads locally');
    await assertWidth(page,width,'multi-drop');
    await page.screenshot({path:path.join(root,'test-results/import-'+browserName+'-'+width+'.png')});
    console.log('PASS native multi-select/drop targets/queue/duplicates',browserName,width);
    await context.close();
  }
  // Reject missing/mismatched backend before any credential-bearing request.
  for (const broken of ['html','old-version']) {
    const context=await browser.newContext(); const page=await context.newPage();
    let credentialRequests=0;
    await page.route('**/api/**',route=>{
      if(route.request().url().endsWith('/api/status')) return broken==='html' ? route.fulfill({contentType:'text/html',body:'<html>wrong proxy</html>'}) : route.fulfill({json:{service:'wb-pulse',version:'1.1.0',relay:'same-origin'}});
      credentialRequests++; return route.abort();
    });
    await page.goto(base);
    await page.locator('#credential-input').fill('{"uid":"synthetic","accessToken":"synthetic"}');
    await page.locator('#check-button').click();
    await page.waitForFunction(()=>document.getElementById('stat-failed').textContent==='1');
    assert.equal(credentialRequests,0);
    assert.match(await page.locator('#results-body').textContent(),/检测服务|容器|反向代理/);
    await context.close();
  }
  const context=await browser.newContext({ viewport:{width:390,height:844},isMobile:browserName !== 'firefox',hasTouch:true });
  const page=await context.newPage(); page.on('pageerror',e=>errors.push(e.message));
  let slow=false, failure=true;
  await page.route('**/api/**',async route=>{
    if(route.request().url().endsWith('/api/status')) return route.continue();
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
  assert.equal(await page.locator('#import-progress').isVisible(),false);
  assert.match(await page.locator('#import-error').textContent(),/broken\.json/);
  assert.equal(JSON.parse(await page.locator('#credential-input').inputValue()).uid,'fixture-88');
  assert.equal(await page.locator('#check-button').isDisabled(),false);
  await page.locator('#clear-button').click(); assert.equal(await page.locator('#import-progress').isVisible(),false);
  assert.equal(await page.locator('#credential-input').inputValue(),'');
  console.log('PASS filtered retry/cancel/partial failure/clear');
  await context.close();
  assert.deepEqual(errors,[],'no browser errors');
  console.log('All browser regression checks passed.');
})().catch(error=>{console.error(error);process.exitCode=1;}).finally(async()=>{if(browser)await browser.close();if(server)server.kill();});
