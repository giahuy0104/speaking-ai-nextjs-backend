import { mkdir, readFile, writeFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import path from "node:path";
import ts from "typescript";

// Compile the canonical, dependency-free pool parser for the standalone Node image.
const root = fileURLToPath(new URL("../", import.meta.url));
const source = await readFile(path.join(root, "src/lib/ai/cloudflare/accountConfig.ts"), "utf8");
const result = ts.transpileModule(source, { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ESNext } });
const directory = path.join(root, ".deployment-runtime");
await mkdir(directory, { recursive: true });
await writeFile(path.join(directory, "pool-config.mjs"), result.outputText);
