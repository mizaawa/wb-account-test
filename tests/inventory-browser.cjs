const assert = require('node:assert/strict');

// Synthetic fixtures only. Import must not issue even a status request.
async function checkInventory(page, apiCalls) {
  const envelope = accounts => ({ source:'WBProxyCenter', version:'1', count:accounts.length, skipped:0, accounts });
  const row = { uid:'roster-one', name:'Demo one', realm:'cn', enabled:true, expiresAt:1800000000, accessToken:'synthetic-never-relay' };
  await page.locator('#credential-input').fill(JSON.stringify(envelope([row])));
  await page.getByRole('button',{name:/解析并导入/}).click();
  const inventory = page.getByRole('region',{name:/WBProxyCenter 本地清单/});
  await inventory.waitFor();
  await page.waitForFunction(() => !document.querySelector('#realm-select').disabled);
  assert.ok(await page.locator('.run-button').isDisabled());
  assert.equal(await inventory.getByRole('listitem').count(),1);
  assert.match(await inventory.innerText(), /已启用/);
  const updated = envelope([{...row,name:'Updated demo',enabled:false}, {uid:'roster-two',realm:'intl'}, {uid:'roster-three',realm:'cn'}]);
  const single = {account:{uid:'browser-fixture'}, auth:{accessToken:'synthetic-browser-token'}};
  const file = (name, obj) => ({name, mimeType:'application/json', buffer:Buffer.from(JSON.stringify(obj))});
  await page.locator('#file-input').setInputFiles([file('roster.json',updated), file('account.json',single)]);
  await page.locator('.status-pending').waitFor();
  assert.equal(await inventory.getByRole('listitem').count(),3);
  assert.match(await inventory.innerText(),/Updated demo/);
  assert.match(await inventory.innerText(),/未启用/);
  assert.doesNotMatch(await inventory.innerText(),/synthetic-never-relay/);
  assert.equal(await page.locator('.accounts-table tbody tr').count(),1);
  assert.equal(apiCalls.length,0);
}
module.exports = { checkInventory };
