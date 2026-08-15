import assert from "node:assert/strict";
import test from "node:test";

import { isDatabaseTransferQuotaError } from "@/lib/db/errors";

test("recognizes Neon data transfer quota errors", () => {
  assert.equal(
    isDatabaseTransferQuotaError(
      new Error(
        'Server error (HTTP status 402): {"message":"Your project has exceeded the data transfer quota."}',
      ),
    ),
    true,
  );
});

test("does not classify unrelated database errors as quota errors", () => {
  assert.equal(
    isDatabaseTransferQuotaError({ statusCode: 500, message: "timeout" }),
    false,
  );
});
