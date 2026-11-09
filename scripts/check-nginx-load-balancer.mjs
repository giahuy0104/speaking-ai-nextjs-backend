import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";

const baseUrl = process.env.LB_CHECK_URL || `http://127.0.0.1:${process.env.NGINX_HTTP_PORT || 8080}`;
const expected = Number(process.env.LB_CHECK_MIN_INSTANCES || 2);
assert(Number.isInteger(expected) && expected > 0, "Expected instance count must be a positive integer.");
const instances = new Set();

for (let round = 0; round < 5; round++) {
  await Promise.all(Array.from({ length: Math.max(4, expected * 2) }, async () => {
    const requestId = `lb-check-${randomUUID()}`;
    const response = await fetch(new URL("/api/health", baseUrl), {
      headers: { "X-Request-Id": requestId, Origin: new URL(baseUrl).origin },
      signal: AbortSignal.timeout(10_000),
    });
    assert.equal(response.status, 200, "Backend health check failed.");
    assert.equal(response.headers.get("x-request-id"), requestId, "Request ID was not preserved.");
    assert.equal(response.headers.get("access-control-allow-origin"), new URL(baseUrl).origin, "Forwarded host/origin did not match.");
    assert.match(response.headers.get("cache-control") || "", /no-store/);
    const body = await response.json();
    assert.equal(body.status, "ok");
    assert.equal(typeof body.instance, "string");
    assert(body.instance.length > 0);
    instances.add(body.instance);
  }));
}

assert(instances.size >= expected, `Only ${instances.size}/${expected} backend instances received requests.`);
console.log(JSON.stringify({ status: "ok", baseUrl, instances: [...instances], requests: 5 * Math.max(4, expected * 2) }, null, 2));
