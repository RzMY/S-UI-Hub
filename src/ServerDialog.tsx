import { t } from './i18n'
import { useRef, useState } from 'react'
import { Check, Eye, EyeOff, KeyRound, LockKeyhole, Server as ServerIcon, X } from 'lucide-react'
import { colors, validateServer } from './types'
import type { SaveServer, Server } from './types'
import { api, desktop } from './bridge'

export default function ServerDialog({
  initial,
  editing,
  onClose,
  onSave,
  onResetHost,
}: {
  initial: Server
  editing: boolean
  onClose: () => void
  onSave: (value: SaveServer) => Promise<void>
  onResetHost: () => void
}) {
  const [server, setServer] = useState(initial)
  const [secret, setSecret] = useState('')
  const [clearSecret, setClearSecret] = useState(false)
  const [panelSecret, setPanelSecret] = useState('')
  const [clearPanelSecret, setClearPanelSecret] = useState(false)
  const [resetPanel, setResetPanel] = useState(false)
  const [initializeSui, setInitializeSui] = useState(false)
  const [initializeRealm, setInitializeRealm] = useState(false)
  const [showPanelPassword, setShowPanelPassword] = useState(false)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const form = useRef<HTMLFormElement>(null)
  const field = <K extends keyof Server>(key: K, value: Server[K]) =>
    setServer((s) => ({ ...s, [key]: value }))

  async function submit(event: React.FormEvent) {
    event.preventDefault()
    const normalized = {
      ...server,
      name: server.name.trim(),
      host: server.host.trim(),
      username: server.username.trim(),
      group: server.group.trim(),
      panelHost: server.panelHost.trim(),
      privateKeyPath: server.privateKeyPath.trim(),
    }
    const invalid = validateServer(normalized)
    if (invalid) {
      setError(invalid)
      return
    }
    if (
      desktop &&
      server.authType === 'password' &&
      !secret &&
      (!server.hasSecret || initial.authType !== server.authType || clearSecret)
    ) {
      setError(t('请输入 SSH 密码'))
      return
    }
    if (
      (server.autoLogin || resetPanel || initializeSui || panelSecret) &&
      (!server.panelUsername.trim() || (!panelSecret && (!server.hasPanelSecret || clearPanelSecret)))
    ) {
      setError(t('请输入面板账号和密码'))
      return
    }
    if (resetPanel && !panelSecret) {
      setError(t('重置时请明确填写新的面板密码'))
      return
    }
    setBusy(true)
    setError('')
    try {
      await onSave({
        server: normalized,
        secret: secret.length ? secret : null,
        clearSecret,
        panelSecret: panelSecret || null,
        clearPanelSecret,
        resetPanel,
        initializeSui,
        initializeRealm,
      })
      onClose()
    } catch (e) {
      setError(typeof e === 'object' && e && 'message' in e ? String(e.message) : String(e))
    } finally {
      setBusy(false)
    }
  }

  return (
    <div
      className="dialog-backdrop"
      onMouseDown={(e) => {
        if (e.target === e.currentTarget && !busy) onClose()
      }}
    >
      <section
        className="dialog server-dialog"
        role="dialog"
        aria-modal="true"
        aria-labelledby="server-dialog-title"
        onKeyDown={(e) => {
          if (e.key === 'Escape' && !busy) onClose()
          if (e.key === 'Tab') {
            const items = Array.from(
              e.currentTarget.querySelectorAll<HTMLElement>(
                'button:not(:disabled), input:not(:disabled), select:not(:disabled), [tabindex="0"]',
              ),
            )
            if (e.shiftKey && document.activeElement === items[0]) {
              e.preventDefault()
              items.at(-1)?.focus()
            }
            if (!e.shiftKey && document.activeElement === items.at(-1)) {
              e.preventDefault()
              items[0]?.focus()
            }
          }
        }}
      >
        <header className="dialog-heading">
          <div className="dialog-symbol">
            <ServerIcon size={21} />
          </div>
          <h2 id="server-dialog-title">{editing ? t('编辑服务器') : t('添加服务器')}</h2>
          <button className="icon-button" aria-label={t('关闭')} onClick={onClose} disabled={busy}>
            <X size={19} />
          </button>
        </header>
        <form ref={form} onSubmit={submit}>
          <fieldset disabled={busy}>
            <div className="form-row">
              <label className="grow">
                {t('名称')}
                <input
                  autoFocus
                  required
                  maxLength={60}
                  placeholder={t('例如：东京 · 主节点')}
                  value={server.name}
                  onChange={(e) => field('name', e.target.value)}
                />
              </label>
              <label className="group-field">
                {t('分组')}
                <input
                  maxLength={60}
                  placeholder={t('未分组')}
                  value={server.group}
                  onChange={(e) => field('group', e.target.value)}
                />
              </label>
            </div>
            <div className="color-row">
              <span>{t('标记颜色')}</span>
              {colors.map((color) => (
                <button
                  type="button"
                  key={color}
                  className="color-dot"
                  style={{ background: color }}
                  aria-label={t('颜色 {0}', color)}
                  aria-pressed={server.color === color}
                  onClick={() => field('color', color)}
                >
                  {server.color === color && <Check size={14} />}
                </button>
              ))}
            </div>
            <h3 className="form-section">
              <LockKeyhole size={15} />
              {t('SSH 连接')}
            </h3>
            <div className="form-row">
              <label className="grow">
                {t('主机')}
                <input
                  required
                  placeholder={t('IP 地址或域名')}
                  value={server.host}
                  onChange={(e) => field('host', e.target.value)}
                />
              </label>
              <label className="port-field">
                {t('端口')}
                <input
                  required
                  type="number"
                  min="1"
                  max="65535"
                  value={server.port}
                  onChange={(e) => field('port', Number(e.target.value))}
                />
              </label>
            </div>
            <label>
              {t('用户名')}
              <input
                required
                autoComplete="off"
                value={server.username}
                onChange={(e) => field('username', e.target.value)}
              />
            </label>
            <div className="auth-switch">
              <button
                type="button"
                className={server.authType === 'password' ? 'active' : ''}
                onClick={() => {
                  field('authType', 'password')
                  setSecret('')
                  setClearSecret(false)
                }}
              >
                <LockKeyhole size={14} />
                {t('密码')}
              </button>
              <button
                type="button"
                className={server.authType === 'key' ? 'active' : ''}
                onClick={() => {
                  field('authType', 'key')
                  setSecret('')
                  setClearSecret(false)
                }}
              >
                <KeyRound size={14} />
                {t('私钥')}
              </button>
            </div>
            {server.authType === 'key' && (
              <label>
                {t('私钥路径')}
                <input
                  required
                  placeholder="~/.ssh/id_ed25519"
                  value={server.privateKeyPath}
                  onChange={(e) => field('privateKeyPath', e.target.value)}
                />
              </label>
            )}
            <label>
              {server.authType === 'password' ? t('SSH 密码') : t('私钥口令（可选）')}
              <input
                type="password"
                autoComplete="new-password"
                disabled={!desktop}
                placeholder={
                  !desktop
                    ? t('桌面应用中可保存凭证')
                    : initial.hasSecret && initial.authType === server.authType
                      ? t('已保存，留空保留原凭证')
                      : server.authType === 'key'
                        ? t('未加密的私钥可留空')
                        : t('输入密码')
                }
                value={secret}
                onChange={(e) => {
                  setSecret(e.target.value)
                  setClearSecret(false)
                }}
              />
            </label>
            {initial.hasSecret && server.authType === 'key' && (
              <label className="checkbox-label">
                <input
                  type="checkbox"
                  checked={clearSecret}
                  onChange={(e) => {
                    setClearSecret(e.target.checked)
                    setSecret('')
                  }}
                />
                {t('清除已保存的口令')}
              </label>
            )}
            <h3 className="form-section">{t('服务与初始化')}</h3>
            <label className="checkbox-label">
              <input
                type="checkbox"
                checked={server.panelEnabled}
                onChange={(e) => {
                  field('panelEnabled', e.target.checked)
                  if (!e.target.checked) {
                    field('autoLogin', false)
                    setInitializeSui(false)
                    setResetPanel(false)
                    setPanelSecret('')
                  }
                }}
              />
              {t('启用 S-UI 面板管理')}
            </label>
            <label className="checkbox-label">
              <input
                type="checkbox"
                disabled={!desktop || !server.panelEnabled}
                checked={initializeSui}
                onChange={(e) => {
                  setInitializeSui(e.target.checked)
                  setResetPanel(false)
                }}
              />
              {t('保存后初始化 S-UI')}
            </label>
            <label className="checkbox-label">
              <input
                type="checkbox"
                disabled={!desktop}
                checked={initializeRealm}
                onChange={(e) => {
                  setInitializeRealm(e.target.checked)
                  setResetPanel(false)
                }}
              />
              {t('保存后初始化 realm')}
            </label>
            <p className="form-hint">
              {t(
                '两项初始化均可选。仅转发可关闭 S-UI；已有面板无需初始化。支持 Alpine / Ubuntu，需 root 或免密 sudo。',
              )}
            </p>
            {initializeSui && (
              <p className="reset-notice">
                {t('将新装 S-UI，使用下方端口、路径和账号密码。已有安装会被保留。')}
              </p>
            )}
            {server.panelEnabled && (
              <>
                <h3 className="form-section">
                  <ServerIcon size={15} />
                  {t('S-UI 面板')}
                </h3>
                <div className="form-row">
                  <label className="protocol-field">
                    {t('协议')}
                    <select
                      value={server.panelScheme}
                      onChange={(e) => field('panelScheme', e.target.value as 'http' | 'https')}
                    >
                      <option value="http">HTTP</option>
                      <option value="https">HTTPS</option>
                    </select>
                  </label>
                  <label className="grow">
                    {t('面板主机')}
                    <input
                      required
                      value={server.panelHost}
                      onChange={(e) => field('panelHost', e.target.value)}
                    />
                  </label>
                  <label className="port-field">
                    {t('端口')}
                    <input
                      required
                      type="number"
                      min="1"
                      max="65535"
                      value={server.panelPort}
                      onChange={(e) => field('panelPort', Number(e.target.value))}
                    />
                  </label>
                </div>
                <label>
                  {t('面板路径')}
                  <input
                    required
                    placeholder="/"
                    value={server.panelPath}
                    onChange={(e) => field('panelPath', e.target.value)}
                  />
                </label>
                <h3 className="form-section">
                  <KeyRound size={15} />
                  {t('面板登录')}
                </h3>
                <div className="form-row">
                  <label className="grow">
                    {t('面板账号')}
                    <input
                      maxLength={128}
                      autoComplete="off"
                      placeholder={t('S-UI 登录账号')}
                      value={server.panelUsername}
                      onChange={(e) => field('panelUsername', e.target.value)}
                    />
                  </label>
                  <label className="grow">
                    {t('面板密码')}
                    <div className="password-field">
                      <input
                        type={showPanelPassword ? 'text' : 'password'}
                        autoComplete="new-password"
                        disabled={!desktop}
                        placeholder={
                          !desktop
                            ? t('桌面应用中可保存凭证')
                            : initial.hasPanelSecret
                              ? t('已保存，留空保留')
                              : t('S-UI 登录密码')
                        }
                        value={panelSecret}
                        onChange={(e) => {
                          setPanelSecret(e.target.value)
                          setClearPanelSecret(false)
                        }}
                      />
                      <button
                        type="button"
                        className="icon-button"
                        disabled={!desktop}
                        aria-label={showPanelPassword ? t('隐藏面板密码') : t('显示面板密码')}
                        onClick={async () => {
                          if (showPanelPassword) {
                            setShowPanelPassword(false)
                            return
                          }
                          if (!panelSecret && initial.hasPanelSecret && !clearPanelSecret) {
                            try {
                              setPanelSecret(await api.revealPanelPassword(initial.id))
                            } catch {
                              setError(t('无法读取已保存的面板密码'))
                              return
                            }
                          }
                          setShowPanelPassword(true)
                        }}
                      >
                        {showPanelPassword ? <EyeOff size={16} /> : <Eye size={16} />}
                      </button>
                    </div>
                  </label>
                </div>
                <label className="checkbox-label">
                  <input
                    type="checkbox"
                    disabled={!desktop}
                    checked={server.autoLogin}
                    onChange={(e) => field('autoLogin', e.target.checked)}
                  />
                  {t('连接后自动登录')}
                </label>
                {initial.hasPanelSecret && (
                  <label className="checkbox-label">
                    <input
                      type="checkbox"
                      checked={clearPanelSecret}
                      onChange={(e) => {
                        setClearPanelSecret(e.target.checked)
                        setPanelSecret('')
                        field('autoLogin', false)
                        setResetPanel(false)
                      }}
                    />
                    {t('清除已保存的面板密码')}
                  </label>
                )}
                <label className="checkbox-label reset-option">
                  <input
                    type="checkbox"
                    disabled={!desktop || initializeSui || initializeRealm}
                    checked={resetPanel}
                    onChange={(e) => setResetPanel(e.target.checked)}
                  />
                  {t('同时重置远端 S-UI 账号密码')}
                </label>
                {resetPanel && (
                  <div className="reset-notice">
                    {t('将把此 SSH 服务器上的第一个 S-UI 管理员修改为上方账号密码。保存后需再次确认。')}
                  </div>
                )}
              </>
            )}
            {initial.hostFingerprint && (
              <div className="fingerprint-row">
                <span title={initial.hostFingerprint}>{t('已验证 SSH 指纹')}</span>
                <button className="text-button" type="button" onClick={onResetHost}>
                  {t('重置')}
                </button>
              </div>
            )}
          </fieldset>
          {error && (
            <div className="form-error" role="alert">
              {t(error)}
            </div>
          )}
          <footer className="dialog-footer">
            <button type="button" className="button secondary" onClick={onClose} disabled={busy}>
              {t('取消')}
            </button>
            <button className="button primary" type="submit" disabled={busy}>
              {busy ? t('保存中…') : editing ? t('保存更改') : t('添加服务器')}
            </button>
          </footer>
        </form>
      </section>
    </div>
  )
}
