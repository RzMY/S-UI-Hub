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
  if (![server.port, server.panelPort].every((p) => Number.isInteger(p) && p > 0 && p <= 65535))
    return t('端口范围为 1–65535')
  if (!server.panelHost.trim() || /[\s/\\@]/.test(server.panelHost)) return t('请输入有效的面板主机')
  if (
    !server.panelPath.startsWith('/') ||
    server.panelPath.startsWith('//') ||
    /[\\\s?#]/.test(server.panelPath)
  )
    return t('面板路径应以 / 开头，不包含空格、查询参数或片段')
  if (server.authType === 'key' && !server.privateKeyPath.trim()) return t('请输入私钥文件路径')
  return null
}
