import {
  apiDocsEnabled,
  docsDisabledResponse,
  htmlResponse,
  redocHtml,
} from "@/lib/openapi/docsHtml";

export const dynamic = "force-dynamic";

export function GET() {
  if (!apiDocsEnabled()) {
    return docsDisabledResponse();
  }
  return htmlResponse(redocHtml());
}
