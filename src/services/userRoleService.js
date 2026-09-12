// users.role_id remains the default, including before the local migration runs.
export const assignedRoles = (user, memberships = []) =>
  [...new Set([Number(user.role_id), ...memberships.map(Number)])].filter(Number.isInteger).sort();

export async function loadUserRoles(queryable, user) {
  const schema = await queryable.query("SELECT to_regclass('public.user_roles') AS membership_table");
  if (!schema.rows[0]?.membership_table) return assignedRoles(user);
  const result = await queryable.query("SELECT role_id FROM public.user_roles WHERE user_id=$1", [user.id]);
  return assignedRoles(user, result.rows.map((row) => row.role_id));
}

export function activateRole(user, roles, requested = user.role_id) {
  const role = Number(requested);
  if (!Number.isInteger(role) || !roles.includes(role)) {
    throw Object.assign(new Error("Role is not assigned to this account"), { status: 403 });
  }
  return { ...user, primary_role: Number(user.role_id), roles, active_role: role, role_id: role };
}
