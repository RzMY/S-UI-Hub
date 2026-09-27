import { invoke, isTauri } from '@tauri-apps/api/core'
import { listen } from '@tauri-apps/api/event'
import { useSyncExternalStore } from 'react'

export interface Preferences {
  language: 'zh-CN' | 'en'
  theme: 'light' | 'dark' | 'system'
}
const storageKey = 's-ui-hub.preferences.v1'
let current: Preferences = { language: 'zh-CN', theme: 'system' }
const subscribers = new Set<() => void>()
const systemTheme =
  typeof matchMedia === 'function'
    ? matchMedia('(prefers-color-scheme: dark)')
    : { matches: false, addEventListener: () => {} }
export let preferenceLoadError = ''

function apply(value: Preferences) {
  current = value
  document.documentElement.lang = value.language
  document.documentElement.dataset.theme =
    value.theme === 'system' ? (systemTheme.matches ? 'dark' : 'light') : value.theme
  subscribers.forEach((fn) => fn())
}
function valid(value: unknown): value is Preferences {
  return (
    typeof value === 'object' &&
    value !== null &&
    'language' in value &&
    'theme' in value &&
    ['zh-CN', 'en'].includes(String(value.language)) &&
    ['light', 'dark', 'system'].includes(String(value.theme))
  )
}
export async function initializePreferences() {
  try {
    const saved = isTauri()
      ? await invoke<Preferences>('read_preferences')
      : JSON.parse(localStorage.getItem(storageKey) ?? 'null')
    if (valid(saved)) apply(saved)
    else apply(current)
  } catch {
    preferenceLoadError = '无法读取偏好设置'
    apply(current)
  }
  systemTheme.addEventListener('change', () => {
    if (current.theme === 'system') apply(current)
  })
  if (isTauri())
    await listen<Preferences>('preferences-changed', (e) => {
      if (valid(e.payload)) apply(e.payload)
    })
  else
    window.addEventListener('storage', (e) => {
      if (e.key === storageKey && e.newValue) {
        try {
          const v = JSON.parse(e.newValue)
          if (valid(v)) apply(v)
        } catch {
          /* Ignore invalid external storage. */
        }
      }
    })
}
export async function updatePreferences(value: Preferences) {
  if (!valid(value)) throw Error('Invalid preferences')
  if (isTauri()) await invoke('save_preferences', { preferences: value })
  else localStorage.setItem(storageKey, JSON.stringify(value))
  apply(value)
}
export const getPreferences = () => current
export const usePreferences = () =>
  useSyncExternalStore((callback) => {
    subscribers.add(callback)
    return () => {
      subscribers.delete(callback)
    }
  }, getPreferences)
