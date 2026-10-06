import { t } from './i18n'
export type AuthType = 'password' | 'key'
export type Layout = 'single' | 'columns' | 'rows' | 'grid'
export type Status = 'disconnected' | 'connecting' | 'connected' | 'error'

export interface Server {
  id: string
  name: string
  host: string
  port: number
  username: string
  group: string
  authType: AuthType
  privateKeyPath: string
  panelHost: string
  panelPort: number
  panelPath: string
  panelScheme: 'http' | 'https'
  color: string
  hostFingerprint: string | null
  hasSecret: boolean
  panelUsername: string
  hasPanelSecret: boolean
  autoLogin: boolean
  panelEnabled: boolean
  realmInstalled: boolean
  forwardingRules: ForwardRule[]
}

export interface ForwardRule {
  id: string
  remark: string
  listenPort: number
  remoteHost: string
  remotePort: number
  enabled: boolean
}
export type RuleChange =
  { kind: 'save'; rule: ForwardRule } | { kind: 'delete'; id: string } | { kind: 'apply' }

export function validateForwardRule(rule: ForwardRule, server: Server): string | null {
  if (![rule.listenPort, rule.remotePort].every((p) => Number.isInteger(p) && p > 0 && p <= 65535))
    return t('端口范围为 1–65535')
  const host = rule.remoteHost
  const validHost = host.includes(':')
    ? /^[0-9a-f:]+$/i.test(host) &&
      (() => {
        try {
          return new URL(`http://[${host}]/`).hostname.length > 0
        } catch {
          return false
        }
      })()
    : host.length <= 253 &&
      host
        .replace(/\.$/, '')
        .split('.')
        .every((s) => /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/i.test(s))
  if (!validHost) return t('请输入有效的转发地址，不包含协议或端口')
  if (
    new TextEncoder().encode(rule.remark).length > 240 ||
    [...rule.remark].some((c) => c.charCodeAt(0) < 32 || (c.charCodeAt(0) >= 127 && c.charCodeAt(0) <= 159))
  )
    return t('备注最多 240 字节，不能包含控制字符')
  if (server.forwardingRules.some((r) => r.id !== rule.id && r.listenPort === rule.listenPort))
    return t('同一服务器的入站端口不能重复')
  if (
    rule.enabled &&
    (rule.listenPort === server.port || (server.panelEnabled && rule.listenPort === server.panelPort))
  )
    return t('入站端口不能与此服务器的 SSH 或 S-UI 端口相同')
  return null
}

export interface Session {
  id: string
  status: Status
  localUrl?: string
  message?: string
}
export interface HubError {
  code: string
  message: string
  fingerprint?: string
}
export interface PanelBounds {
  id: string
  x: number
  y: number
  width: number
  height: number
}
export interface SaveServer {
  server: Server
  secret: string | null
  clearSecret: boolean
  panelSecret: string | null
  clearPanelSecret: boolean
  resetPanel: boolean
  initializeSui: boolean
  initializeRealm: boolean
}

export const colors = ['#7cb798', '#8eaadc', '#b298d0', '#d3a56d', '#db9191', '#6ebac0']
export const layoutSlots: Record<Layout, number> = { single: 1, columns: 2, rows: 2, grid: 4 }
export const freshServer = (): Server => ({
  id: crypto.randomUUID(),
  name: '',
  host: '',
  port: 22,
  username: 'root',
  group: '',
  authType: 'password',
  privateKeyPath: '',
  panelHost: '127.0.0.1',
  panelPort: 2095,
  panelPath: '/app/',
  panelScheme: 'http',
  color: colors[0],
  hostFingerprint: null,
  hasSecret: false,
  panelUsername: '',
  hasPanelSecret: false,
  autoLogin: false,
  panelEnabled: true,
  realmInstalled: false,
  forwardingRules: [],
})

export function getError(error: unknown): HubError {
  if (typeof error === 'object' && error !== null && 'message' in error) return error as HubError
  return { code: 'unknown', message: String(error) }
}

export function assignPanel(panes: (string | null)[], slot: number, id: string): (string | null)[] {
  const next = [...panes]
  const previous = next.indexOf(id)
  if (previous !== -1 && previous !== slot) next[previous] = next[slot]
  next[slot] = id
  return next
}

export function validateServer(server: Server): string | null {
  if (!server.name.trim()) return t('请输入服务器名称')
  if (!server.host.trim() || /[\s/\\@]/.test(server.host)) return t('请输入有效的 SSH 主机')
  if (!server.username.trim()) return t('请输入 SSH 用户名')
  if (
    ![server.port, ...(server.panelEnabled ? [server.panelPort] : [])].every(
      (p) => Number.isInteger(p) && p > 0 && p <= 65535,
    )
  )
    return t('端口范围为 1–65535')
  if (server.panelEnabled && (!server.panelHost.trim() || /[\s/\\@]/.test(server.panelHost)))
    return t('请输入有效的面板主机')
  if (
    server.panelEnabled &&
    (!server.panelPath.startsWith('/') ||
      server.panelPath.startsWith('//') ||
      /[\\\s?#]/.test(server.panelPath))
  )
    return t('面板路径应以 / 开头，不包含空格、查询参数或片段')
  if (server.authType === 'key' && !server.privateKeyPath.trim()) return t('请输入私钥文件路径')
  return null
}
