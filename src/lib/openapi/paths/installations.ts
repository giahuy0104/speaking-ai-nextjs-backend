import {
  INSTALLATION_SECURITY,
  INSTALL_AUTH_ERRORS,
  enumOf,
  errorResponse,
  jsonBody,
  jsonResponse,
  object,
  ref,
  str,
  type OpenApiObject,
} from "../helpers";

const TAG = "Installations";

export const installationPaths: OpenApiObject = {
  "/api/installations/register": {
    post: {
      tags: [TAG],
      summary: "Đăng ký cài đặt app",
      description:
        "Lần đầu mở app: tạo `installationSecret` ngẫu nhiên, lưu an toàn trên máy, rồi gọi API này để lấy cặp token. Gọi lại với cùng secret trả token mới (idempotent). Giới hạn 12 lần/phút/IP.",
      operationId: "registerInstallation",
      requestBody: jsonBody(
        object(
          {
            clientId: str("`<platform>_` + 8–180 ký tự `[A-Za-z0-9._:-]`.", {
              pattern: "^(ios|android|web)_[A-Za-z0-9._:-]{8,180}$",
            }),
            platform: enumOf(["ios", "android", "web"]),
            installationSecret: str("32–180 ký tự `[A-Za-z0-9_-]`. Không bao giờ gửi lại cho bên thứ ba.", {
              pattern: "^[A-Za-z0-9_-]{32,180}$",
            }),
            appVersion: str("Tối đa 80 ký tự.", { maxLength: 80 }),
          },
          ["clientId", "platform", "installationSecret"],
        ),
        true,
        {
          clientId: "android_6f1c2a9e-4b7d-4f0a-9c3e-1a2b3c4d5e6f",
          platform: "android",
          installationSecret: "q8Vb3nR1sT6uW9xY2zA5cD7eF0gH4jK8",
          appVersion: "1.4.0",
        },
      ),
      responses: {
        "201": jsonResponse("Cặp token mới.", ref("TokenSession")),
        "400": errorResponse("Dữ liệu không hợp lệ (`BAD_REQUEST`)."),
        "409": errorResponse("clientId đã đăng ký với secret khác (`INSTALLATION_ALREADY_REGISTERED`)."),
        "429": errorResponse("Quá nhiều lần đăng ký (`RATE_LIMITED`).", {
          "Retry-After": { $ref: "#/components/headers/RetryAfter" },
        }),
        "503": INSTALL_AUTH_ERRORS["503"],
      },
    },
  },
  "/api/installations/refresh": {
    post: {
      tags: [TAG],
      summary: "Làm mới access token",
      description: "Refresh token chỉ dùng được một lần; luôn lưu cặp token mới trả về.",
      operationId: "refreshInstallation",
      requestBody: jsonBody(object({ refreshToken: str() }, ["refreshToken"])),
      responses: {
        "200": jsonResponse("Cặp token mới.", ref("TokenSession")),
        "401": errorResponse("Refresh token sai, hết hạn, đã thu hồi hoặc đã dùng (`UNAUTHORIZED`)."),
        "404": errorResponse("Cài đặt không còn tồn tại (`DEVICE_NOT_REGISTERED`)."),
        "503": INSTALL_AUTH_ERRORS["503"],
      },
    },
  },
  "/api/installations/revoke": {
    delete: {
      tags: [TAG],
      summary: "Thu hồi phiên cài đặt (đăng xuất)",
      operationId: "revokeInstallation",
      security: INSTALLATION_SECURITY,
      responses: {
        "200": jsonResponse("Đã thu hồi.", object({ revoked: { const: true }, requestId: str() }, ["revoked", "requestId"])),
        "401": INSTALL_AUTH_ERRORS["401"],
        "503": INSTALL_AUTH_ERRORS["503"],
      },
    },
  },
  "/api/devices/register": {
    post: {
      tags: [TAG],
      summary: "Gửi thông tin phần cứng Android",
      operationId: "registerDevice",
      security: INSTALLATION_SECURITY,
      requestBody: jsonBody(
        object(
          {
            clientId: str(undefined, { pattern: "^android_[A-Za-z0-9._:-]+$", maxLength: 120 }),
            device: ref("AndroidDeviceHardware"),
          },
          ["clientId", "device"],
        ),
        true,
        {
          clientId: "android_6f1c2a9e-4b7d-4f0a-9c3e-1a2b3c4d5e6f",
          device: {
            manufacturer: "samsung",
            brand: "samsung",
            model: "SM-X200",
            androidVersion: "14",
            sdkInt: 34,
            supportedAbis: ["arm64-v8a", "armeabi-v7a"],
            totalRamBytes: 4000000000,
            availableRamBytes: 1500000000,
            totalStorageBytes: 64000000000,
            availableStorageBytes: 20000000000,
          },
        },
      ),
      responses: {
        "200": jsonResponse("Hồ sơ thiết bị.", object({ device: ref("DeviceProfile") }, ["device"])),
        "400": errorResponse("Một field không hợp lệ (`BAD_REQUEST`)."),
        ...INSTALL_AUTH_ERRORS,
      },
    },
  },
};
