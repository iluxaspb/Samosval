-- Сброс таймера ходки становится правом в матрице role_permissions.
-- Раньше сброс был жёстко доступен только роли admin (line-store проверял
-- profile.role === 'admin'). Здесь сохраняем фактическое поведение как дефолт:
-- включено только admin, остальные роли — default deny.
BEGIN;

-- Новое право для всех ролей, кроме admin (админ и так имеет полный доступ,
-- а roleView для admin не читает строки). Остальным ролям явно ставим false,
-- чтобы право появилось в матрице админки выключенным.
INSERT INTO role_permissions(role, action, allowed)
SELECT role, 'line_timer_reset', false
FROM (SELECT DISTINCT role FROM role_permissions) src
WHERE role <> 'admin'
ON CONFLICT (role, action) DO NOTHING;

COMMIT;
