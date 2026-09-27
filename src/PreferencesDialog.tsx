import { useState } from 'react'
import { Globe2, Monitor, Moon, Sun, X } from 'lucide-react'
import { t } from './i18n'
import { updatePreferences, usePreferences } from './preferences'

export default function PreferencesDialog({
  onClose,
  onError,
}: {
  onClose: () => void
  onError: (e: unknown) => void
}) {
  const preferences = usePreferences()
  const [busy, setBusy] = useState(false)
  const save = async (patch: Partial<typeof preferences>) => {
    setBusy(true)
    try {
      await updatePreferences({ ...preferences, ...patch })
    } catch (e) {
      onError(e)
    } finally {
      setBusy(false)
    }
  }
  return (
    <div
      className="dialog-backdrop"
      onMouseDown={(e) => {
        if (e.target === e.currentTarget) onClose()
      }}
    >
      <section
        className="dialog preferences-dialog"
        role="dialog"
        aria-modal="true"
        aria-labelledby="preferences-title"
      >
        <header className="dialog-heading">
          <h2 id="preferences-title">{t('偏好设置')}</h2>
          <button autoFocus className="icon-button" aria-label={t('关闭')} onClick={onClose}>
            <X size={18} />
          </button>
        </header>
        <div className="preferences-content">
          <label className="preference-label">
            <Globe2 size={17} />
            {t('语言')}
            <select
              aria-label={t('语言')}
              disabled={busy}
              value={preferences.language}
              onChange={(e) => void save({ language: e.target.value as 'zh-CN' | 'en' })}
            >
              <option value="zh-CN">简体中文</option>
              <option value="en">English</option>
            </select>
          </label>
          <div className="preference-label">
            <Sun size={17} />
            {t('主题')}
          </div>
          <div className="theme-options">
            {(
              [
                { value: 'light', name: '浅色', Icon: Sun },
                { value: 'dark', name: '深色', Icon: Moon },
                { value: 'system', name: '跟随系统', Icon: Monitor },
              ] as const
            ).map(({ value, name, Icon }) => (
              <button
                key={value}
                disabled={busy}
                aria-pressed={preferences.theme === value}
                onClick={() => void save({ theme: value })}
              >
                <Icon size={22} />
                {t(name)}
              </button>
            ))}
          </div>
        </div>
      </section>
    </div>
  )
}
