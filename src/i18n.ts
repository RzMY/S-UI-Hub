import english from './en.json'
import { getPreferences } from './preferences'

export function t(key: string, ...values: unknown[]): string {
  let phrase = getPreferences().language === 'en' ? ((english as Record<string, string>)[key] ?? key) : key
  if (getPreferences().language === 'en' && phrase === key) {
    const prefixes: Record<string, string> = {
      '无法访问系统凭证库：': 'Unable to access the system credential vault: ',
      '配置文件损坏，未覆盖原文件：': 'Configuration is invalid; the original file was preserved: ',
      '无法访问面板，请检查地址及 SSH 转发权限：':
        'Panel unavailable. Check the address and SSH forwarding permissions: ',
    }
    for (const [prefix, replacement] of Object.entries(prefixes)) {
      if (key.startsWith(prefix)) phrase = replacement + key.slice(prefix.length)
    }
  }
  return phrase.replace(/\{(\d+)\}/g, (_, index: string) => String(values[Number(index)] ?? ''))
}
