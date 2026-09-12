export function validateProvisioningEnvironment(env) {
  const keys = ['DB_HOST', 'DB_NAME', 'DB_USER', 'DB_PASSWORD'];
  if (keys.some((key) => !env[key])) return 'DATABASE_CONFIGURATION_MISSING';
  if ([...keys, 'DB_PORT'].some((key) => env[key]?.trim() === '[SENSITIVE]')) return 'VERCEL_SENSITIVE_VALUES_REDACTED';
  const port = Number(env.DB_PORT || 5432);
  if (!Number.isInteger(port) || port < 1 || port > 65535) return 'DATABASE_PORT_INVALID';
  return null;
}
