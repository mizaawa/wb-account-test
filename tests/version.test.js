import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
const read = file => readFileSync(new URL('../'+file, import.meta.url), 'utf8');
test('frontend, Go API and package metadata publish one matching version', () => {
  const version=JSON.parse(read('package.json')).version;
  assert.equal(JSON.parse(read('package-lock.json')).version,version);
  assert.equal(JSON.parse(read('package-lock.json')).packages[''].version,version);
  assert.equal(read('web/src/api.js').match(/const VERSION = "([^"]+)"/)[1],version);
  assert.equal(read('internal/server/server.go').match(/const Version = "([^"]+)"/)[1],version);
});
