import { t } from './i18n'
import { invoke, isTauri } from '@tauri-apps/api/core'
import { listen } from '@tauri-apps/api/event'
import { validateForwardRule } from './types'
import type { PanelBounds, RuleChange, SaveServer, Server, Session } from './types'

export const desktop = isTauri()
const previewKey = 's-ui-hub.preview.servers.v1'

const normalizeServer = (s: Server): Server => ({
  ...s,
  panelEnabled: s.panelEnabled ?? true,
  realmEnabled: s.realmEnabled ?? true,
  realmInstalled: s.realmInstalled ?? false,
  forwardingRules: s.forwardingRules ?? [],
})

function previewServers(): Server[] {
  try {
    return (JSON.parse(localStorage.getItem(previewKey) ?? '[]') as Server[]).map(normalizeServer)
  } catch {
    return []
  }
}

export const api = {
  initializeService: (id: string, service: 'sui' | 'realm'): Promise<Server> =>
    desktop
      ? invoke('initialize_service', { id, service })
      : Promise.reject({ code: 'preview', message: t('请在桌面应用中初始化服务') }),
  updateForwarding: async (id: string, change: RuleChange): Promise<Server> => {
    if (desktop) return invoke('update_forwarding', { id, change })
    const servers = previewServers()
    const server = servers.find((s) => s.id === id)
    if (!server) throw new Error(t('服务器不存在'))
    if (change.kind === 'save') {
      const error = validateForwardRule(change.rule, server)
      if (error) throw new Error(error)
      server.forwardingRules = [...server.forwardingRules.filter((r) => r.id !== change.rule.id), change.rule]
    } else if (change.kind === 'delete')
      server.forwardingRules = server.forwardingRules.filter((r) => r.id !== change.id)
    localStorage.setItem(previewKey, JSON.stringify(servers))
    return server
  },
  openRepository: (): Promise<void> => invoke('open_repository'),
  listServers: async (): Promise<Server[]> =>
    desktop ? (await invoke<Server[]>('list_servers')).map(normalizeServer) : previewServers(),
  listSessions: (): Promise<Session[]> => (desktop ? invoke('list_sessions') : Promise.resolve([])),
  saveServer: async ({
    server,
    secret,
    clearSecret,
    panelSecret,
    clearPanelSecret,
    initializeSui,
    resetPanel,
  }: SaveServer): Promise<Server> => {
    if (desktop)
      return invoke('save_server', {
        server,
        secret,
        clearSecret,
        panelCredentials: {
          secret: panelSecret,
          clear: clearPanelSecret,
          action: resetPanel ? 'reset' : initializeSui ? 'initialize' : null,
        },
      })
    // Browser preview never stores credentials, including encrypted key passphrases.
    const saved = { ...server, hasSecret: false, hasPanelSecret: false, hostFingerprint: null }
    const servers = previewServers().filter((s) => s.id !== server.id)
    localStorage.setItem(previewKey, JSON.stringify([...servers, saved]))
    return saved
  },
  deleteServer: async (id: string, force = false): Promise<void> => {
    if (desktop) return invoke('delete_server', { id, force })
    if (!force && previewServers().find((s) => s.id === id)?.forwardingRules.length)
      throw new Error(t('请先在端口转发模块删除此服务器的规则，再删除服务器'))
    localStorage.setItem(previewKey, JSON.stringify(previewServers().filter((s) => s.id !== id)))
  },
  connect: (id: string): Promise<Session> =>
    desktop
      ? invoke('connect_server', { id })
      : Promise.reject({ code: 'preview', message: t('请在桌面应用中连接 SSH') }),
  disconnect: (id: string): Promise<void> =>
    desktop ? invoke('disconnect_server', { id }) : Promise.resolve(),
  trust: (id: string, fingerprint: string): Promise<void> => invoke('trust_host', { id, fingerprint }),
  resetHost: (id: string): Promise<void> => invoke('reset_host', { id }),
  resetPanel: (id: string, confirmedHost: string): Promise<void> =>
    invoke('reset_panel_credentials', { id, confirmedHost }),
  loginPanel: (id: string): Promise<void> => invoke('login_panel', { id }),
  revealPanelPassword: (id: string): Promise<string> => invoke('reveal_panel_password', { id }),
  syncPanels: (panels: PanelBounds[]): Promise<void> =>
    desktop ? invoke('sync_panels', { panels }) : Promise.resolve(),
  reloadPanel: (id: string): Promise<void> => invoke('reload_panel', { id }),
  onSession: async (callback: (session: Session) => void): Promise<() => void> =>
    desktop ? listen<Session>('session-changed', (event) => callback(event.payload)) : () => {},
  onFeedback: async (callback: (message: string) => void): Promise<() => void> =>
    desktop ? listen<string>('panel-feedback', (event) => callback(event.payload)) : () => {},
}
