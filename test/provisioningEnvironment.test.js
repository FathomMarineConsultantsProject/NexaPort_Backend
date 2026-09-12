import test from 'node:test';
import assert from 'node:assert/strict';
import { validateProvisioningEnvironment } from '../src/services/provisioningEnvironment.js';
const valid = { DB_HOST: 'localhost', DB_NAME: 'test', DB_USER: 'test', DB_PASSWORD: 'unit-test-only', DB_PORT: '5432' };
test('redacted Vercel values are rejected before a database connection is attempted', () => {
  for (const key of Object.keys(valid)) assert.equal(validateProvisioningEnvironment({ ...valid, [key]: '[SENSITIVE]' }), 'VERCEL_SENSITIVE_VALUES_REDACTED');
});
test('valid configuration, missing configuration, and malformed ports are distinguished', () => {
  assert.equal(validateProvisioningEnvironment(valid), null);
  assert.equal(validateProvisioningEnvironment({}), 'DATABASE_CONFIGURATION_MISSING');
  for (const port of ['not-a-port', '0', '65536']) assert.equal(validateProvisioningEnvironment({ ...valid, DB_PORT: port }), 'DATABASE_PORT_INVALID');
});
