import assert from 'node:assert/strict';

const baseUrl = process.env.API_BASE_URL || 'http://127.0.0.1:3001';
const suffix = `${Date.now()}${Math.floor(Math.random() * 10000)}`;
const email = `ci-${suffix}@example.test`;
const username = `ci_${suffix}`;
const password = 'Waraxe-ci-test-Password-2026';

async function request(path, { token, method = 'GET', body } = {}) {
  const response = await fetch(`${baseUrl}${path}`, {
    method,
    headers: {
      ...(body ? { 'content-type': 'application/json' } : {}),
      ...(token ? { authorization: `Bearer ${token}` } : {})
    },
    ...(body ? { body: JSON.stringify(body) } : {})
  });
  const text = await response.text();
  let data;
  try { data = text ? JSON.parse(text) : {}; } catch { data = text; }
  assert.ok(response.ok, `${method} ${path} failed (${response.status}): ${JSON.stringify(data)}`);
  return data;
}

const health = await request('/api/health');
assert.equal(health.ok, true);

const registration = await request('/api/auth/register', {
  method: 'POST', body: { email, username, password }
});
assert.ok(registration.token, 'registration should return JWT');
const token = registration.token;

const me = await request('/api/me', { token });
assert.equal(me.user.email, email);
assert.ok(me.character, 'new account should receive a character');
assert.equal(me.character.level, 1);

const equipment = await request('/api/equipment', { token });
assert.ok(Array.isArray(equipment.equipped));
assert.ok(Array.isArray(equipment.owned));

const hunt = await request('/api/game/hunt', {
  token, method: 'POST', body: { enemy: 'griffin' }
});
assert.ok(hunt.character, 'hunt should return updated character');
assert.ok(Number.isFinite(hunt.character.gold));

const login = await request('/api/auth/login', {
  method: 'POST', body: { email, password }
});
assert.ok(login.token, 'login should return JWT');

console.log('API integration tests passed: health, registration, authenticated profile, starter equipment, hunting, login.');
