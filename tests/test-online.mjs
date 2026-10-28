import assert from 'node:assert/strict'

// This suite is opt-in and read-only apart from creating a short-lived login
// session. It never creates API keys or stores credentials in the repository.
const enabled = process.env.RUN_EDGEONE_ONLINE_TESTS === '1'
if (!enabled) {
  console.log('Online smoke tests skipped. Set RUN_EDGEONE_ONLINE_TESTS=1 and the EDGEONE_TEST_* variables to run.')
} else {
  const required = [
    'EDGEONE_TEST_BASE_URL',
    'EDGEONE_TEST_ADMIN_USERNAME',
    'EDGEONE_TEST_ADMIN_PASSWORD',
    'EDGEONE_TEST_PROXY_KEY',
  ]
  const missing = required.filter((name) => !process.env[name])
  if (missing.length) {
    console.error(`Missing required online-test settings: ${missing.join(', ')}`)
    process.exitCode = 1
  } else {
    const baseUrl = process.env.EDGEONE_TEST_BASE_URL
    const authQuery = process.env.EDGEONE_TEST_AUTH_QUERY || ''
    const cookies = new Map()

    function rememberCookies(response) {
      const headers = response.headers
      const setCookies = typeof headers.getSetCookie === 'function'
        ? headers.getSetCookie()
        : (headers.get('set-cookie') || '').split(/,(?=[^;]+?=)/)
      for (const value of setCookies) {
        const pair = value.trim().split(';', 1)[0]
        const separator = pair.indexOf('=')
        if (separator > 0) cookies.set(pair.slice(0, separator), pair.slice(separator + 1))
      }
    }

    async function request(path, init = {}) {
      const url = new URL(path, baseUrl)
      for (const [key, value] of new URLSearchParams(authQuery.replace(/^\?/, ''))) {
        url.searchParams.set(key, value)
      }
      const headers = new Headers(init.headers)
      if (cookies.size && !headers.has('Cookie')) {
        headers.set('Cookie', [...cookies].map(([key, value]) => `${key}=${value}`).join('; '))
      }
      const response = await fetch(url, { ...init, headers })
      rememberCookies(response)
      return response
    }

    async function runOnlineTests() {
      const homeRes = await request('/')
      assert.equal(homeRes.status, 200, 'home page should load')
      assert.match(await homeRes.text(), /AI GATEWAY/, 'home page should contain the product title')

      const loginPageRes = await request('/admin/login')
      assert.equal(loginPageRes.status, 200, 'login page should load')

      const loginRes = await request('/admin/login', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          username: process.env.EDGEONE_TEST_ADMIN_USERNAME,
          password: process.env.EDGEONE_TEST_ADMIN_PASSWORD,
        }),
      })
      assert.equal(loginRes.status, 200, 'admin login should succeed')
      assert.equal((await loginRes.json()).success, true)
      assert.ok(cookies.has('session_id'), 'login should set a session cookie')

      const statusRes = await request('/admin/api/status')
      assert.equal(statusRes.status, 200, 'status API should load')

      const adminRes = await request('/admin')
      assert.equal(adminRes.status, 200, 'admin page should load')

      const providersRes = await request('/admin/api/providers')
      assert.equal(providersRes.status, 200, 'providers API should load')
      assert.ok(Array.isArray((await providersRes.json()).data))

      const modelsRes = await request('/v1/models', {
        headers: { Authorization: `Bearer ${process.env.EDGEONE_TEST_PROXY_KEY}` },
      })
      assert.equal(modelsRes.status, 200, 'models API should accept the configured test key')
      assert.ok(Array.isArray((await modelsRes.json()).data))

      const usageRes = await request('/admin/api/usage?days=7')
      assert.equal(usageRes.status, 200, 'usage API should load')
      assert.equal(typeof (await usageRes.json()).data?.totalRequests, 'number')

      console.log('Online smoke tests passed: home, login, status, admin, providers, models, and usage.')
    }

    runOnlineTests().catch((error) => {
      console.error('Online smoke tests failed:', error)
      process.exitCode = 1
    })
  }
}
