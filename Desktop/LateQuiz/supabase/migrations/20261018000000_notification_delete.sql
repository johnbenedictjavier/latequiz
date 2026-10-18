-- Allow admins to delete their own notifications.
--
-- LQ_notifications previously had only SELECT and UPDATE policies
-- (lq_notifications_recipient_read / lq_notifications_recipient_update), so a
-- client-side delete silently affected zero rows under RLS. This adds a matching
-- DELETE policy scoped exactly like the existing ones: admin recipients, limited
-- to broadcast rows (recipient_id is null) or rows addressed to the caller.

drop policy if exists lq_notifications_recipient_delete on public."LQ_notifications";
create policy lq_notifications_recipient_delete on public."LQ_notifications"
for delete to authenticated
using (
  recipient_role = 'admin'
  and public."LQ_is_admin"()
  and (recipient_id is null or recipient_id = auth.uid())
);
