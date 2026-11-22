-- Новая роль senior_foreman («старший прораб») по требованию владельца
-- (docs/test-3.3-requirements.md, «Окончательная иерархия ролей»).
-- Роли передаются ВСЕ фактические права роли foreman на момент миграции
-- (нельзя заменить настроенные владельцем права заводским набором) плюс
-- право сброса таймера ходки line_timer_reset. Роль foreman право сброса
-- НЕ получает. Существующие пользователи foreman не перекрашиваются:
-- перенос конкретных людей делает администратор через админку.
BEGIN;

-- Копируем все фактические строки прав foreman (включая исторические
-- выключенные: allowed=false сохраняется как есть).
INSERT INTO role_permissions(role, action, allowed)
SELECT 'senior_foreman', action, allowed
FROM role_permissions
WHERE role = 'foreman'
ON CONFLICT (role, action) DO NOTHING;

-- Сброс таймера ходки: старший прораб задумывался с этим правом (корона 👑).
INSERT INTO role_permissions(role, action, allowed)
VALUES ('senior_foreman', 'line_timer_reset', true)
ON CONFLICT (role, action) DO UPDATE SET allowed = true;

-- Явный запрет сброса для foreman, если строка ещё не существует
-- (существующее значение владельца не трогаем).
INSERT INTO role_permissions(role, action, allowed)
VALUES ('foreman', 'line_timer_reset', false)
ON CONFLICT (role, action) DO NOTHING;

-- Версия прав для матрицы админки.
INSERT INTO role_permission_versions(role) VALUES ('senior_foreman') ON CONFLICT DO NOTHING;

COMMIT;
