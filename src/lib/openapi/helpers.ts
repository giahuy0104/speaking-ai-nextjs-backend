// Small builders that keep the hand-written OpenAPI paths short and uniform.

export type OpenApiObject = Record<string, unknown>;

export function ref(schemaName: string): OpenApiObject {
  return { $ref: `#/components/schemas/${schemaName}` };
}

const REQUEST_ID_HEADER = { "X-Request-Id": { $ref: "#/components/headers/XRequestId" } };

export function jsonResponse(
  description: string,
  schema: OpenApiObject,
  headers: OpenApiObject = {},
): OpenApiObject {
  return {
    description,
    headers: { ...REQUEST_ID_HEADER, ...headers },
    content: { "application/json": { schema } },
  };
}

export function errorResponse(
  description: string,
  headers: OpenApiObject = {},
): OpenApiObject {
  return jsonResponse(description, ref("ErrorEnvelope"), headers);
}

export function binaryResponse(
  description: string,
  contentTypes: string[],
  headers: OpenApiObject = {},
): OpenApiObject {
  return {
    description,
    headers: { ...REQUEST_ID_HEADER, ...headers },
    content: Object.fromEntries(
      contentTypes.map((type) => [type, { schema: { type: "string", format: "binary" } }]),
    ),
  };
}

export function jsonBody(
  schema: OpenApiObject,
  required = true,
  example?: unknown,
): OpenApiObject {
  return {
    required,
    content: {
      "application/json": example === undefined ? { schema } : { schema, example },
    },
  };
}

export function pathParam(name: string, description: string): OpenApiObject {
  return { name, in: "path", required: true, description, schema: { type: "string" } };
}

export function queryParam(
  name: string,
  description: string,
  schema: OpenApiObject = { type: "string" },
  required = false,
): OpenApiObject {
  return { name, in: "query", required, description, schema };
}

export function headerParam(
  name: string,
  description: string,
  required = false,
  schema: OpenApiObject = { type: "string" },
): OpenApiObject {
  return { name, in: "header", required, description, schema };
}

export function object(
  properties: OpenApiObject,
  required: string[] = [],
  extra: OpenApiObject = {},
): OpenApiObject {
  return { type: "object", properties, ...(required.length ? { required } : {}), ...extra };
}

export const str = (description?: string, extra: OpenApiObject = {}): OpenApiObject => ({
  type: "string",
  ...(description ? { description } : {}),
  ...extra,
});
export const num = (description?: string): OpenApiObject => ({
  type: "number",
  ...(description ? { description } : {}),
});
export const int = (description?: string): OpenApiObject => ({
  type: "integer",
  ...(description ? { description } : {}),
});
export const bool = (description?: string): OpenApiObject => ({
  type: "boolean",
  ...(description ? { description } : {}),
});
export const enumOf = (values: string[], description?: string): OpenApiObject => ({
  type: "string",
  enum: values,
  ...(description ? { description } : {}),
});
export const arrayOf = (items: OpenApiObject): OpenApiObject => ({ type: "array", items });
export const nullable = (schema: OpenApiObject): OpenApiObject => ({
  anyOf: [schema, { type: "null" }],
});

/** Admin cookie errors every admin route can return. */
export const ADMIN_AUTH_ERRORS: OpenApiObject = {
  "401": errorResponse("Không có hoặc hết hạn cookie phiên admin (`UNAUTHORIZED`)."),
  "503": errorResponse("Server chưa cấu hình ADMIN_USERNAME / ADMIN_PASSWORD (`ADMIN_NOT_CONFIGURED`)."),
};

/** Installation bearer errors from requireInstallationAccess. */
export const INSTALL_AUTH_ERRORS: OpenApiObject = {
  "401": errorResponse("Thiếu, sai, hết hạn hoặc đã thu hồi access token (`UNAUTHORIZED`)."),
  "403": errorResponse("`clientId` gửi lên khác clientId trong token (`FORBIDDEN`)."),
  "503": errorResponse("Server thiếu INSTALLATION_AUTH_SECRET (`AUTH_CONFIGURATION_ERROR`)."),
};

/** Scoped audio-session upload token errors from authorizeAudioSessionRequest. */
export const AUDIO_SESSION_AUTH_ERRORS: OpenApiObject = {
  "401": errorResponse("Thiếu hoặc sai upload token (`AUDIO_SESSION_UNAUTHORIZED`)."),
  "403": errorResponse("Token không thuộc session/clientId này (`AUDIO_SESSION_UNAUTHORIZED`)."),
  "410": errorResponse("Upload token / session đã hết hạn (`AUDIO_SESSION_EXPIRED`)."),
  "503": errorResponse("Server chưa cấu hình secret ký upload token (`AUDIO_SESSION_UNAUTHORIZED`)."),
};

export const RETRY_AFTER = { "Retry-After": { $ref: "#/components/headers/RetryAfter" } };

export const ADMIN_SECURITY = [{ AdminSession: [] }];
export const AUDIO_SESSION_SECURITY = [{ AudioSessionToken: [] }];
export const INSTALLATION_SECURITY = [{ InstallationBearer: [] }];
export const CRON_SECURITY = [{ CronSecret: [] }];
