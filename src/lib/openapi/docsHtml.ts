// Interactive API docs served the same way FastAPI serves /docs and /redoc:
// a tiny HTML shell that loads the viewer from jsDelivr and points it at
// /openapi.json. Nothing is bundled into the Next.js build.

export const OPENAPI_PATH = "/openapi.json";
export const API_DOCS_TITLE = "HuaMei Speaking AI API";

const SWAGGER_UI_VERSION = "5";
const REDOC_VERSION = "2";
const FAVICON_URL = "https://fastapi.tiangolo.com/img/favicon.png";

export function apiDocsEnabled() {
  return process.env.API_DOCS_ENABLED?.trim().toLowerCase() !== "false";
}

export function swaggerUiHtml() {
  const cdn = `https://cdn.jsdelivr.net/npm/swagger-ui-dist@${SWAGGER_UI_VERSION}`;
  return `<!DOCTYPE html>
<html lang="vi">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>${API_DOCS_TITLE} - Swagger UI</title>
  <link rel="shortcut icon" href="${FAVICON_URL}">
  <link rel="stylesheet" href="${cdn}/swagger-ui.css">
</head>
<body>
  <div id="swagger-ui"></div>
  <script src="${cdn}/swagger-ui-bundle.js"></script>
  <script>
    window.ui = SwaggerUIBundle({
      url: "${OPENAPI_PATH}",
      dom_id: "#swagger-ui",
      layout: "BaseLayout",
      deepLinking: true,
      showExtensions: true,
      showCommonExtensions: true,
      persistAuthorization: true,
      displayRequestDuration: true,
      presets: [SwaggerUIBundle.presets.apis, SwaggerUIBundle.SwaggerUIStandalonePreset],
    });
  </script>
</body>
</html>`;
}

export function redocHtml() {
  return `<!DOCTYPE html>
<html lang="vi">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>${API_DOCS_TITLE} - ReDoc</title>
  <link rel="shortcut icon" href="${FAVICON_URL}">
  <style>body { margin: 0; padding: 0; }</style>
</head>
<body>
  <noscript>ReDoc requires JavaScript.</noscript>
  <redoc spec-url="${OPENAPI_PATH}"></redoc>
  <script src="https://cdn.jsdelivr.net/npm/redoc@${REDOC_VERSION}/bundles/redoc.standalone.js"></script>
</body>
</html>`;
}

export function htmlResponse(html: string) {
  return new Response(html, {
    headers: {
      "Content-Type": "text/html; charset=utf-8",
      "Cache-Control": "no-cache",
    },
  });
}

export function docsDisabledResponse() {
  return Response.json({ error: "Not found" }, { status: 404 });
}
