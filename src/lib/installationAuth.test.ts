import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import test from "node:test";

function runAuthenticationScenario(body: string) {
  const result = spawnSync(process.execPath, ["--import", "tsx", "-e", String.raw`
    const Module = require('node:module');
    const originalLoad = Module._load;
    Module._load = function(id, ...args) { return id === 'server-only' ? {} : originalLoad.call(this, id, ...args); };
    const assert = require('node:assert/strict');
    Object.assign(process.env, {
      NODE_ENV: 'production', PERSISTENCE_BACKEND: 'local', DATABASE_URL: '',
      INSTALLATION_AUTH_SECRET: 'auth-regression-secret-with-at-least-32-characters',
      INSTALLATION_AUTH_REQUIRED: 'false',
    });
    const auth = require('./src/lib/installationAuth.ts');
    const unauthorized = error => error.code === 'UNAUTHORIZED' && error.status === 401;
    (async () => { ${body} })().catch(error => { console.error(error); process.exitCode = 1; });
  `], { encoding: "utf8", timeout: 20_000, windowsHide: true });
  assert.equal(result.status, 0, result.stdout + result.stderr);
}

test("production rejects bare clientId even with auth explicitly disabled", () => {
  runAuthenticationScenario(String.raw`
    const request = new Request('https://example.test/api/history');
    for (const value of [undefined, 'false', 'invalid']) {
      if (value === undefined) delete process.env.INSTALLATION_AUTH_REQUIRED;
      else process.env.INSTALLATION_AUTH_REQUIRED = value;
      assert.equal(auth.getInstallationAuthConfig().required, true);
      await assert.rejects(auth.requireInstallationAccess(request, 'android_auth-test-device'), unauthorized);
    }
  `);
});

test("development retains explicit legacy access and validates its clientId", () => {
  runAuthenticationScenario(String.raw`
    process.env.NODE_ENV = 'development';
    const request = new Request('https://example.test/api/history');
    assert.deepEqual(await auth.requireInstallationAccess(request, 'android_auth-test-device'), {
      clientId: 'android_auth-test-device', legacy: true,
    });
    await assert.rejects(auth.requireInstallationAccess(request, 'bad-id'), unauthorized);
  `);
});

test("production auth fails closed for missing or invalid signing secret", () => {
  runAuthenticationScenario(String.raw`
    for (const value of ['', 'too-short']) {
      process.env.INSTALLATION_AUTH_SECRET = value;
      await assert.rejects(auth.requireInstallationAccess(new Request('https://example.test/api/history'),
        'android_auth-test-device'), error => error.code === 'AUTH_CONFIGURATION_ERROR' && error.status === 503);
    }
  `);
});

test("registered production tokens enforce ownership, refresh rotation and revocation", () => {
  runAuthenticationScenario(String.raw`
    const clientId = 'web_auth-regression-device';
    const tokens = await auth.registerInstallation({ clientId, platform: 'web', installationSecret: 'a'.repeat(48) });
    const request = token => new Request('https://example.test/api/history', { headers: { authorization: 'Bearer ' + token } });
    const secondTab = await auth.registerInstallation({ clientId, platform: 'web', installationSecret: 'a'.repeat(48), appVersion: '2' });
    assert.equal((await auth.requireInstallationAccess(request(secondTab.accessToken), clientId)).legacy, false);
    assert.deepEqual(await auth.requireInstallationAccess(request(tokens.accessToken), clientId), { clientId, platform: 'web', legacy: false });
    await assert.rejects(auth.requireInstallationAccess(request(tokens.accessToken), 'web_another-test-device'),
      error => error.code === 'FORBIDDEN' && error.status === 403);
    const refreshed = await auth.refreshInstallation(tokens.refreshToken);
    await assert.rejects(auth.requireInstallationAccess(request(tokens.accessToken), clientId), unauthorized);
    await assert.rejects(auth.refreshInstallation(tokens.refreshToken), unauthorized);
    assert.equal((await auth.requireInstallationAccess(request(refreshed.accessToken), clientId)).legacy, false);
    await auth.revokeInstallation(request(refreshed.accessToken));
    await assert.rejects(auth.requireInstallationAccess(request(refreshed.accessToken), clientId), unauthorized);
  `);
});

test("simultaneous registration is idempotent only for the same installation credential", () => {
  runAuthenticationScenario(String.raw`
    const registration = { clientId: 'web_concurrent-test-device', platform: 'web', installationSecret: 'a'.repeat(48) };
    const results = await Promise.all([auth.registerInstallation(registration), auth.registerInstallation(registration)]);
    for (const tokens of results) {
      const request = new Request('https://example.test/api/history', { headers: { authorization: 'Bearer ' + tokens.accessToken } });
      assert.equal((await auth.requireInstallationAccess(request, registration.clientId)).legacy, false);
    }
    const competing = await Promise.allSettled([
      auth.registerInstallation({ ...registration, clientId: 'web_competing-test-device' }),
      auth.registerInstallation({ ...registration, clientId: 'web_competing-test-device', installationSecret: 'b'.repeat(48) }),
    ]);
    assert.equal(competing.filter(result => result.status === 'fulfilled').length, 1);
    assert.equal(competing.find(result => result.status === 'rejected').reason.code, 'INSTALLATION_ALREADY_REGISTERED');
  `);
});
