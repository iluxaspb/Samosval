// Definitions for the host's existing Admin > Permissions, not a second admin UI.
export const RESOURCES = Object.freeze({
  request: 'Заявки', equipment: 'Техника', workers: 'Рабочие', engineers: 'ИТР',
  materials: 'Материалы', plan: 'Плановые объёмы', actual: 'Объёмы за смену',
  settings: 'Настройки объекта', table: 'Данные таблицы', format: 'Оформление таблицы', sheets: 'Листы',
});
export const PERMISSIONS = Object.freeze({
  ...Object.fromEntries(Object.entries(RESOURCES).flatMap(([key, label]) => [
    [`tabel_v2_${key}_view`, `${label}: просмотр`], [`tabel_v2_${key}_edit`, `${label}: изменение`],
  ])),
  tabel_v2_past_edit: 'Изменять прошлые смены',
  tabel_v2_closed_edit: 'Изменять закрытые смены',
  tabel_v2_delete: 'Удалять данные',
  tabel_v2_report_create: 'Формировать отчёт',
  tabel_v2_report_share: 'Отправлять отчёт',
  tabel_v2_history_view: 'Просматривать историю',
  tabel_v2_conflict_resolve: 'Разрешать конфликты',
  tabel_v2_permissions_manage: 'Управлять правами табеля',
});
export function can(context, permission, objectId) {
  if (!context?.loaded || context.status !== 'active' || !context.uid || !Object.hasOwn(PERMISSIONS, permission)) return false;
  if (context.role === 'admin') return true;
  if (!objectId || !Array.isArray(context.objectIds) || !context.objectIds.includes(objectId)) return false;
  const override = context.overrides?.[permission];
  if (override === false) return false;
  return override === true || (context.actions || []).includes(permission);
}
export function canEdit(context, resource, shift, today) {
  if (!Object.hasOwn(RESOURCES, resource)) return false;
  if (!/^\d{4}-\d{2}-\d{2}$/.test(today || '')) return false;
  return can(context, `tabel_v2_${resource}_view`, shift.objectId) &&
    can(context, `tabel_v2_${resource}_edit`, shift.objectId) &&
    (shift.date >= today || can(context, 'tabel_v2_past_edit', shift.objectId)) &&
    (!shift.closed || can(context, 'tabel_v2_closed_edit', shift.objectId));
}
