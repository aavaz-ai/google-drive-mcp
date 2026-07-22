import { describe, expect, it } from "vitest";

import {
  readManagedConnectorBearer,
  validateManagedConnectorBearer,
} from "../../src/managedAuth.js";
import { GOOGLE_DRIVE_OAUTH_BEARER_ENV } from "../../src/managedContract.js";
import { GoogleDriveMcpError } from "../../src/managedErrors.js";

describe("bearer contract", () => {
  it.each([undefined, "", "   ", "contains spaces", "line\nbreak"])(
    "fails closed before startup for %j",
    (value) => {
      expect(() => validateManagedConnectorBearer(value)).toThrowError(GoogleDriveMcpError);
      try {
        validateManagedConnectorBearer(value);
      } catch (error) {
        expect(error).toMatchObject({ code: "AUTHENTICATION_FAILED" });
      }
    },
  );

  it("reads and trims only the dedicated bearer environment variable", () => {
    expect(readManagedConnectorBearer({ [GOOGLE_DRIVE_OAUTH_BEARER_ENV]: "  token_abc-123._~+/=  " })).toBe(
      "token_abc-123._~+/=",
    );
  });
});
