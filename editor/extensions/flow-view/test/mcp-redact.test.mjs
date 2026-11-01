// Secrets are blanked in what search_sessions returns: each kind of secret, the text that must stay, and huge input.
import { test, before, after } from 'node:test'
import assert from 'node:assert/strict'
import { cleanup, load } from './bundle.mjs'

let r
before(async () => { r = await load('src/mcp/redact.ts') })
after(cleanup)

const gone = (text, secret) => {
	const out = r.redact(text)
	assert.ok(!out.includes(secret), `${secret} must be gone from: ${out}`)
	assert.match(out, /\[redacted\]/)
	return out
}

test('mcp-redact: API keys and tokens of the well-known shapes', () => {
	gone('use sk-ant-api03-AbCdEfGhIjKlMnOpQrStUv for it', 'AbCdEfGhIjKlMnOpQrStUv')
	gone('export it: ghp_0123456789abcdefghijABCDEFGHIJ0123', 'ghp_0123456789abcdefghijABCDEFGHIJ0123')
	gone('github_pat_11ABCDEFG0123456789_abcdefghijklmnop', 'github_pat_11ABCDEFG0123456789')
	gone('slack xoxb-123456789012-abcdefABCDEF', 'xoxb-123456789012-abcdefABCDEF')
	gone('aws id AKIAIOSFODNN7EXAMPLE here', 'AKIAIOSFODNN7EXAMPLE')
	gone('jwt eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.dBjftJeZ4CVPmB92K27uhbUJU1p1r', 'eyJzdWIiOiIxMjM0NTY3ODkwIn0')
})

test('mcp-redact: Bearer tokens', () => {
	assert.equal(r.redact('Authorization: Bearer abc123def456ghi789'), 'Authorization: Bearer [redacted]')
	assert.equal(r.redact('Authorization: Bearer abcdefghijklmnopqrstuvwxyz'), 'Authorization: Bearer [redacted]')
})

test('mcp-redact: key=value, key: value and JSON forms keep the key name', () => {
	assert.equal(r.redact('password=hunter2'), 'password=[redacted]')
	assert.equal(r.redact('db_password = "correct horse battery"'), 'db_password = "[redacted]"')
	assert.equal(r.redact('token=abc123&page=2'), 'token=[redacted]&page=2')
	assert.equal(r.redact('secret: s3cr3tValue'), 'secret: [redacted]')
	assert.equal(r.redact('api_key: AbCd1234EfGh'), 'api_key: [redacted]')
	assert.equal(r.redact('API-KEY=zzzz-1111'), 'API-KEY=[redacted]')
	assert.equal(r.redact('{"password": "hunter2", "user": "ann"}'), '{"password": "[redacted]", "user": "ann"}')
	assert.equal(r.redact("{'token': 'abc def'}"), "{'token': '[redacted]'}")
	assert.equal(r.redact('AWS_SECRET_ACCESS_KEY=wJalrXUtnFEMI/K7MDENG'), 'AWS_SECRET_ACCESS_KEY=[redacted]')
	assert.equal(r.redact('GITHUB_TOKEN: ghx12'), 'GITHUB_TOKEN: [redacted]')
	assert.equal(r.redact('password=[redacted]'), 'password=[redacted]', 'idempotent')
})

test('mcp-redact: a long hex or base64 run after a key or token word', () => {
	const hex = '3f2a9c4e8b7d6a5f1e0d9c8b7a6f5e4d3c2b1a09'
	assert.equal(r.redact(`the api key is ${hex} ok`), 'the api key is [redacted] ok')
	gone(`token ${hex}`, hex)
	gone('secret: "QUJDREVGR0hJSktMTU5PUFFSU1RVVldYWVowMTIzNDU2Nzg5"', 'QUJDREVGR0hJSktMTU5PUFFSU1RVVldYWVow')
})

test('mcp-redact: private key blocks, also when only the BEGIN line is inside the excerpt', () => {
	const body = 'MIIEvQIBADANBgkqhkiG9w0BAQEFAASC'
	const whole = `before -----BEGIN RSA PRIVATE KEY----- ${body} -----END RSA PRIVATE KEY----- after`
	assert.equal(r.redact(whole), 'before [redacted] after')
	assert.equal(r.redact(`k:\n-----BEGIN PRIVATE KEY-----\n${body}\n${body}\n-----END PRIVATE KEY-----\ndone`), 'k:\n[redacted]\ndone')
	assert.equal(r.redact(`here it starts -----BEGIN OPENSSH PRIVATE KEY----- ${body} and the excerpt ends`), 'here it starts [redacted]')
	assert.equal(r.redact('two -----BEGIN PRIVATE KEY----- a -----END PRIVATE KEY----- and -----BEGIN PRIVATE KEY----- b -----END PRIVATE KEY----- end'), 'two [redacted] and [redacted] end')
	assert.equal(r.redact('-----BEGIN CERTIFICATE----- MIIC -----END CERTIFICATE-----'), '-----BEGIN CERTIFICATE----- MIIC -----END CERTIFICATE-----', 'a public certificate is not a secret')
})

test('mcp-redact: ordinary text is left alone', () => {
	for (const text of [
		'The token is used to authenticate the request, and a token expires after an hour.',
		'Token: expired',
		'we should rotate the password policy and keep the secret santa list',
		'commit 3f2a9c4e8b7d6a5f1e0d9c8b7a6f5e4d3c2b1a09 fixed it',
		'merged 88d6b7d into main',
		'Bearer of bad news, Bearer tokens are sent in a header',
		'the risk-assessment-framework was reviewed by the task force',
		'tokens: 12 (a count)',
		'press the key to continue, the primary key of orders is id',
		'-----BEGIN CERTIFICATE-----',
		'',
	]) {
		assert.equal(r.redact(text), text)
	}
	assert.equal(r.redact(undefined), '')
	assert.equal(r.redact(42), '')
})

test('mcp-redact: a huge or binary-looking text neither throws nor takes long, and the cap never returns unread text', () => {
	const started = Date.now()
	const mb = 'a'.repeat(1_000_000)
	assert.equal(r.redact(mb).length, 1_000_000)
	const noise = Array.from({ length: 1_000_000 }, (_, i) => String.fromCharCode((i * 7919) % 0xD7FF)).join('')
	assert.equal(typeof r.redact(noise), 'string')
	assert.equal(typeof r.redact('a-'.repeat(500_000)), 'string')
	assert.equal(typeof r.redact('token='.repeat(150_000)), 'string')
	assert.equal(typeof r.redact('-----BEGIN PRIVATE KEY-----'.repeat(30_000)), 'string')
	assert.equal(typeof r.redact('\0\u0001\ufffd'.repeat(300_000)), 'string')
	const tail = r.redact('x'.repeat(r.MAX_REDACT_CHARS + 50) + ' sk-abcdefghijklmnopqrstuvwxyz')
	assert.ok(!tail.includes('sk-abcdefgh'), 'what lies past the cap is cut, not passed on')
	assert.ok(Date.now() - started < 20_000, 'linear time')
})
