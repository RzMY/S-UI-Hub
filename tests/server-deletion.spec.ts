import { test, expect, type Page } from '@playwright/test'
import type { Server } from '../src/types'

const servers: Server[] = ['Offline relay', 'Other server'].map((name, index) => ({
  id: `00000000-0000-4000-8000-00000000000${index}`,
  name,
  host: `192.0.2.${50 + index}`,
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
  hasSecret: false,
  panelUsername: '',
  hasPanelSecret: false,
  autoLogin: false,
  panelEnabled: true,
  realmEnabled: true,
  realmInstalled: true,
  forwardingRules: [true, false].map((enabled, ruleIndex) => ({
    id: `10000000-0000-4000-8000-00000000000${ruleIndex}`,
    remark: `Rule ${ruleIndex}`,
    listenPort: 8443 + ruleIndex,
    remoteHost: 'example.org',
    remotePort: 443,
    enabled,
  })),
}))

async function seed(page: Page, desktop: boolean, saved = servers, failOnce = false) {
  await page.addInitScript(
    ({ desktop, saved, failOnce }) => {
      const key = 's-ui-hub.preview.servers.v1'
      if (!localStorage.getItem(key)) localStorage.setItem(key, JSON.stringify(saved))
      if (!desktop) return
      const calls: { cmd: string; args?: Record<string, unknown> }[] = []
      Object.assign(window, {
        isTauri: true,
        deletionCalls: calls,
        __TAURI_INTERNALS__: {
          transformCallback: () => 1,
          invoke: async (cmd: string, args?: Record<string, unknown>) => {
            calls.push({ cmd, args: structuredClone(args) })
            switch (cmd) {
              case 'read_preferences':
                return { language: 'zh-CN', theme: 'light' }
              case 'list_servers':
                return JSON.parse(localStorage.getItem(key)!)
              case 'list_sessions':
                return []
              case 'plugin:event|listen':
                return 1
              case 'sync_panels':
              case 'disconnect_server':
                return
              case 'delete_server': {
                if (failOnce) {
                  failOnce = false
                  throw { code: 'storage', message: '测试：配置写入失败' }
                }
                const current = JSON.parse(localStorage.getItem(key)!) as Server[]
                localStorage.setItem(key, JSON.stringify(current.filter((s) => s.id !== args!.id)))
                return
              }
              default:
                throw new Error(`Unexpected IPC: ${cmd}`)
            }
          },
        },
      })
    },
    { desktop, saved, failOnce },
  )
}

async function openDeletion(page: Page, name: string, english = false) {
  await page.getByRole('button', { name: `${english ? 'Manage' : '管理'} ${name}`, exact: true }).click()
  await page.getByRole('button', { name: english ? 'Delete server' : '删除服务器', exact: true }).click()
}

async function deletionCalls(page: Page) {
  return page.evaluate(
    () =>
      (
        window as unknown as {
          deletionCalls: { cmd: string; args?: Record<string, unknown> }[]
        }
      ).deletionCalls,
  )
}

for (const desktop of [false, true]) {
  test(`${desktop ? 'desktop IPC' : 'English dark preview'} force deletion is explicit, local and persistent`, async ({
    page,
  }) => {
    await seed(page, desktop)
    await page.goto('/')
    const english = !desktop
    if (english) {
      await page.getByRole('button', { name: '偏好设置' }).click()
      await page.getByLabel('语言', { exact: true }).selectOption('en')
      await page.getByRole('button', { name: 'Dark', exact: true }).click()
      await page.getByRole('button', { name: 'Close', exact: true }).click()
      await page.setViewportSize({ width: 960, height: 640 })
    }
    await openDeletion(page, 'Offline relay', english)
    const dialog = page.getByRole('alertdialog')
    const forceLabel = english ? 'Force delete server' : '强制删除服务器'
    const checkbox = dialog.getByRole('checkbox', { name: forceLabel, exact: true })
    await expect(checkbox).not.toBeChecked()
    await expect(
      dialog.getByRole('button', { name: english ? 'Delete server' : '删除服务器', exact: true }),
    ).toBeDisabled()
    await expect(dialog).toContainText(english ? '2 forwarding rules' : '2 条转发规则')
    await expect(dialog).toContainText(english ? 'Remote rules may keep running' : '远端规则可能继续运行')
    await checkbox.check()
    await dialog.getByRole('button', { name: english ? 'Cancel' : '取消', exact: true }).click()
    await expect(page.getByRole('heading', { name: 'Offline relay', exact: true })).toBeVisible()
    await openDeletion(page, 'Other server', english)
    await expect(checkbox).not.toBeChecked()
    await page.keyboard.press('Escape')
    if (desktop) expect((await deletionCalls(page)).some((c) => c.cmd === 'delete_server')).toBe(false)
    await openDeletion(page, 'Offline relay', english)
    await expect(checkbox).not.toBeChecked()
    await checkbox.check()
    await dialog.getByRole('button', { name: forceLabel, exact: true }).click()
    await expect(dialog).toHaveCount(0)
    await expect(page.getByRole('heading', { name: 'Offline relay', exact: true })).toHaveCount(0)
    if (desktop) {
      const calls = await deletionCalls(page)
      expect(calls.filter((c) => c.cmd === 'delete_server')).toEqual([
        { cmd: 'delete_server', args: { id: servers[0].id, force: true } },
      ])
      expect(
        calls.some((c) => ['connect_server', 'update_forwarding', 'initialize_service'].includes(c.cmd)),
      ).toBe(false)
    }
    await page.reload()
    await expect(page.getByRole('heading', { name: 'Offline relay', exact: true })).toHaveCount(0)
    await expect(page.getByRole('heading', { name: 'Other server', exact: true })).toBeVisible()
    expect(
      await page.evaluate(() => JSON.parse(localStorage.getItem('s-ui-hub.preview.servers.v1')!)),
    ).toEqual([servers[1]])
  })
}

test('ordinary desktop deletion sends force false and keeps the server after storage failure', async ({
  page,
}) => {
  await seed(page, true, [{ ...servers[0], forwardingRules: [] }], true)
  await page.goto('/')
  await openDeletion(page, 'Offline relay')
  const dialog = page.getByRole('alertdialog')
  await expect(dialog.getByRole('checkbox')).toHaveCount(0)
  await dialog.getByRole('button', { name: '删除服务器', exact: true }).click()
  await expect(page.getByRole('alert')).toContainText('测试：配置写入失败')
  await expect(dialog).toBeVisible()
  await expect(page.getByRole('heading', { name: 'Offline relay', exact: true })).toBeVisible()
  await dialog.getByRole('button', { name: '删除服务器', exact: true }).click()
  await expect(dialog).toHaveCount(0)
  const calls = (await deletionCalls(page)).filter((c) => c.cmd === 'delete_server')
  expect(calls).toHaveLength(2)
  expect(calls.every((c) => c.args?.force === false)).toBe(true)
})
