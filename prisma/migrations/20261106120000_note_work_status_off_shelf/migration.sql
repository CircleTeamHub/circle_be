-- 场地状态新增「下架」,与开工/打烊并列。只加枚举值,不改已有数据。
ALTER TYPE "NoteWorkStatus" ADD VALUE IF NOT EXISTS 'OFF_SHELF';
