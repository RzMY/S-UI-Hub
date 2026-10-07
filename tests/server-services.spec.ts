import { test, expect } from '@playwright/test'
import type { Server } from '../src/types'

test.beforeEach(async ({ page }) => {
  await page.addInitScript(() => {
    const servers: Server[] = []
    const calls: { cmd: string; args?: Record<string, unknown> }[] = []
    Object.assign(window, {
      isTauri: true,
      serviceCalls: calls,
      __TAURI_INTERNALS__: {
        transformCallback: () => 1,
        invoke: async (cmd: string, args?: Record<string, unknown>) => {
          calls.push({ cmd, args: structuredClone(args) })
          switch (cmd) {
            case 'read_preferences':
              return { language: 'zh-CN', theme: 'light' }
            case 'list_servers':
              return structuredClone(servers)
            case 'list_sessions':
              return []
            case 'save_server': {
              const server = structuredClone(args!.server) as Server
              if ((args!.panelCredentials as { action: string | null }).action) {
                // The Rust tests cover actual randomness and preservation. This
                // fixture models the backend returning the generated username.
                server.panelUsername ||= 'generated-admin'
                server.hasPanelSecret = true
              }
              server.hasSecret = true
              const old = servers.findIndex((s) => s.id === server.id)
              if (old < 0) servers.push(server)
              else servers[old] = server
              return structuredClone(server)
            }
            case 'initialize_service':
              return structuredClone(servers.find((s) => s.id === args!.id))
            case 'reset_panel_credentials':
              return
            case 'plugin:event|listen':
              return 1
          }
        },
      },
    })
  })
  await page.goto('/')
})

test('service defaults, conditional initialization and blank credentials reach the backend', async ({
  page,
}) => {
  await page.getByRole('button', { name: '添加服务器', exact: true }).first().click()
  const dialog = page.getByRole('dialog')
  const sui = dialog.getByLabel('启用 S-UI 面板管理', { exact: true })
  const realm = dialog.getByLabel('启用 realm 端口转发管理', { exact: true })
  const initializeSui = dialog.getByLabel('初始化 S-UI（未安装时安装）', { exact: true })
  const initializeRealm = dialog.getByLabel('初始化 realm（未安装时安装）', { exact: true })
  await expect(sui).toBeChecked()
  await expect(initializeSui).toBeChecked()
  await expect(dialog.getByLabel('连接后自动登录', { exact: true })).toBeChecked()
  await expect(realm).not.toBeChecked()
  await expect(initializeRealm).toHaveCount(0)
  await realm.check()
  await expect(initializeRealm).not.toBeChecked()
  await initializeRealm.check()
  await realm.uncheck()
  await expect(initializeRealm).toHaveCount(0)
  await sui.uncheck()
  await expect(initializeSui).toHaveCount(0)
  await expect(dialog.getByLabel('面板账号', { exact: true })).toHaveCount(0)
  await sui.check()
  await expect(initializeSui).not.toBeChecked()
  await initializeSui.check()
  await dialog.getByLabel('名称', { exact: true }).fill('SUI default')
  await dialog.getByLabel('主机', { exact: true }).fill('192.0.2.41')
  await dialog.getByLabel('SSH 密码', { exact: true }).fill('test-ssh-secret')
  await dialog.getByRole('button', { name: '添加服务器', exact: true }).click()
  await expect(dialog).toHaveCount(0)
  await expect(page.getByRole('status')).toContainText('所选服务初始化完成')
  const calls = await page.evaluate(
    () =>
      (
        window as unknown as {
          serviceCalls: { cmd: string; args?: Record<string, unknown> }[]
        }
      ).serviceCalls,
  )
  const saved = calls.find((call) => call.cmd === 'save_server')!.args!
  expect(saved.panelCredentials).toMatchObject({ action: 'initialize', secret: null })
  expect(saved.server).toMatchObject({ panelUsername: '', autoLogin: true, realmEnabled: false })
  expect(calls.filter((call) => call.cmd === 'initialize_service').map((call) => call.args!.service)).toEqual(
    ['sui'],
  )
  await page.getByRole('button', { name: '管理 SUI default', exact: true }).click()
  await page.getByRole('button', { name: '编辑服务器', exact: true }).click()
  await expect(initializeSui).not.toBeChecked()
  await expect(dialog.getByLabel('面板账号', { exact: true })).toHaveValue('generated-admin')
})

test('existing panels save without generating credentials and blank resets use the generated account in confirmation', async ({
  page,
}) => {
  await page.getByRole('button', { name: '添加服务器', exact: true }).first().click()
  const dialog = page.getByRole('dialog')
  await dialog.getByLabel('名称', { exact: true }).fill('Existing SUI')
  await dialog.getByLabel('主机', { exact: true }).fill('192.0.2.42')
  await dialog.getByLabel('SSH 密码', { exact: true }).fill('test-ssh-secret')
  await dialog.getByLabel('初始化 S-UI（未安装时安装）', { exact: true }).uncheck()
  await dialog.getByRole('button', { name: '添加服务器', exact: true }).click()
  await expect(dialog).toHaveCount(0)
  let calls = await page.evaluate(
    () =>
      (
        window as unknown as {
          serviceCalls: { cmd: string; args?: Record<string, unknown> }[]
        }
      ).serviceCalls,
  )
  expect(calls.find((call) => call.cmd === 'save_server')!.args!.panelCredentials).toMatchObject({
    action: null,
  })
  expect(calls.some((call) => call.cmd === 'initialize_service')).toBe(false)
  await page.getByRole('button', { name: '管理 Existing SUI', exact: true }).click()
  await page.getByRole('button', { name: '编辑服务器', exact: true }).click()
  await dialog.getByLabel('同时重置远端 S-UI 账号密码', { exact: true }).check()
  await dialog.getByRole('button', { name: '保存更改', exact: true }).click()
  const confirmation = page.getByRole('alertdialog')
  await expect(confirmation).toContainText('generated-admin')
  await expect(confirmation).toContainText('192.0.2.42:22')
  calls = await page.evaluate(
    () =>
      (
        window as unknown as {
          serviceCalls: { cmd: string; args?: Record<string, unknown> }[]
        }
      ).serviceCalls,
  )
  expect(calls.filter((call) => call.cmd === 'save_server').at(-1)!.args).toMatchObject({
    panelCredentials: { action: 'reset', secret: null, clear: false },
  })
  expect(calls.some((call) => call.cmd === 'reset_panel_credentials')).toBe(false)
  await confirmation.getByRole('button', { name: '确认重置', exact: true }).click()
  await expect(page.getByRole('status')).toContainText('远端面板账号密码已重置')
})
