export const sheetManager = actor => actor?.status === 'active' && ['admin','foreman'].includes(actor.role);
export function sheetVisible(actor, config, id) {
  if(!actor?.uid || actor.status!=='active' || !actor.tabAccess)return false;
  if(sheetManager(actor))return true;
  const access=config?.sheetAccess?.[id];
  return access?.users?.[actor.uid]===true || access?.roles?.[actor.role]===true;
}
