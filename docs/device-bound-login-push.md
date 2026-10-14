# Device-bound login alerts

Deploy backend migration `20261014140000_device_bound_push` before the updated client. The nullable device key is derived from the signed app session, never from a client-supplied device ID. Existing unbound push addresses remain usable for ordinary notifications, but cannot receive security alerts until registered from a bound session.

Registration returns `deviceBound`. The client upgrades cached registrations once acknowledged; old-server responses do not permanently suppress the upgrade. Revoking a device disables its addresses. Login-challenge and device-added alerts require both live device trust and an active app session, and share the account authentication lock with registration and remote removal.

`test/device-bound-push.e2e-spec.ts` runs in the normal fresh-database CI harness. It covers the HTTP session binding, legacy/expired exclusions, remote removal, re-registration denial and a concurrent removal/push/registration barrier.
