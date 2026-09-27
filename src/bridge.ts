import { t } from './i18n'
import { invoke, isTauri } from '@tauri-apps/api/core'
import { listen } from '@tauri-apps/api/event'
import type { PanelBounds, SaveServer, Server, Session } from './types'

export const desktop = isTauri()
const previewKey = 's-ui-hub.preview.servers.v1'

function previewServers(): Server[] {
  try {
    return JSON.parse(localStorage.getItem(previewKey) ?? '[]') as Server[]
  } catch {
    return []
  }
}

export const api = {
  openRepository: (): Promise<void> => invoke('open_repository'),
  listServers: (): Promise<Server[]> =>
    desktop ? invoke('list_servers') : Promise.resolve(previewServers()),
  listSessions: (): Promise<Session[]> => (desktop ? invoke('list_sessions') : Promise.resolve([])),
  saveServer: async ({
    server,
    secret,
    clearSecret,
    panelSecret,
    clearPanelSecret,
  }: SaveServer): Promise<Server> => {
    if (desktop) return invoke('save_server', { server, secret, clearSecret, panelSecret, clearPanelSecret })
    // Browser preview never stores credentials, including encrypted key passphrases.
    const saved = { ...server, hasSecret: false, hasPanelSecret: false, hostFingerprint: null }
    const servers = previewServers().filter((s) => s.id !== server.id)
    localStorage.setItem(previewKey, JSON.stringify([...servers, saved]))
    return saved
  },
  deleteServer: async (id: string): Promise<void> => {
    if (desktop) return invoke('delete_server', { id })
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
