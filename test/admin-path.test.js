import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { UI_FILES, adminRelative, isRootAdminRequest, normalizeAdminPath } from '../src/admin-path.js';

test('root domain exposes only the admin shell, assets and API namespace', () => {
  for (const path of ['/', '/index.html', '/app.js', '/style.css', '/help.css', '/api/status', '/api/routes']) assert.equal(isRootAdminRequest(path), true);
  for (const path of ['/charity/key/System/Info', '/gateway/', '/api-node/key/']) assert.equal(isRootAdminRequest(path), false);
});

test('every file the admin page is made of is on the one list the server goes by', () => {
  // A file in web/ that is not on the list would be answered 404, and on a panel served at the root
  // of its domain it would be taken for a node path.
  const files = fs.readdirSync(new URL('../web/', import.meta.url)).filter(name => name !== 'index.html').map(name => `/${name}`).sort();
  assert.deepEqual(Object.keys(UI_FILES).sort(), files);
  for (const file of files) {
    assert.equal(isRootAdminRequest(file), true, file);
    assert.match(UI_FILES[file], file.endsWith('.js') ? /^text\/javascript; charset=utf-8$/ : /^text\/css; charset=utf-8$/, file);
  }
});

test('legacy random admin paths remain compatible', () => {
  assert.equal(normalizeAdminPath('admin-secret'), '/admin-secret');
  assert.equal(normalizeAdminPath('/admin-secret/'), '/admin-secret');
  assert.equal(normalizeAdminPath(''), '/');
  assert.equal(adminRelative('/admin-secret/api/status', '/admin-secret'), '/api/status');
  assert.equal(adminRelative('/other/api/status', '/admin-secret'), null);
  assert.equal(adminRelative('/api/status', '/'), '/api/status');
});
