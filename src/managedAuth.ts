import { GOOGLE_DRIVE_OAUTH_BEARER_ENV } from './managedContract.js';
import { GoogleDriveMcpError } from './managedErrors.js';

/** Validate the short-lived bearer injected by Enterpret's connector runtime. */
export function validateManagedConnectorBearer(value: string | undefined): string {
  if (value === undefined || value.trim().length === 0) {
    throw new GoogleDriveMcpError('AUTHENTICATION_FAILED');
  }
  const bearer = value.trim();
  if (!/^[A-Za-z0-9\-._~+/]+=*$/.test(bearer)) {
    throw new GoogleDriveMcpError('AUTHENTICATION_FAILED');
  }
  return bearer;
}

/** Read only the bearer supplied by the Enterpret bring-token manifest. */
export function readManagedConnectorBearer(env: NodeJS.ProcessEnv = process.env): string {
  return validateManagedConnectorBearer(env[GOOGLE_DRIVE_OAUTH_BEARER_ENV]);
}
