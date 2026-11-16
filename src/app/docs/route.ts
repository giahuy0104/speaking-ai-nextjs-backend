import {
  apiDocsEnabled,
  docsDisabledResponse,
  htmlResponse,
  swaggerUiHtml,
} from "@/lib/openapi/docsHtml";

export const dynamic = "force-dynamic";

export function GET() {
  if (!apiDocsEnabled()) {
    return docsDisabledResponse();
  }
  return htmlResponse(swaggerUiHtml());
}
