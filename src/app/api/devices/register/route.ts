import {
  DeviceRegistrationValidationError,
  parseAndroidDeviceRegistration,
} from "@/lib/deviceRegistration";
import { registerDeviceHardware } from "@/lib/deviceProfiles";
import { AppError, toErrorResponse } from "@/lib/errors";
import { requireInstallationAccess } from "@/lib/installationAuth";
import { getRequestId, logEvent, withRequestId } from "@/lib/observability";

export const runtime = "nodejs";

export async function POST(request: Request) {
  const requestId = getRequestId(request);

  try {
    const body = await request.json().catch(() => null);
    const registration = parseAndroidDeviceRegistration(body);
    const access = await requireInstallationAccess(
      request,
      registration.clientId,
    );
    const device = await registerDeviceHardware(
      access.clientId,
      registration.hardware,
    );

    logEvent("info", "android_device_registered", {
      requestId,
      clientId: registration.clientId,
      model: registration.hardware.model,
      sdkInt: registration.hardware.sdkInt,
    });

    return withRequestId(Response.json({ device }), requestId);
  } catch (error) {
    if (error instanceof AppError) {
      return withRequestId(toErrorResponse(error, requestId), requestId);
    }
    if (error instanceof DeviceRegistrationValidationError) {
      return withRequestId(
        Response.json(
          {
            error: {
              code: "BAD_REQUEST",
              message: error.message,
              requestId,
            },
          },
          { status: 400 },
        ),
        requestId,
      );
    }

    logEvent("error", "android_device_registration_failed", {
      requestId,
      error,
    });
    return withRequestId(
      Response.json(
        {
          error: {
            code: "INTERNAL_ERROR",
            message: "Không lưu được thông tin thiết bị.",
            requestId,
          },
        },
        { status: 500 },
      ),
      requestId,
    );
  }
}
