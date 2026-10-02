import { test, expect } from '@playwright/test'
import type { PanelBounds, Session } from '../src/types'

test('connected panels and the disconnected workspace have no perpetual loading animation', async ({
  page,
}) => {
  await page.addInitScript(() => {
    const servers = ['one', 'two'].map((id) => ({
      id,
      name: `Test ${id}`,
      host: '127.0.0.1',
      port: 22,
      username: 'root',
      group: '',
      authType: 'password',
      privateKeyPath: '',
      panelHost: '127.0.0.1',
      panelPort: 2095,
      panelPath: '/app/',
      panelScheme: 'http',
      color: '#7cb798',
      hostFingerprint: null,
      hasSecret: true,
      panelUsername: '',
      hasPanelSecret: false,
      autoLogin: false,
    }))
    const sessions = new Map<string, Session>()
    Object.assign(window, {
      isTauri: true,
      syncedPanels: [] as PanelBounds[],
      __TAURI_INTERNALS__: {
        transformCallback: () => 1,
        invoke: async (cmd: string, args?: { id: string; panels: PanelBounds[] }) => {
          switch (cmd) {
            case 'read_preferences':
              return { language: 'zh-CN', theme: 'light' }
            case 'list_servers':
              return servers
            case 'list_sessions':
              return [...sessions.values()]
            case 'connect_server': {
              const session: Session = { id: args!.id, status: 'connected' }
              sessions.set(session.id, session)
              return session
            }
            case 'disconnect_server':
              sessions.delete(args!.id)
              return
            case 'sync_panels':
              Object.assign(window, { syncedPanels: args!.panels })
              return
            case 'plugin:event|listen':
              return 1
          }
        },
      },
    })
  })
  await page.goto('/')
  for (const name of ['Test one', 'Test two']) {
    await page.locator('.sidebar').getByRole('button', { name: /^全部服务器/ }).click()
    await page
      .locator('.server-card')
      .filter({ hasText: name })
      .getByRole('button', { name: '连接', exact: true })
      .click()
    await expect(page.locator('.panel-loading')).toBeVisible()
    await expect.poll(() => page.evaluate(() => document.getAnimations().length)).toBe(0)
  }
  for (const name of ['Test one', 'Test two']) {
    await page
      .getByRole('button', { name: `断开 ${name}`, exact: true })
      .first()
      .click()
  }
  await expect(page.getByText('尚未建立连接')).toBeVisible()
  await expect(page.locator('.panel-loading')).toHaveCount(0)
  await expect
    .poll(() => page.evaluate(() => (window as unknown as { syncedPanels: PanelBounds[] }).syncedPanels))
    .toEqual([])
  await expect.poll(() => page.evaluate(() => document.getAnimations().length)).toBe(0)
})
