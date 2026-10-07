import { useState } from 'react'
import { ArrowRight, Check, Network, Pencil, Plus, Power, RefreshCw, Trash2, X } from 'lucide-react'
import { api, desktop } from './bridge'
import { t } from './i18n'
import { getError, validateForwardRule } from './types'
import type { ForwardRule, Server } from './types'

export default function ForwardingPage({
  servers: allServers,
  onUpdate,
  runRemote,
  onInitialize,
}: {
  servers: Server[]
  onUpdate: (server: Server) => void
  runRemote: (server: Server, action: () => Promise<void>) => Promise<void>
  onInitialize: (server: Server, services: ('sui' | 'realm')[]) => Promise<void>
}) {
  const servers = allServers.filter((s) => s.realmEnabled)
  const [filter, setFilter] = useState('')
  const [draft, setDraft] = useState<{ serverId: string; rule: ForwardRule; editing: boolean } | null>(null)
  const [removing, setRemoving] = useState<{ server: Server; rule: ForwardRule } | null>(null)
  const [busy, setBusy] = useState(false)
  const [feedback, setFeedback] = useState<{ text: string; error: boolean } | null>(null)
  const selected = servers.find((s) => s.id === filter)
  const rows = servers
    .filter((s) => !filter || s.id === filter)
    .flatMap((server) => server.forwardingRules.map((rule) => ({ server, rule })))
  const eligible = servers.filter((s) => s.realmInstalled || !desktop)

  async function perform(server: Server, action: () => Promise<Server>) {
    const apply = async () => {
      setBusy(true)
      try {
        onUpdate(await action())
        setDraft(null)
        setRemoving(null)
        setFeedback({
          text: desktop ? t('规则已应用到服务器') : t('预览规则已保存，未执行远端操作'),
          error: false,
        })
      } finally {
        setBusy(false)
      }
    }
    setFeedback(null)
    try {
      await runRemote(server, apply)
    } catch (error) {
      setFeedback({ text: t(getError(error).message), error: true })
    }
  }

  return (
    <div className="server-page forwarding-page">
      <div className="page-heading">
        <div>
          <h1>
            {t('端口转发')}
            <span>{rows.length}</span>
          </h1>
        </div>
        <button
          className="button primary"
          disabled={busy || !eligible.length}
          onClick={() => {
            setFeedback(null)
            setDraft({
              serverId: eligible.find((s) => s.id === filter)?.id ?? eligible[0].id,
              editing: false,
              rule: {
                id: crypto.randomUUID(),
                remark: '',
                listenPort: 10000,
                remoteHost: '',
                remotePort: 443,
                enabled: true,
              },
            })
          }}
        >
          <Plus size={16} />
          {t('新增规则')}
        </button>
      </div>
      <div className="forwarding-toolbar">
        <label>
          {t('选择服务器')}
          <select value={filter} disabled={busy} onChange={(e) => setFilter(e.target.value)}>
            <option value="">{t('全部服务器')}</option>
            {servers.map((s) => (
              <option key={s.id} value={s.id}>
                {s.name}
                {s.realmInstalled ? ' · realm' : ''}
              </option>
            ))}
          </select>
        </label>
        {selected && (
          <>
            <span className="service-state">
              {selected.realmInstalled ? t('realm 已初始化') : t('realm 未初始化')}
            </span>
            <button
              className="button secondary"
              disabled={busy || !desktop}
              onClick={async () => {
                setBusy(true)
                setFeedback(null)
                try {
                  await onInitialize(selected, ['realm'])
                } catch (e) {
                  setFeedback({ text: t(getError(e).message), error: true })
                } finally {
                  setBusy(false)
                }
              }}
            >
              <Network size={15} />
              {selected.realmInstalled ? t('检查 realm 安装') : t('初始化 realm')}
            </button>
            {selected.realmInstalled && (
              <button
                className="button secondary"
                disabled={busy}
                onClick={() =>
                  void perform(selected, () => api.updateForwarding(selected.id, { kind: 'apply' }))
                }
              >
                <RefreshCw size={15} />
                {t('重新应用规则')}
              </button>
            )}
          </>
        )}
      </div>
      {busy && (
        <p role="status" className="operation-notice">
          {t('正在处理，请稍候…')}
        </p>
      )}
      {feedback && !draft && !removing && (
        <div
          role={feedback.error ? 'alert' : 'status'}
          className={feedback.error ? 'form-error' : 'operation-notice'}
        >
          {feedback.text}
        </div>
      )}
      {rows.length ? (
        <div className="forwarding-list">
          {rows.map(({ server, rule }) => (
            <article key={`${server.id}-${rule.id}`} className="forwarding-card">
              <div className="forwarding-title">
                <Network size={19} />
                <h2>{rule.remark || t('未填写备注')}</h2>
                <span className={`status-badge ${rule.enabled ? 'connected' : 'disconnected'}`}>
                  {rule.enabled ? t('已启用') : t('已停用')}
                </span>
              </div>
              <div className="forwarding-route">
                <span>
                  <small>{server.name}</small>
                  <code>
                    {server.host.includes(':') ? `[${server.host}]` : server.host}:{rule.listenPort}
                  </code>
                </span>
                <ArrowRight size={18} />
                <span>
                  <small>{t('转发目标')}</small>
                  <code>
                    {rule.remoteHost.includes(':') ? `[${rule.remoteHost}]` : rule.remoteHost}:
                    {rule.remotePort}
                  </code>
                </span>
              </div>
              <div className="forwarding-actions">
                <span>TCP + UDP</span>
                <button
                  className="button secondary"
                  disabled={busy}
                  onClick={() => {
                    setFeedback(null)
                    setDraft({ serverId: server.id, rule: { ...rule }, editing: true })
                  }}
                >
                  <Pencil size={14} />
                  {t('编辑')}
                </button>
                <button
                  className="button secondary"
                  disabled={busy}
                  onClick={() =>
                    void perform(server, () =>
                      api.updateForwarding(server.id, {
                        kind: 'save',
                        rule: { ...rule, enabled: !rule.enabled },
                      }),
                    )
                  }
                >
                  <Power size={14} />
                  {rule.enabled ? t('停用') : t('启用')}
                </button>
                <button
                  className="icon-button danger-text"
                  disabled={busy}
                  aria-label={t('删除规则 {0}', rule.remark || rule.listenPort)}
                  onClick={() => {
                    setFeedback(null)
                    setRemoving({ server, rule })
                  }}
                >
                  <Trash2 size={16} />
                </button>
              </div>
            </article>
          ))}
        </div>
      ) : (
        <div className="state-message">
          <Network size={34} />
          <h2>{t('暂无转发规则')}</h2>
        </div>
      )}
      {draft && (
        <div className="dialog-backdrop">
          <section
            className="dialog server-dialog"
            role="dialog"
            aria-modal="true"
            aria-labelledby="forwarding-title"
            onKeyDown={(e) => {
              if (e.key === 'Escape' && !busy) setDraft(null)
              if (e.key === 'Tab') {
                const items = Array.from(
                  e.currentTarget.querySelectorAll<HTMLElement>(
                    'button:not(:disabled), input:not(:disabled), select:not(:disabled)',
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
              <Network size={21} />
              <h2 id="forwarding-title">{draft.editing ? t('编辑转发规则') : t('新增规则')}</h2>
              <button
                className="icon-button"
                disabled={busy}
                aria-label={t('关闭')}
                onClick={() => setDraft(null)}
              >
                <X size={19} />
              </button>
            </header>
            <form
              onSubmit={(e) => {
                e.preventDefault()
                const server = servers.find((s) => s.id === draft.serverId)
                if (!server) return
                const rule = {
                  ...draft.rule,
                  remark: draft.rule.remark.trim(),
                  remoteHost: draft.rule.remoteHost.trim(),
                }
                const error = validateForwardRule(rule, server)
                if (error) {
                  setFeedback({ text: error, error: true })
                  return
                }
                void perform(server, () => api.updateForwarding(server.id, { kind: 'save', rule }))
              }}
            >
              <fieldset disabled={busy}>
                <label>
                  {t('备注')}
                  <input
                    autoFocus
                    maxLength={120}
                    value={draft.rule.remark}
                    onChange={(e) => setDraft({ ...draft, rule: { ...draft.rule, remark: e.target.value } })}
                  />
                </label>
                <label>
                  {t('选择服务器')}
                  <select
                    disabled={draft.editing}
                    value={draft.serverId}
                    onChange={(e) => setDraft({ ...draft, serverId: e.target.value })}
                  >
                    {eligible.map((s) => (
                      <option key={s.id} value={s.id}>
                        {s.name} · {s.host}
                      </option>
                    ))}
                  </select>
                </label>
                <label>
                  {t('入站端口')}
                  <input
                    required
                    type="number"
                    min={1}
                    max={65535}
                    value={draft.rule.listenPort}
                    onChange={(e) =>
                      setDraft({ ...draft, rule: { ...draft.rule, listenPort: Number(e.target.value) } })
                    }
                  />
                </label>
                <div className="form-row">
                  <label className="grow">
                    {t('转发地址')}
                    <input
                      required
                      placeholder={t('IP 地址或域名')}
                      value={draft.rule.remoteHost}
                      onChange={(e) =>
                        setDraft({ ...draft, rule: { ...draft.rule, remoteHost: e.target.value } })
                      }
                    />
                  </label>
                  <label className="port-field">
                    {t('转发端口')}
                    <input
                      required
                      type="number"
                      min={1}
                      max={65535}
                      value={draft.rule.remotePort}
                      onChange={(e) =>
                        setDraft({ ...draft, rule: { ...draft.rule, remotePort: Number(e.target.value) } })
                      }
                    />
                  </label>
                </div>
                <label className="checkbox-label">
                  <input
                    type="checkbox"
                    checked={draft.rule.enabled}
                    onChange={(e) =>
                      setDraft({ ...draft, rule: { ...draft.rule, enabled: e.target.checked } })
                    }
                  />
                  {t('启用规则')}
                </label>
              </fieldset>
              {feedback?.error && (
                <div role="alert" className="form-error">
                  {feedback.text}
                </div>
              )}
              <footer className="dialog-footer">
                <button
                  type="button"
                  className="button secondary"
                  disabled={busy}
                  onClick={() => setDraft(null)}
                >
                  {t('取消')}
                </button>
                <button type="submit" className="button primary" disabled={busy}>
                  <Check size={15} />
                  {busy ? t('正在应用…') : t('保存规则')}
                </button>
              </footer>
            </form>
          </section>
        </div>
      )}
      {removing && (
        <div className="dialog-backdrop">
          <section
            className="dialog confirm-dialog"
            role="alertdialog"
            aria-modal="true"
            aria-labelledby="remove-rule-title"
          >
            <h2 id="remove-rule-title">{t('删除转发规则？')}</h2>
            <p>{t('将移除 {0} 上的入站端口 {1} 转发。', removing.server.name, removing.rule.listenPort)}</p>
            {feedback?.error && (
              <div className="form-error" role="alert">
                {feedback.text}
              </div>
            )}
            <footer className="dialog-footer">
              <button
                autoFocus
                className="button secondary"
                disabled={busy}
                onClick={() => setRemoving(null)}
              >
                {t('取消')}
              </button>
              <button
                className="button danger"
                disabled={busy}
                onClick={() =>
                  void perform(removing.server, () =>
                    api.updateForwarding(removing.server.id, { kind: 'delete', id: removing.rule.id }),
                  )
                }
              >
                {t('删除规则')}
              </button>
            </footer>
          </section>
        </div>
      )}
    </div>
  )
}
