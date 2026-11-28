-- Право «Кнопка Дубликат» (самосвал не приехал / не вернулся на линию).
--
-- Новое действие линии `no-return`: явная отметка «самосвал не приехал»
-- ставится кнопкой на карточке, снимается кнопкой «Приехал». Отдельное право
-- не даёт лопатёру и наблюдателю менять статус машины.
--
-- Правило default deny: строка появляется у всех не-admin ролей выключенной,
-- затем включается по спецификации (мастер, прораб, старший прораб).
-- admin строкой не заводится: roleView('admin') и так возвращает все ACTIONS.
BEGIN;

INSERT INTO role_permissions(role, action, allowed)
SELECT r.role, 'action_no_return', false
  FROM (VALUES ('senior_foreman'),('foreman'),('master'),('lopater'),('viewer')) AS r(role)
ON CONFLICT (role, action) DO NOTHING;

UPDATE role_permissions
   SET allowed = true
 WHERE action = 'action_no_return'
   AND role IN ('senior_foreman','foreman','master');

-- Версия прав для матрицы админки: новая строка должна быть видна сразу.
INSERT INTO role_permission_versions(role)
VALUES ('senior_foreman'),('foreman'),('master'),('lopater'),('viewer')
ON CONFLICT DO NOTHING;

COMMIT;
