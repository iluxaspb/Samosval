-- Параллельные смены, задача 17: права ACL смены (design §6).
--
-- Два новых действия серверной матрицы:
--   manage_shift_members — добавление/снятие участника смены;
--   force_transfer_truck — принудительный перенос техники в другую смену.
--
-- Правило default deny: строка появляется у всех не-admin ролей выключенной, и
-- только затем включается по спецификации. Роль сама по себе без права
-- недостаточна, поэтому дефолты ниже — часть контракта, а не удобство.
--
-- §6 «add/remove member: admin либо прораб + manage_shift_members»: прорабами
-- в проекте являются foreman и senior_foreman, поэтому право включено обоим.
-- §6 «force transfer: только admin/senior_foreman + force_transfer_truck»:
-- право включено только senior_foreman; foreman остаётся с выключенным правом,
-- и ACL дополнительно проверяет роль, а не одно право.
--
-- admin строкой не заводится: roleView('admin') и так возвращает все ACTIONS.
BEGIN;

INSERT INTO role_permissions(role, action, allowed)
SELECT r.role, a.action, false
  FROM (VALUES ('senior_foreman'),('foreman'),('master'),('lopater'),('viewer')) AS r(role)
 CROSS JOIN (VALUES ('manage_shift_members'),('force_transfer_truck')) AS a(action)
ON CONFLICT (role, action) DO NOTHING;

UPDATE role_permissions
   SET allowed = true
 WHERE action = 'manage_shift_members'
   AND role IN ('senior_foreman','foreman');

UPDATE role_permissions
   SET allowed = true
 WHERE action = 'force_transfer_truck'
   AND role = 'senior_foreman';

-- Версия прав для матрицы админки: новые строки должны быть видны сразу.
INSERT INTO role_permission_versions(role)
VALUES ('senior_foreman'),('foreman'),('master'),('lopater'),('viewer')
ON CONFLICT DO NOTHING;

COMMIT;
