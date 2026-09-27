import { describe, expect, it } from 'vitest'
import { assignPanel, freshServer, validateServer } from './types'

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
})
