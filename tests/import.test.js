import test from 'node:test';
import assert from 'node:assert/strict';
import { parseImportAsync, parseCredentialsAsync } from '../web/src/api.js';

test('WBProxyCenter keeps only inventory metadata, even when the export contains tokens', async () => {
  const doc = JSON.stringify({source:'WBProxyCenter', version:'1', exported_at:'2026-11-24', count:99, skipped:1,
    accounts:[{name:'Demo', realm:'global', uid:'u1', expiresAt:1800000000, enabled:false, accessToken:'synthetic-ignore',
      refreshToken:'synthetic-ignore-refresh', product:'demo', pool_scope:'demo'}, {uid:2, expiresAt:1800000000000}]});
  const result = await parseImportAsync('﻿'+doc,'cn');
  assert.deepEqual(result, { kind:'inventory', rows:[
    {uid:'u1',name:'Demo',realm:'intl',enabled:false,expiresAt:1800000000000},
    {uid:'2',name:'',realm:'cn',enabled:null,expiresAt:1800000000000},
  ]});
  await assert.rejects(parseCredentialsAsync(doc), /清单不是在线凭证/);
});
test('invalid rosters identify the field or exact entry without echoing input', async () => {
  for (const doc of [{source:'WBProxyCenter'}, {accounts:null}, {accounts:'synthetic-secret'}]) {
    await assert.rejects(parseImportAsync(JSON.stringify(doc)), {message:'账号清单的 accounts 必须是数组'});
  }
  await assert.rejects(parseImportAsync('{"accounts":[]}'), /清单为空/);
  for(const entry of [null, 1, ['synthetic-secret'], {name:'synthetic-secret'}]) {
    await assert.rejects(parseImportAsync(JSON.stringify({accounts:[{uid:'ok'},entry]})), err =>
      err.kind==='input' && err.message.includes('accounts[1]') && !err.message.includes('synthetic-secret'));
  }
});
test('inventory records are processed incrementally and missing expiry is not fabricated', async () => {
  const progress=[];
  const accounts=Array.from({length:2501},(_,i)=>({uid:String(i),expiresAt:0}));
  const result=await parseImportAsync(JSON.stringify({accounts}),'intl',p=>progress.push(p));
  assert.equal(result.rows.length,accounts.length);
  assert.equal(result.rows[0].expiresAt,null);
  assert.equal(result.rows[0].realm,'intl');
  assert.ok(progress.length>1 && progress.every((p,i)=>p>0 && (!i||p>progress[i-1])));
  assert.equal(progress.at(-1),1);
});
test('account/auth keeps its previous credential import behavior', async () => {
  const result=await parseImportAsync(JSON.stringify({account:{uid:'one',nickname:'Example',enterpriseId:'enterprise'},auth:{accessToken:'synthetic-one',domain:'example.test',expiresAt:1800000000,realm:'intl',refreshToken:'synthetic-refresh'}}));
  assert.equal(result.kind,'credentials');assert.equal(result.rows.length,1);
  assert.equal(result.rows[0].uid,'one');assert.equal(result.rows[0].realm,'intl');
});
