-- F-11: gate the `whatsup` (WhatsApp) contact field behind a privacy toggle,
-- consistent with showWechat / showQQ. Default true preserves current visibility;
-- users can now hide it like their other contact fields.
ALTER TABLE "UserPrivacySetting" ADD COLUMN "showWhatsup" BOOLEAN NOT NULL DEFAULT true;
