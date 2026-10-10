import { t } from './i18n'
import { usePreferences, preferenceLoadError } from './preferences'
import PreferencesDialog from './PreferencesDialog'
import { Settings2 } from 'lucide-react'
import { useCallback, useEffect, useRef, useState } from 'react'
import {
  ArrowUpRight,
  Check,
  ChevronDown,
  ChevronRight,
  CircleHelp,
  Columns2,
  Ellipsis,
  Folder,
  Github,
  Grid2X2,
  KeyRound,
  LayoutDashboard,
  Link2,
  LoaderCircle,
  Monitor,
  PanelLeftClose,
  PanelLeftOpen,
  Plus,
  Power,
  RefreshCw,
  Rows2,
  Search,
  Server as ServerIcon,
  ShieldCheck,
  Square,
  Terminal,
  Trash2,
  Unplug,
  X,
} from 'lucide-react'
import { api, desktop } from './bridge'
import ServerDialog from './ServerDialog'
import ForwardingPage from './ForwardingPage'
import { assignPanel, freshServer, getError, layoutSlots } from './types'
import type { HubError, Layout, PanelBounds, SaveServer, Server, Session } from './types'

type Confirm = {
  title: string
  message: string
  action: string
  danger?: boolean
  fingerprint?: string
  forceDelete?: boolean
  run: (forceDelete?: boolean) => Promise<void>
}

export default function App() {
  usePreferences()
  const [preferencesOpen, setPreferencesOpen] = useState(false)
  const layoutOptions = [
    { id: 'single', name: t('单面板'), Icon: Square },
    { id: 'columns', name: t('左右分屏'), Icon: Columns2 },
    { id: 'rows', name: t('上下分屏'), Icon: Rows2 },
    { id: 'grid', name: t('四宫格'), Icon: Grid2X2 },
  ] as const

  const [servers, setServers] = useState<Server[]>([])
  const [sessions, setSessions] = useState<Record<string, Session>>({})
  const [search, setSearch] = useState('')
  const [group, setGroup] = useState('all')
  const [page, setPage] = useState<'servers' | 'workspace' | 'forwarding'>('servers')
  const [remoteProgress, setRemoteProgress] = useState('')
  const [layout, setLayout] = useState<Layout>('single')
  const [panes, setPanes] = useState<(string | null)[]>([null, null, null, null])
  const [activeSlot, setActiveSlot] = useState(0)
  const [editing, setEditing] = useState<Server | null>(null)
  const [confirm, setConfirm] = useState<Confirm | null>(null)
  const [navigationOpen, setNavigationOpen] = useState(false)
  const navigationRef = useRef<HTMLDivElement>(null)
  const [sidebar, setSidebar] = useState(true)
  const [notice, setNotice] = useState<{ text: string; error: boolean } | null>(() =>
    preferenceLoadError ? { text: t(preferenceLoadError), error: true } : null,
  )
  const [loadError, setLoadError] = useState('')
  const [loading, setLoading] = useState(true)
  const [menu, setMenu] = useState<string | null>(null)
  const [picker, setPicker] = useState<number | null>(null)
  const [confirmBusy, setConfirmBusy] = useState(false)
  const paneElements = useRef(new Map<number, HTMLDivElement>())
  const syncQueue = useRef(Promise.resolve())
  const attempts = useRef(new Map<string, number>())
  const nextAttempt = useRef(0)
  const modalOpen = !!editing || !!confirm || navigationOpen || picker !== null || preferencesOpen
  const connected = servers.filter((s) => sessions[s.id]?.status === 'connected')
  const groups = [...new Set(servers.map((s) => s.group).filter(Boolean))].sort()
  const visible = servers.filter(
    (s) =>
      (group === 'all' ||
        (group === 'connected' && sessions[s.id]?.status === 'connected') ||
        s.group === group) &&
      `${s.name} ${s.host} ${s.group} ${s.username}`.toLowerCase().includes(search.toLowerCase()),
  )
  const notify = useCallback((text: string, error = false) => setNotice({ text, error }), [])
  const report = useCallback((error: unknown) => notify(t(getError(error).message), true), [notify])

  useEffect(() => {
    let mounted = true
    Promise.all([api.listServers(), api.listSessions()])
      .then(([saved, active]) => {
        if (mounted) {
          setServers(saved)
          setSessions(Object.fromEntries(active.map((s) => [s.id, s])))
        }
      })
      .catch((e) => {
        if (mounted) setLoadError(getError(e).message)
      })
      .finally(() => {
        if (mounted) setLoading(false)
      })
    const subscription = api.onSession((session) => {
      if (mounted) {
        setSessions((s) => ({ ...s, [session.id]: session }))
        if (session.message) notify(session.message, true)
      }
    })
    const feedback = api.onFeedback((message) => {
      if (mounted) notify(message, true)
    })
    return () => {
      mounted = false
      void subscription.then((unlisten) => unlisten())
      void feedback.then((unlisten) => unlisten())
    }
  }, [notify])

  useEffect(() => {
    if (!notice) return
    const timer = window.setTimeout(() => setNotice(null), notice.error ? 9000 : 3500)
    return () => clearTimeout(timer)
  }, [notice])

  useEffect(() => {
    const keydown = (event: KeyboardEvent) => {
      if ((event.ctrlKey || event.metaKey) && event.key === 'k') {
        event.preventDefault()
        document.getElementById('server-search')?.focus()
      }
      if (event.key === 'Escape') {
        setMenu(null)
        setPicker(null)
        setNavigationOpen(false)
        setPreferencesOpen(false)
        if (!confirmBusy) setConfirm(null)
      }
    }
    window.addEventListener('keydown', keydown)
    return () => window.removeEventListener('keydown', keydown)
  }, [confirmBusy])

  useEffect(() => {
    if (!navigationOpen) return
    const close = (event: PointerEvent) => {
      if (!navigationRef.current?.contains(event.target as Node)) setNavigationOpen(false)
    }
    window.addEventListener('pointerdown', close)
    return () => window.removeEventListener('pointerdown', close)
  }, [navigationOpen])

  useEffect(() => {
    if (menu === null) return
    const close = () => setMenu(null)
    window.addEventListener('click', close)
    return () => window.removeEventListener('click', close)
  }, [menu])

  useEffect(() => {
    let frame = 0
    let disposed = false
    const sync = () => {
      cancelAnimationFrame(frame)
      frame = requestAnimationFrame(() => {
        const bounds: PanelBounds[] = []
        if (page === 'workspace' && !modalOpen)
          panes.slice(0, layoutSlots[layout]).forEach((id, slot) => {
            const element = paneElements.current.get(slot)
            if (!id || !element || sessions[id]?.status !== 'connected') return
            const rect = element.getBoundingClientRect()
            if (rect.width > 0 && rect.height > 0)
              bounds.push({ id, x: rect.x, y: rect.y, width: rect.width, height: rect.height })
          })
        syncQueue.current = syncQueue.current
          .catch(() => {})
          .then(async () => {
            if (!disposed) await api.syncPanels(bounds)
          })
          .catch((e) => {
            if (!disposed) report(e)
          })
      })
    }
    const observer = new ResizeObserver(sync)
    paneElements.current.forEach((el) => observer.observe(el))
    window.addEventListener('resize', sync)
    sync()
    return () => {
      disposed = true
      cancelAnimationFrame(frame)
      observer.disconnect()
      window.removeEventListener('resize', sync)
    }
  }, [page, layout, panes, sessions, modalOpen, sidebar, report])

  const openPanel = (id: string, slot = activeSlot) => {
    setPanes((current) => assignPanel(current, slot, id))
    setPage('workspace')
    setPicker(null)
  }

  async function connect(server: Server, slot = activeSlot) {
    if (sessions[server.id]?.status === 'connected') {
      openPanel(server.id, slot)
      return
    }
    if (attempts.current.has(server.id)) return
    const attempt = ++nextAttempt.current
    attempts.current.set(server.id, attempt)
    setSessions((s) => ({ ...s, [server.id]: { id: server.id, status: 'connecting' } }))
    try {
      const session = await api.connect(server.id)
      if (attempts.current.get(server.id) !== attempt) return
      setSessions((s) => ({ ...s, [server.id]: session }))
      openPanel(server.id, slot)
    } catch (error) {
      if (attempts.current.get(server.id) !== attempt) return
      const e: HubError = getError(error)
      setSessions((s) => ({
        ...s,
        [server.id]: {
          id: server.id,
          status: e.code === 'host_key_unknown' ? 'disconnected' : 'error',
          message: e.message,
        },
      }))
      if (e.code === 'host_key_unknown' && e.fingerprint) {
        setConfirm({
          title: t('信任此服务器？'),
          message: t(
            '{0}@{1}:{2} · 请通过服务器控制台或管理员核对指纹。',
            server.username,
            server.host,
            server.port,
          ),
          fingerprint: e.fingerprint,
          action: t('信任并连接'),
          run: async () => {
            await api.trust(server.id, e.fingerprint!)
            setServers(await api.listServers())
            setConfirm(null)
            void connect(server, slot)
          },
        })
      } else if (e.code !== 'cancelled') report(e)
    } finally {
      if (attempts.current.get(server.id) === attempt) attempts.current.delete(server.id)
    }
  }

  async function disconnect(id: string) {
    attempts.current.delete(id)
    await api.disconnect(id)
    setSessions((s) => ({ ...s, [id]: { id, status: 'disconnected' } }))
  }
  function updateServer(saved: Server) {
    setServers((current) =>
      current.some((s) => s.id === saved.id)
        ? current.map((s) => (s.id === saved.id ? saved : s))
        : [...current, saved],
    )
  }
  async function runRemote(server: Server, action: () => Promise<void>): Promise<void> {
    try {
      await action()
    } catch (error) {
      const e = getError(error)
      if (e.code !== 'host_key_unknown' || !e.fingerprint) throw error
      setConfirm({
        title: t('信任此服务器？'),
        message: t(
          '{0}@{1}:{2} · 请通过服务器控制台或管理员核对指纹。',
          server.username,
          server.host,
          server.port,
        ),
        fingerprint: e.fingerprint,
        action: t('信任并继续'),
        run: async () => {
          await api.trust(server.id, e.fingerprint!)
          setServers(await api.listServers())
          setConfirm(null)
          await runRemote(server, action)
        },
      })
    }
  }
  async function initialize(server: Server, services: ('sui' | 'realm')[]) {
    let index = 0
    await runRemote(server, async () => {
      try {
        while (index < services.length) {
          const service = services[index]
          setRemoteProgress(
            t(
              '正在为 {0} 初始化 {1}，下载和安装可能需要几分钟…',
              server.name,
              service === 'sui' ? 'S-UI' : 'realm',
            ),
          )
          updateServer(await api.initializeService(server.id, service))
          index++
        }
        notify(t('所选服务初始化完成'))
      } finally {
        setRemoteProgress('')
      }
    })
  }
  async function save(value: SaveServer) {
    const saved = await api.saveServer(value)
    setServers((current) =>
      current.some((s) => s.id === saved.id)
        ? current.map((s) => (s.id === saved.id ? saved : s))
        : [...current, saved],
    )
    notify(t('服务器已保存'))
    const services: ('sui' | 'realm')[] = []
    if (value.initializeRealm) services.push('realm')
    if (value.initializeSui) services.push('sui')
    if (services.length) {
      setEditing(null)
      void initialize(saved, services).catch(report)
    }
    if (value.resetPanel) {
      const target = `${saved.host}:${saved.port}`
      const runReset = async () => {
        try {
          await api.resetPanel(saved.id, target)
          setConfirm(null)
          notify(t('远端面板账号密码已重置'))
        } catch (error) {
          const e = getError(error)
          if (e.code === 'host_key_unknown' && e.fingerprint) {
            setConfirm({
              title: t('核对 SSH 指纹后重置'),
              message: t(
                '{0} · 核对指纹后，将重置第一个 S-UI 管理员为「{1}」。',
                target,
                saved.panelUsername,
              ),
              fingerprint: e.fingerprint,
              action: t('信任并重置'),
              danger: true,
              run: async () => {
                await api.trust(saved.id, e.fingerprint!)
                setServers(await api.listServers())
                await runReset()
              },
            })
          } else throw error
        }
      }
      setConfirm({
        title: t('重置远端面板账号密码？'),
        message: t(
          '目标：{0}（{1}）。第一个 S-UI 管理员将改为「{2}」及刚保存的新密码，原凭证将失效。',
          saved.name,
          target,
          saved.panelUsername,
        ),
        action: t('确认重置'),
        danger: true,
        run: runReset,
      })
    }
  }
  function edit(server: Server) {
    if (['connected', 'connecting'].includes(sessions[server.id]?.status)) {
      notify(t('请先断开此服务器，再编辑连接信息'), true)
      return
    }
    setEditing(server)
    setMenu(null)
  }
  function remove(server: Server) {
    setMenu(null)
    setConfirm({
      title: t('删除「{0}」？', server.name),
      message: server.forwardingRules.length
        ? t(
            '此服务器有 {0} 条转发规则。请先删除规则；服务器失联时可勾选强制删除。',
            server.forwardingRules.length,
          )
        : t('服务器配置和已保存的 SSH / 面板凭证将被移除。'),
      action: t('删除服务器'),
      danger: true,
      forceDelete: server.forwardingRules.length ? false : undefined,
      run: async (forceDelete = false) => {
        await disconnect(server.id)
        await api.deleteServer(server.id, forceDelete)
        setServers((s) => s.filter((item) => item.id !== server.id))
        setPanes((p) => p.map((id) => (id === server.id ? null : id)))
        setConfirm(null)
        notify(t('服务器已删除'))
      },
    })
  }
  function resetHost() {
    const server = editing!
    setEditing(null)
    setConfirm({
      title: t('重置 SSH 指纹？'),
      message: t('请先通过可信渠道核验服务器。下次连接将要求重新确认主机指纹。'),
      action: t('重置指纹'),
      danger: true,
      run: async () => {
        await api.resetHost(server.id)
        setServers(await api.listServers())
        setConfirm(null)
        notify(t('主机指纹已重置'))
      },
    })
  }
  const statusLabel = (server: Server) =>
    ({ connected: t('已连接'), connecting: t('连接中'), error: t('连接失败'), disconnected: t('未连接') })[
      sessions[server.id]?.status ?? 'disconnected'
    ]

  return (
    <div className={`app ${sidebar ? '' : 'sidebar-collapsed'}`}>
      <aside className="sidebar">
        <a
          className="brand"
          href="#"
          onClick={(e) => {
            e.preventDefault()
            setPage('servers')
            setGroup('all')
          }}
        >
          <img src="/mark.svg" alt="" />
          <span>
            S-UI<span className="brand-light"> Hub</span>
          </span>
        </a>
        <button className="sidebar-add" onClick={() => setEditing(freshServer())} disabled={!!loadError}>
          <Plus size={17} />
          {t('添加服务器')}
          <span>＋</span>
        </button>
        <div className="nav-caption">{t('工作空间')}</div>
        <nav>
          <button
            className={`nav-item ${page === 'servers' && group === 'all' ? 'selected' : ''}`}
            onClick={() => {
              setPage('servers')
              setGroup('all')
            }}
          >
            <ServerIcon size={17} />
            {t('全部服务器')}
            <span className="nav-count">{servers.length.toString().padStart(2, '0')}</span>
          </button>
          <button
            className={`nav-item ${page === 'servers' && group === 'connected' ? 'selected' : ''}`}
            onClick={() => {
              setPage('servers')
              setGroup('connected')
            }}
          >
            <Link2 size={17} />
            {t('已连接')}
            <span className="nav-count">{connected.length.toString().padStart(2, '0')}</span>
          </button>
          <button
            className={`nav-item ${page === 'workspace' ? 'selected' : ''}`}
            onClick={() => setPage('workspace')}
          >
            <Columns2 size={17} />
            {t('面板工作区')}
            <ChevronRight className="nav-tail" size={15} />
          </button>
          <button
            className={`nav-item ${page === 'forwarding' ? 'selected' : ''}`}
            onClick={() => setPage('forwarding')}
          >
            <ArrowUpRight size={17} />
            {t('端口转发')}
            <ChevronRight className="nav-tail" size={15} />
          </button>
        </nav>
        <div className="nav-caption group-caption">
          {t('服务器分组')}
          <span>{groups.length}</span>
        </div>
        <nav className="group-nav">
          {groups.length ? (
            groups.map((name) => (
              <button
                key={name}
                className={`nav-item ${page === 'servers' && group === name ? 'selected' : ''}`}
                onClick={() => {
                  setGroup(name)
                  setPage('servers')
                }}
              >
                <Folder size={16} />
                <span className="truncate">{name}</span>
                <span className="nav-count">{servers.filter((s) => s.group === name).length}</span>
              </button>
            ))
          ) : (
            <div className="empty-group">{t('暂无分组')}</div>
          )}
        </nav>
        <div className="sidebar-bottom">
          <div className="sidebar-footer">
            <button
              className="icon-button"
              aria-label={t('偏好设置')}
              onClick={() => setPreferencesOpen(true)}
            >
              <Settings2 size={17} />
            </button>
            <span>v0.1.0</span>
            <a
              className="icon-button"
              aria-label={t('GitHub 仓库')}
              href="https://github.com/RzMY/S-UI-Hub"
              onClick={(event) => {
                if (desktop) {
                  event.preventDefault()
                  void api.openRepository().catch(report)
                }
              }}
              target="_blank"
              rel="noreferrer"
            >
              <Github size={17} />
            </a>
          </div>
        </div>
      </aside>
      <main className="main">
        <header className="topbar">
          <div className="breadcrumbs">
            <button
              className="icon-button sidebar-toggle"
              aria-label={sidebar ? t('收起侧栏') : t('展开侧栏')}
              onClick={() => setSidebar((s) => !s)}
            >
              {sidebar ? <PanelLeftClose size={18} /> : <PanelLeftOpen size={18} />}
            </button>
            <div
              className="workspace-navigation"
              ref={navigationRef}
              onBlur={(event) => {
                if (!event.currentTarget.contains(event.relatedTarget)) setNavigationOpen(false)
              }}
            >
              <button
                className="workspace-trigger"
                aria-expanded={navigationOpen}
                aria-controls="workspace-navigation"
                onClick={() => setNavigationOpen((open) => !open)}
              >
                <strong>
                  {page === 'forwarding'
                    ? t('端口转发')
                    : page === 'workspace'
                      ? t('面板工作区')
                      : group === 'all'
                        ? t('全部服务器')
                        : group === 'connected'
                          ? t('已连接')
                          : group}
                </strong>
                <ChevronDown size={13} />
              </button>
              {navigationOpen && (
                <nav
                  id="workspace-navigation"
                  className="dropdown workspace-dropdown"
                  aria-label={t('快捷切换')}
                >
                  {[
                    { id: 'all', label: t('全部服务器'), Icon: ServerIcon, target: 'servers' as const },
                    { id: 'connected', label: t('已连接'), Icon: Link2, target: 'servers' as const },
                    { id: 'workspace', label: t('面板工作区'), Icon: Columns2, target: 'workspace' as const },
                    {
                      id: 'forwarding',
                      label: t('端口转发'),
                      Icon: ArrowUpRight,
                      target: 'forwarding' as const,
                    },
                    ...groups.map((name) => ({
                      id: name,
                      label: name,
                      Icon: Folder,
                      target: 'servers' as const,
                    })),
                  ].map(({ id, label, Icon, target }) => (
                    <button
                      key={target + id}
                      aria-current={
                        page === target && (target !== 'servers' || group === id) ? 'page' : undefined
                      }
                      onClick={() => {
                        setPage(target)
                        if (target === 'servers') {
                          setGroup(id)
                          setSearch('')
                        }
                        setNavigationOpen(false)
                        navigationRef.current?.querySelector('button')?.focus()
                      }}
                    >
                      <Icon size={15} />
                      <span className="truncate">{label}</span>
                    </button>
                  ))}
                </nav>
              )}
            </div>
          </div>
          <div className="topbar-right">
            {!desktop && <span className="preview-badge">{t('浏览器预览')}</span>}
            <span className="connection-count">
              <span className={`tiny-dot ${connected.length ? 'live' : ''}`} />
              {connected.length} {t('个连接')}
            </span>
          </div>
        </header>
        {remoteProgress && (
          <div className="operation-notice" role="status">
            {remoteProgress}
          </div>
        )}
        {page === 'servers' ? (
          <div className="server-page">
            <div className="page-heading">
              <div>
                <h1>
                  {group === 'all' ? t('我的服务器') : group === 'connected' ? t('已连接的服务器') : group}
                  <span>{visible.length}</span>
                </h1>
              </div>
              <button
                className="button primary"
                onClick={() => setEditing(freshServer())}
                disabled={!!loadError}
              >
                <Plus size={16} />
                {t('添加服务器')}
              </button>
            </div>
            <div className="overview-strip">
              <div>
                <span className="overview-icon">
                  <ServerIcon size={19} />
                </span>
                <span>
                  {t('服务器总数')}
                  <strong>{servers.length.toString().padStart(2, '0')}</strong>
                </span>
              </div>
              <div>
                <span className="overview-icon green">
                  <Link2 size={19} />
                </span>
                <span>
                  {t('活跃连接')}
                  <strong>
                    {connected.length.toString().padStart(2, '0')}
                    <i>{t('在线')}</i>
                  </strong>
                </span>
              </div>
              <div>
                <span className="overview-icon violet">
                  <Folder size={19} />
                </span>
                <span>
                  {t('服务器分组')}
                  <strong>{groups.length.toString().padStart(2, '0')}</strong>
                </span>
              </div>
            </div>
            <div className="collection-toolbar">
              <div className="filter-tabs">
                <button className={group === 'all' ? 'active' : ''} onClick={() => setGroup('all')}>
                  {t('全部服务器')}
                </button>
                <button
                  className={group === 'connected' ? 'active' : ''}
                  onClick={() => setGroup('connected')}
                >
                  {t('已连接')}
                  <span>{connected.length}</span>
                </button>
              </div>
              <label className="search-box">
                <Search size={16} />
                <input
                  id="server-search"
                  placeholder={t('搜索服务器…')}
                  value={search}
                  onChange={(e) => setSearch(e.target.value)}
                />
                {search ? (
                  <button className="icon-button" aria-label={t('清除搜索')} onClick={() => setSearch('')}>
                    <X size={14} />
                  </button>
                ) : (
                  <kbd>Ctrl K</kbd>
                )}
              </label>
            </div>
            {loadError ? (
              <div className="state-message error-state">
                <ShieldCheck size={30} />
                <h2>{t('无法读取配置')}</h2>
                <p>{t(loadError)}</p>
              </div>
            ) : loading ? (
              <div className="state-message">
                <LoaderCircle className="spin" size={28} />
                <p>{t('正在加载服务器')}</p>
              </div>
            ) : !servers.length ? (
              <div className="welcome-empty">
                <div className="empty-art">
                  <div className="orbit orbit-one" />
                  <div className="orbit orbit-two" />
                  <div className="art-node node-left">
                    <Terminal size={22} />
                  </div>
                  <div className="art-center">
                    <ServerIcon size={40} strokeWidth={1.4} />
                    <span className="art-led" />
                  </div>
                  <div className="art-node node-right">
                    <Monitor size={22} />
                  </div>
                  <span className="art-spark spark-one" />
                  <span className="art-spark spark-two" />
                </div>
                <h2>{t('从第一台服务器开始')}</h2>
                <button className="button primary" onClick={() => setEditing(freshServer())}>
                  <Plus size={16} />
                  {t('添加服务器')}
                </button>
              </div>
            ) : !visible.length ? (
              <div className="state-message">
                <Search size={30} />
                <h2>{search ? t('没有找到服务器') : t('暂无连接')}</h2>
                <button
                  className="text-button"
                  onClick={() => {
                    setSearch('')
                    setGroup('all')
                  }}
                >
                  {t('查看全部服务器')}
                </button>
              </div>
            ) : (
              <div className="server-grid">
                {visible.map((server) => {
                  const status = sessions[server.id]?.status ?? 'disconnected'
                  return (
                    <article className={`server-card ${status}`} key={server.id}>
                      <div className="card-top">
                        <div
                          className="server-symbol"
                          style={{ '--server-color': server.color } as React.CSSProperties}
                        >
                          <ServerIcon size={23} strokeWidth={1.6} />
                        </div>
                        <span className={`status-badge ${status}`}>
                          {status === 'connecting' ? (
                            <LoaderCircle className="spin" size={11} />
                          ) : (
                            <span className="tiny-dot" />
                          )}
                          {statusLabel(server)}
                        </span>
                        <div className="card-menu">
                          <button
                            className="icon-button"
                            aria-label={t('管理 {0}', server.name)}
                            aria-expanded={menu === server.id}
                            onClick={(e) => {
                              e.stopPropagation()
                              setMenu(menu === server.id ? null : server.id)
                            }}
                          >
                            <Ellipsis size={19} />
                          </button>
                          {menu === server.id && (
                            <div className="dropdown" onClick={(e) => e.stopPropagation()}>
                              <button onClick={() => edit(server)}>
                                <KeyRound size={14} />
                                {t('编辑服务器')}
                              </button>
                              {['connected', 'connecting'].includes(status) && (
                                <button
                                  onClick={() => {
                                    setMenu(null)
                                    void disconnect(server.id).catch(report)
                                  }}
                                >
                                  <Unplug size={14} />
                                  {t('断开连接')}
                                </button>
                              )}
                              <button className="danger-text" onClick={() => remove(server)}>
                                <Trash2 size={14} />
                                {t('删除服务器')}
                              </button>
                            </div>
                          )}
                        </div>
                      </div>
                      <h2>{server.name}</h2>
                      <div className="server-host">
                        {server.username}@{server.host}
                        <span>:{server.port}</span>
                      </div>
                      <div className="card-meta">
                        <span>
                          <Folder size={13} />
                          {server.group || t('未分组')}
                        </span>
                        <span>
                          <KeyRound size={13} />
                          {server.authType === 'key' ? t('SSH 私钥') : t('SSH 密码')}
                        </span>
                      </div>
                      <div className="card-divider" />
                      <div className="card-bottom">
                        <span className="panel-endpoint">
                          {server.panelEnabled ? (
                            <>
                              <span className="panel-icon">S</span>S-UI <span>:{server.panelPort}</span>
                            </>
                          ) : (
                            <>{server.realmEnabled ? 'realm' : t('仅 SSH')}</>
                          )}
                        </span>
                        <button
                          className={`connect-button ${status === 'connected' ? 'is-connected' : ''}`}
                          disabled={status === 'connecting'}
                          onClick={() =>
                            server.panelEnabled
                              ? void connect(server)
                              : server.realmEnabled
                                ? setPage('forwarding')
                                : edit(server)
                          }
                        >
                          {!server.panelEnabled
                            ? server.realmEnabled
                              ? t('端口转发')
                              : t('编辑服务器')
                            : status === 'connected'
                              ? t('打开面板')
                              : status === 'connecting'
                                ? t('连接中…')
                                : status === 'error'
                                  ? t('重新连接')
                                  : t('连接')}
                          {status === 'connecting' ? (
                            <LoaderCircle className="spin" size={14} />
                          ) : (
                            <ArrowUpRight size={15} />
                          )}
                        </button>
                      </div>
                    </article>
                  )
                })}
                <button className="add-card" onClick={() => setEditing(freshServer())}>
                  <span>
                    <Plus size={23} />
                  </span>
                  {t('添加服务器')}
                </button>
              </div>
            )}
          </div>
        ) : page === 'forwarding' ? (
          <ForwardingPage
            servers={servers}
            onUpdate={updateServer}
            runRemote={runRemote}
            onInitialize={initialize}
          />
        ) : (
          <div className="workspace-page">
            <div className="workspace-heading">
              <div>
                <h1>{t('面板工作区')}</h1>
                <span>
                  {connected.length} {t('个面板已连接')}
                </span>
              </div>
              <div className="workspace-actions">
                <div className="layout-switch">
                  {layoutOptions.map(({ id, name, Icon }) => (
                    <button
                      key={id}
                      className={layout === id ? 'active' : ''}
                      aria-label={name}
                      aria-pressed={layout === id}
                      title={name}
                      onClick={() => {
                        setLayout(id)
                        setActiveSlot((s) => Math.min(s, layoutSlots[id] - 1))
                      }}
                    >
                      <Icon size={17} />
                    </button>
                  ))}
                </div>
                <button className="button secondary" onClick={() => setPicker(activeSlot)}>
                  <Plus size={15} />
                  {t('打开面板')}
                </button>
              </div>
            </div>
            <div className="session-tabs">
              {connected.length ? (
                connected.map((server) => (
                  <button
                    className={panes[activeSlot] === server.id ? 'active' : ''}
                    key={server.id}
                    onClick={() => openPanel(server.id)}
                  >
                    <span className="tiny-dot live" />
                    {server.name}
                    <span
                      role="button"
                      tabIndex={0}
                      aria-label={t('断开 {0}', server.name)}
                      onKeyDown={(e) => {
                        if (e.key === 'Enter' || e.key === ' ') {
                          e.preventDefault()
                          e.stopPropagation()
                          void disconnect(server.id).catch(report)
                        }
                      }}
                      onClick={(e) => {
                        e.stopPropagation()
                        void disconnect(server.id).catch(report)
                      }}
                    >
                      <X size={13} />
                    </span>
                  </button>
                ))
              ) : (
                <span className="tabs-placeholder">
                  <Link2 size={14} />
                  {t('尚未建立连接')}
                </span>
              )}
            </div>
            <div className={`panes layout-${layout}`}>
              {Array.from({ length: layoutSlots[layout] }, (_, slot) => {
                const server = servers.find((s) => s.id === panes[slot])
                const session = server ? sessions[server.id] : null
                return (
                  <section
                    key={slot}
                    className={`pane ${slot === activeSlot ? 'active-pane' : ''}`}
                    onMouseDown={() => setActiveSlot(slot)}
                    aria-label={t('面板 {0}', slot + 1)}
                  >
                    <header className="pane-header">
                      <button
                        className="pane-select"
                        onClick={() => {
                          setActiveSlot(slot)
                          setPicker(slot)
                        }}
                      >
                        <span className={`tiny-dot ${session?.status === 'connected' ? 'live' : ''}`} />
                        {server?.name ?? t('面板 {0}', String(slot + 1).padStart(2, '0'))}
                        <ChevronDown size={13} />
                      </button>
                      <div>
                        {server && session?.status === 'connected' && (
                          <>
                            {server.hasPanelSecret && (
                              <button
                                className="icon-button"
                                aria-label={t('登录 {0}', server.name)}
                                title={t('使用保存的账号登录')}
                                onClick={() => void api.loginPanel(server.id).catch(report)}
                              >
                                <KeyRound size={14} />
                              </button>
                            )}
                            <button
                              className="icon-button"
                              aria-label={t('刷新 {0}', server.name)}
                              onClick={() => void api.reloadPanel(server.id).catch(report)}
                            >
                              <RefreshCw size={14} />
                            </button>
                            <button
                              className="icon-button"
                              aria-label={t('断开 {0}', server.name)}
                              onClick={() => void disconnect(server.id).catch(report)}
                            >
                              <Power size={14} />
                            </button>
                          </>
                        )}
                        <button
                          className="icon-button"
                          aria-label={t('清空面板 {0}', slot + 1)}
                          disabled={!server}
                          onClick={() => setPanes((p) => p.map((id, i) => (i === slot ? null : id)))}
                        >
                          <X size={14} />
                        </button>
                      </div>
                    </header>
                    <div
                      className="pane-content"
                      ref={(el) => {
                        if (el) paneElements.current.set(slot, el)
                        else paneElements.current.delete(slot)
                      }}
                    >
                      {session?.status === 'connected' ? (
                        <div className="panel-loading">
                          {/* A native child webview covers this placeholder. An
                              animated spinner keeps the host rendering forever. */}
                          <LayoutDashboard size={24} />
                          <span>{t('正在打开面板')}</span>
                        </div>
                      ) : (
                        <div className="pane-empty">
                          <div className="pane-empty-icon">
                            <LayoutDashboard size={30} strokeWidth={1.4} />
                          </div>
                          <h2>{server ? server.name : t('选择一个面板')}</h2>
                          {session?.message && <p className="pane-error">{t(session.message)}</p>}
                          <button
                            className="button secondary"
                            disabled={session?.status === 'connecting'}
                            onClick={() => {
                              setActiveSlot(slot)
                              if (server) void connect(server, slot)
                              else setPicker(slot)
                            }}
                          >
                            {session?.status === 'connecting' ? (
                              <LoaderCircle className="spin" size={15} />
                            ) : (
                              <Plus size={15} />
                            )}{' '}
                            {server
                              ? session?.status === 'connecting'
                                ? t('连接中…')
                                : t('重新连接')
                              : t('连接服务器')}
                          </button>
                        </div>
                      )}
                    </div>
                  </section>
                )
              })}
            </div>
            <div className="workspace-footer">
              <ShieldCheck size={13} />
              <span>{t('SSH 隧道')}</span>
              <span className="footer-right">{layoutOptions.find((l) => l.id === layout)?.name}</span>
            </div>
          </div>
        )}
      </main>
      {preferencesOpen && <PreferencesDialog onClose={() => setPreferencesOpen(false)} onError={report} />}
      {editing && (
        <ServerDialog
          initial={editing}
          editing={servers.some((s) => s.id === editing.id)}
          onClose={() => setEditing(null)}
          onSave={save}
          onResetHost={resetHost}
        />
      )}
      {confirm && (
        <div className="dialog-backdrop">
          <section
            className="dialog confirm-dialog"
            role="alertdialog"
            aria-modal="true"
            aria-labelledby="confirm-title"
          >
            <div className={`confirm-symbol ${confirm.danger ? 'danger' : ''}`}>
              <ShieldCheck size={25} />
            </div>
            <h2 id="confirm-title">{confirm.title}</h2>
            <p>{confirm.message}</p>
            {confirm.fingerprint && <code className="fingerprint">{confirm.fingerprint}</code>}
            {confirm.forceDelete !== undefined && (
              <div className="force-delete-option">
                <label className="checkbox-label">
                  <input
                    type="checkbox"
                    checked={confirm.forceDelete}
                    disabled={confirmBusy}
                    aria-describedby="force-delete-description"
                    onChange={(event) => setConfirm({ ...confirm, forceDelete: event.target.checked })}
                  />
                  {t('强制删除服务器')}
                </label>
                <p id="force-delete-description">
                  {t(
                    '仅移除本地配置、转发规则记录和已保存的 SSH / 面板凭证，不连接远端。远端规则可能继续运行，需自行清理。',
                  )}
                </p>
              </div>
            )}
            <footer className="dialog-footer">
              <button
                autoFocus
                className="button secondary"
                disabled={confirmBusy}
                onClick={() => setConfirm(null)}
              >
                {t('取消')}
              </button>
              <button
                className={`button ${confirm.danger ? 'danger' : 'primary'}`}
                disabled={confirmBusy || confirm.forceDelete === false}
                onClick={() => {
                  setConfirmBusy(true)
                  void confirm
                    .run(confirm.forceDelete)
                    .catch(report)
                    .finally(() => setConfirmBusy(false))
                }}
              >
                {confirmBusy ? t('处理中…') : confirm.forceDelete ? t('强制删除服务器') : confirm.action}
              </button>
            </footer>
          </section>
        </div>
      )}
      {picker !== null && (
        <div
          className="dialog-backdrop"
          onMouseDown={(e) => {
            if (e.target === e.currentTarget) setPicker(null)
          }}
        >
          <section
            className="dialog picker-dialog"
            role="dialog"
            aria-modal="true"
            aria-labelledby="picker-title"
          >
            <header className="dialog-heading">
              <h2 id="picker-title">{t('选择服务器')}</h2>
              <button
                autoFocus
                className="icon-button"
                aria-label={t('关闭选择器')}
                onClick={() => setPicker(null)}
              >
                <X size={19} />
              </button>
            </header>
            <div className="picker-list">
              {servers.some((s) => s.panelEnabled) ? (
                servers
                  .filter((s) => s.panelEnabled)
                  .map((server) => (
                    <button
                      key={server.id}
                      onClick={() => {
                        const slot = picker
                        setPicker(null)
                        void connect(server, slot)
                      }}
                    >
                      <span
                        className="server-symbol"
                        style={{ '--server-color': server.color } as React.CSSProperties}
                      >
                        <ServerIcon size={21} />
                      </span>
                      <span className="picker-name">
                        {server.name}
                        <small>{server.host}</small>
                      </span>
                      <span
                        className={`tiny-dot ${sessions[server.id]?.status === 'connected' ? 'live' : ''}`}
                      />
                      <ChevronRight size={16} />
                    </button>
                  ))
              ) : (
                <div className="state-message">
                  <ServerIcon size={28} />
                  <p>{t('先添加一台服务器')}</p>
                  <button
                    className="button primary"
                    onClick={() => {
                      setPicker(null)
                      setEditing(freshServer())
                    }}
                  >
                    <Plus size={15} />
                    {t('添加服务器')}
                  </button>
                </div>
              )}
            </div>
          </section>
        </div>
      )}
      {notice && (
        <div className={`toast ${notice.error ? 'error' : ''}`} role={notice.error ? 'alert' : 'status'}>
          {notice.error ? <CircleHelp size={17} /> : <Check size={17} />}
          <span>{t(notice.text)}</span>
          <button className="icon-button" aria-label={t('关闭提示')} onClick={() => setNotice(null)}>
            <X size={14} />
          </button>
        </div>
      )}
    </div>
  )
}
