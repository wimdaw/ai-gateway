import assert from 'node:assert/strict'
import { onRequest } from '../cloud-functions/[[default]].js'

// These credentials are local test fixtures passed through the request context;
// the application bundle has no development or production password fallback.
const TEST_ENV = {
  ADMIN_USERNAME: 'local-test-admin',
  ADMIN_PASSWORD: 'local-only-test-password',
}

async function call(path, init = {}) {
  const request = new Request(`http://localhost:8088${path}`, init)
  return onRequest({ request, env: TEST_ENV })
}

async function runTests() {
  const missingCredentialsRes = await onRequest({
    request: new Request('http://localhost:8088/admin/login', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ username: 'admin', password: 'any-test-password' }),
    }),
    env: { ADMIN_USERNAME: '', ADMIN_PASSWORD: '' },
  })
  assert.equal(missingCredentialsRes.status, 500, 'login must fail closed without admin credentials')

  const loginPageRes = await call('/admin/login')
  assert.equal(loginPageRes.status, 200, 'login page should load')
  const loginHtml = await loginPageRes.text()
  assert.match(loginHtml, /登录/, 'login page should contain its title')

  const loginRes = await call('/admin/login', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      username: TEST_ENV.ADMIN_USERNAME,
      password: TEST_ENV.ADMIN_PASSWORD,
    }),
  })
  assert.equal(loginRes.status, 200, 'local admin login should succeed')
  assert.equal((await loginRes.json()).success, true)
  const setCookie = loginRes.headers.get('set-cookie')
  assert.ok(setCookie, 'login should create a session cookie')
  const cookieHeader = setCookie.split(';', 1)[0]

  const statusRes = await call('/admin/api/status', { headers: { Cookie: cookieHeader } })
  assert.equal(statusRes.status, 200, 'status API should require and accept the session')

  const adminRes = await call('/admin', { headers: { Cookie: cookieHeader } })
  assert.equal(adminRes.status, 200, 'admin page should load after login')
  const adminHtml = await adminRes.text()
  assert.match(adminHtml, /EdgeOne Blob 数据库|EdgeOne · Blob/, 'admin page should identify storage')

  const providersRes = await call('/admin/api/providers', { headers: { Cookie: cookieHeader } })
  assert.equal(providersRes.status, 200, 'providers API should load after login')
  const providersData = await providersRes.json()
  assert.ok(Array.isArray(providersData.data), 'providers response should contain an array')

  const createKeyRes = await call('/admin/api/proxy-keys', {
    method: 'POST',
    headers: { Cookie: cookieHeader, 'Content-Type': 'application/json' },
    body: JSON.stringify({ name: 'local runtime test' }),
  })
  assert.equal(createKeyRes.status, 201, 'local test key should be created')
  const rawKey = (await createKeyRes.json()).data?.key
  assert.ok(rawKey, 'key creation should return a token')

  const modelsRes = await call('/v1/models', {
    headers: { Authorization: `Bearer ${rawKey}` },
  })
  assert.equal(modelsRes.status, 200, 'models endpoint should accept the test token')
  const modelsData = await modelsRes.json()
  assert.ok(Array.isArray(modelsData.data), 'models response should contain an array')

  const usageRes = await call('/admin/api/usage?days=7', { headers: { Cookie: cookieHeader } })
  assert.equal(usageRes.status, 200, 'usage API should load after login')
  const usageData = await usageRes.json()
  assert.equal(typeof usageData.data?.totalRequests, 'number', 'usage summary should include totals')

  console.log('Runtime smoke tests passed: login, admin APIs, local key auth, models, and usage.')
}

runTests().catch((error) => {
  console.error('Runtime smoke tests failed:', error)
  process.exitCode = 1
})
