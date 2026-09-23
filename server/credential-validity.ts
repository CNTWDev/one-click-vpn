export const CREDENTIAL_VALIDITY_DAYS = 365;
export const EXPIRY_WARNING_DAYS = 30;

export function defaultCredentialExpiry(issuedAt = new Date()): string {
  return new Date(issuedAt.getTime() + CREDENTIAL_VALIDITY_DAYS * 86_400_000).toISOString();
}
