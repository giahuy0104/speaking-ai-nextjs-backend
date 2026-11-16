import { apiDocsEnabled, docsDisabledResponse } from "@/lib/openapi/docsHtml";
import { openApiDocument } from "@/lib/openapi/document";

export const dynamic = "force-dynamic";

export function GET() {
  if (!apiDocsEnabled()) {
    return docsDisabledResponse();
  }
  return Response.json(openApiDocument, {
    headers: { "Cache-Control": "no-cache" },
  });
}
