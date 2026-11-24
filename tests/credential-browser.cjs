const assert = require('node:assert/strict');

// The three supported file shapes are synthetic analogues, never user secrets.
async function checkCredentialExports(page) {
  const calls=[];
  await page.unrouteAll({behavior:'wait'});
  await page.route(/\/api\/(?:cn|intl)\//, async route=>{
    const req=route.request(), headers=await req.allHeaders();
    calls.push({path:new URL(req.url()).pathname, token:headers.authorization});
    const data=req.url().endsWith('/profile')?{uid:headers['x-user-id'],nickname:'Test account'}:{Packages:[{CycleTotalCapacity:100,CycleUsedCapacity:20,CycleRemainCapacity:75}]};
    await route.fulfill({status:200,contentType:'application/json',body:JSON.stringify({code:0,data})});
  });
  const row=uid=>({uid,accessToken:'synthetic-'+uid,realm:'cn',domain:'www.codebuddy.cn',enabled:true});
  const docs=[{source:'WBProxyCenter',accounts:[row('one')]},
    {source:'WBProxyCenter',accounts:[row('one'),row('two'),row('three')]},
    [{uid:'four',access_token:'synthetic-four',refresh_token:'synthetic-refresh',auth_raw:{domain:'www.codebuddy.cn'},profile_raw:{uid:'four'}}]];
  const file=(name,doc)=>({name,mimeType:'application/json',buffer:Buffer.from(JSON.stringify(doc))});
  for(let i=0;i<docs.length;i++){
    await page.reload();
    const before=calls.length;
    await page.locator('#file-input').setInputFiles(file('shape-'+i+'.json',docs[i]));
    await page.waitForFunction(()=>!document.querySelector('.run-button').disabled);
    assert.equal(calls.length,before,'import must never send credentials automatically');
    assert.equal(await page.locator('.inventory').count(),0);
    await page.getByRole('button',{name:/凭证测活/}).click();
    const expected=i===1?3:1;
    await page.waitForFunction(n=>document.querySelectorAll('.status-success').length===n,expected);
    assert.equal(await page.locator('.status-failed').count(),0);
    assert.match(await page.locator('.quota-cell').first().innerText(),/75/);
  }
  await page.reload();
  await page.locator('#file-input').setInputFiles(docs.map((d,i)=>file('mixed-'+i+'.json',d)));
  await page.waitForFunction(()=>!document.querySelector('.run-button').disabled);
  assert.equal(await page.locator('.accounts-table tbody tr').count(),4,'same UID from overlapping exports is merged');
  await page.getByRole('button',{name:/凭证测活/}).click();
  await page.waitForFunction(()=>document.querySelectorAll('.status-success').length===4);
  const updated={source:'WBProxyCenter',accounts:[{...row('one'),accessToken:'synthetic-replacement'}]};
  await page.locator('#file-input').setInputFiles(file('replace.json',updated));
  await page.waitForFunction(()=>!document.querySelector('.run-button').disabled);
  assert.equal(await page.locator('.accounts-table tbody tr').count(),4);
  await page.getByRole('button',{name:/凭证测活/}).click();
  await page.waitForFunction(()=>document.querySelectorAll('.status-success').length===4);
  assert.ok(calls.some(call=>call.token==='Bearer synthetic-replacement'));
  assert.equal(await page.evaluate(()=>localStorage.length+sessionStorage.length),0);
  await page.reload();
}
module.exports={checkCredentialExports};
