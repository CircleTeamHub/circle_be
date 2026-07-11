-- Add PROFILE_LIKE to the NotificationType enum so user-profile likes
-- (POST /user/:id/like → receivedLikeCount) can raise an interaction
-- notification that lights the bell list, the discover tab badge, and the
-- in-app snackbar — same channel as TRACE_LIKE.
ALTER TYPE "NotificationType" ADD VALUE IF NOT EXISTS 'PROFILE_LIKE';
