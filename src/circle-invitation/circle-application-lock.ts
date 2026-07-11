export function circleApplicationLockKey(
  circleId: string,
  applicantId: string,
): string {
  return `circle-invite:${circleId}:${applicantId}`;
}
