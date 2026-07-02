import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import managerModule from '../app/licensing/manager.cjs';
import { createTestLicense, getTestTrustedKeys } from '../tools/lib/test_license.mjs';

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const testRoot = path.join(projectRoot, 'output', 'license-manager-test');
const safeStorage = {
  isEncryptionAvailable: () => true,
  encryptString: (text) => Buffer.from(text, 'utf8'),
  decryptString: (buffer) => buffer.toString('utf8'),
};

function createManager(context) {
  fs.mkdirSync(testRoot, { recursive: true });
  const storeDir = fs.mkdtempSync(path.join(testRoot, 'case-'));
  context.after(() => fs.rmSync(storeDir, { recursive: true, force: true }));
  const manager = new managerModule.LicenseManager({
      app: { getPath: () => storeDir },
      safeStorage,
      apiUrl: 'http://127.0.0.1:1',
      appVersion: 'test',
    });
  manager.trustedKeys = getTestTrustedKeys();
  return {
    manager,
    storePath: path.join(storeDir, 'license.dat'),
  };
}

test('clock rollback blocks local use until signed online refresh succeeds', async (context) => {
  const { manager, storePath } = createManager(context);
  const initialToken = createTestLicense();
  manager.storage.write({
    token: initialToken,
    lastSeenAt: new Date(Date.now() + 86400000).toISOString(),
  });

  const blocked = await manager.inspect({ refreshIfNeeded: false });
  assert.equal(blocked.status, 'CLOCK_ROLLBACK');
  assert.equal(blocked.usable, false);

  const refreshedToken = createTestLicense({ licenseId: 'refreshed' });
  manager.api.refresh = async () => ({
    token: refreshedToken,
    serverTime: new Date().toISOString(),
  });
  const refreshed = await manager.inspect({ refreshIfNeeded: true });
  assert.equal(refreshed.usable, true);

  const persisted = JSON.parse(safeStorage.decryptString(fs.readFileSync(storePath)));
  assert.ok(Date.parse(persisted.lastSeenAt) < Date.now() + 5 * 60 * 1000);
});

test('offline request and imported device-bound license work without refresh', async (context) => {
  const { manager } = createManager(context);
  const request = manager.createOfflineRequest();
  assert.equal(request.deviceId, manager.deviceId);
  assert.equal(request.product, 'gaokao-score-agent');

  const offlineToken = createTestLicense({
    mode: 'offline',
    licenseId: 'offline-test',
    customer: '离线授权测试',
  });
  const imported = await manager.importOfflineLicense(JSON.stringify({
    v: 1,
    product: 'gaokao-score-agent',
    token: offlineToken,
  }));
  assert.equal(imported.usable, true);
  assert.equal(imported.mode, 'offline');
  assert.equal(imported.customer, '离线授权测试');
});
