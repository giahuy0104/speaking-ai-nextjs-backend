import assert from "node:assert/strict";
import { afterEach, test } from "node:test";
import { loadTestPersistencePrefix, skipsPostResponsePersistence } from "./loadTestPersistence";

const ENV = "LOAD_TEST_SKIP_PERSISTENCE_CLIENT_PREFIX";

afterEach(() => {
  delete process.env[ENV];
});

test("persists every installation when the prefix is unset", () => {
  assert.equal(loadTestPersistencePrefix(), undefined);
  assert.equal(skipsPostResponsePersistence("web_k6_abc123"), false);
});

test("skips only installations whose clientId starts with the prefix", () => {
  process.env[ENV] = " web_k6_ ";
  assert.equal(skipsPostResponsePersistence("web_k6_abc123"), true);
  assert.equal(skipsPostResponsePersistence("web_real-device"), false);
  assert.equal(skipsPostResponsePersistence("android_web_k6_abc"), false);
  assert.equal(skipsPostResponsePersistence(undefined), false);
});

test("ignores a prefix too short to single out test installations", () => {
  for (const value of ["", "   ", "web_", "web"]) {
    process.env[ENV] = value;
    assert.equal(loadTestPersistencePrefix(), undefined);
    assert.equal(skipsPostResponsePersistence("web_real-device"), false);
  }
});
