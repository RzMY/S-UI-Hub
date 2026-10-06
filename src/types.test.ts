import { describe, expect, it } from 'vitest'
import { assignPanel, freshServer, validateServer, validateForwardRule } from './types'

describe('panel assignment', () => {
  it('swaps an already visible panel instead of duplicating the webview', () => {
    expect(assignPanel(['a', 'b', null, null], 1, 'a')).toEqual(['b', 'a', null, null])
    expect(assignPanel(['a', null, null, null], 2, 'a')).toEqual([null, null, 'a', null])
  })
  it('keeps other panels when opening another connection', () => {
    expect(assignPanel(['a', 'b', 'c', 'd'], 0, 'e')).toEqual(['e', 'b', 'c', 'd'])
  })
})
describe('server validation', () => {
  const valid = () => ({ ...freshServer(), name: 'Tokyo', host: '192.0.2.1' })
  it('accepts IPv6 and a custom panel base path', () => {
    expect(validateServer({ ...valid(), host: '2001:db8::1', panelPath: '/private/ui/' })).toBeNull()
  })
  it('rejects invalid network destinations and paths', () => {
    for (const host of ['https://example.com', 'user@host', 'bad host'])
      expect(validateServer({ ...valid(), host })).not.toBeNull()
    for (const panelPath of ['//evil.com', '/\\evil', '/?a=b', '/#hash', '/bad path'])
      expect(validateServer({ ...valid(), panelPath })).not.toBeNull()
    for (const port of [0, 65536, 1.5, NaN]) expect(validateServer({ ...valid(), port })).not.toBeNull()
  })
  it('requires a key path for private key authentication', () => {
    expect(validateServer({ ...valid(), authType: 'key' })).not.toBeNull()
    expect(validateServer({ ...valid(), authType: 'key', privateKeyPath: '~/.ssh/id_ed25519' })).toBeNull()
  })
  it('allows SSH-only servers without valid panel fields', () => {
    expect(
      validateServer({ ...valid(), panelEnabled: false, panelHost: '', panelPort: 0, panelPath: '' }),
    ).toBeNull()
  })
})

describe('forwarding validation', () => {
  const server = freshServer()
  const rule = {
    id: crypto.randomUUID(),
    remark: '',
    listenPort: 10000,
    remoteHost: 'example.com',
    remotePort: 443,
    enabled: true,
  }
  it('accepts names and bare IPv6 but rejects malformed destinations', () => {
    for (const remoteHost of ['example.com', '192.0.2.1', '2001:db8::1'])
      expect(validateForwardRule({ ...rule, remoteHost }, server)).toBeNull()
    for (const remoteHost of ['', 'https://example.com', 'example.com:443', '[::1]', '::::', 'a\nb', '$(id)'])
      expect(validateForwardRule({ ...rule, remoteHost }, server)).not.toBeNull()
  })
  it('rejects duplicate, reserved and invalid ports', () => {
    for (const listenPort of [0, 65536, 1.5, NaN, 22, 2095])
      expect(validateForwardRule({ ...rule, listenPort }, server)).not.toBeNull()
    expect(
      validateForwardRule({ ...rule, id: crypto.randomUUID() }, { ...server, forwardingRules: [rule] }),
    ).not.toBeNull()
    expect(validateForwardRule(rule, { ...server, forwardingRules: [rule] })).toBeNull()
  })
})
