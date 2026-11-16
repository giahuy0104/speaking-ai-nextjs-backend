import assert from "node:assert/strict";
import { readdirSync, readFileSync, statSync } from "node:fs";
import path from "node:path";
import test from "node:test";
import { openApiDocument } from "./document";

const API_DIR = path.join(process.cwd(), "src", "app", "api");
const HTTP_METHODS = ["GET", "HEAD", "POST", "PUT", "PATCH", "DELETE"];

function routeFiles(dir: string): string[] {
  return readdirSync(dir).flatMap((entry) => {
    const full = path.join(dir, entry);
    if (statSync(full).isDirectory()) {
      return routeFiles(full);
    }
    return entry === "route.ts" ? [full] : [];
  });
}

function openApiPathFor(file: string) {
  const relative = path.relative(API_DIR, path.dirname(file)).split(path.sep).join("/");
  return `/api/${relative}`.replace(/\[([^\]]+)\]/g, "{$1}");
}

function exportedMethods(file: string) {
  const source = readFileSync(file, "utf8");
  return HTTP_METHODS.filter((method) =>
    new RegExp(`export\\s+(async\\s+)?(function|const)\\s+${method}\\b|export\\s*\\{[^}]*\\b${method}\\b`).test(source),
  );
}

const paths = openApiDocument.paths as Record<string, Record<string, unknown>>;

test("every API route handler method is documented", () => {
  const missing: string[] = [];
  for (const file of routeFiles(API_DIR)) {
    const apiPath = openApiPathFor(file);
    for (const method of exportedMethods(file)) {
      if (!paths[apiPath]?.[method.toLowerCase()]) {
        missing.push(`${method} ${apiPath}`);
      }
    }
  }
  assert.deepEqual(missing, []);
});

test("every documented operation exists in the code", () => {
  const files = new Map(routeFiles(API_DIR).map((file) => [openApiPathFor(file), exportedMethods(file)]));
  const stale: string[] = [];
  for (const [apiPath, item] of Object.entries(paths)) {
    const methods = files.get(apiPath);
    for (const key of Object.keys(item)) {
      if (key === "parameters") continue;
      if (!methods?.includes(key.toUpperCase())) {
        stale.push(`${key.toUpperCase()} ${apiPath}`);
      }
    }
  }
  assert.deepEqual(stale, []);
});

test("every $ref points to a defined component", () => {
  const json = JSON.stringify(openApiDocument);
  const components = openApiDocument.components as Record<string, Record<string, unknown>>;
  const refs = [...json.matchAll(/"\$ref":"#\/components\/(\w+)\/(\w+)"/g)];
  const broken = refs
    .filter(([, section, name]) => !components[section]?.[name])
    .map(([, section, name]) => `${section}/${name}`);
  assert.deepEqual([...new Set(broken)], []);
});

test("operationIds are unique", () => {
  const ids = Object.values(paths).flatMap((item) =>
    Object.values(item)
      .map((operation) => (operation as { operationId?: string }).operationId)
      .filter(Boolean),
  );
  assert.equal(new Set(ids).size, ids.length);
});
