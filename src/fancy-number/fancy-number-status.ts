export type FancyNumberStatusSnapshot = {
  fancyNumber: boolean | null;
  fancyNumberExpiresAt?: Date | null;
  fancyNumberPermanent?: boolean;
};

export function resolveEffectiveFancyNumber(
  snapshot: FancyNumberStatusSnapshot,
  now = new Date(),
): boolean {
  if (!snapshot.fancyNumber) {
    return false;
  }
  if (snapshot.fancyNumberPermanent) {
    return true;
  }
  // Existing fancyNumber=true rows predate leases. The migration promotes
  // them to permanent; this fallback keeps rolling deployments compatible.
  if (!snapshot.fancyNumberExpiresAt) {
    return true;
  }
  return snapshot.fancyNumberExpiresAt.getTime() > now.getTime();
}
