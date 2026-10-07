import { test, expect } from '@playwright/test'
import type { Server } from '../src/types'

test('desktop realm-only initialization verifies fingerprint and never connects S-UI', async ({ page }) => {
  await page.addInitScript(() => {
    const servers: Server[] = []
    const calls: string[] = []
    Object.assign(window, {
      isTauri: true,
      managementCalls: calls,
      __TAURI_INTERNALS__: {
        transformCallback: () => 1,
        invoke: async (
          cmd: string,
          args?: { server: Server; id: string; service: string; fingerprint: string },
        ) => {
          calls.push(cmd)
          switch (cmd) {
            case 'read_preferences':
              return { language: 'zh-CN', theme: 'light' }
            case 'list_servers':
              return structuredClone(servers)
            case 'list_sessions':
              return []
            case 'save_server':
              servers.push(args!.server)
              return args!.server
            case 'initialize_service': {
              if (args!.service !== 'realm') throw new Error('Unexpected S-UI initialization')
              const server = servers.find((s) => s.id === args!.id)!
              if (!server.hostFingerprint)
                throw { code: 'host_key_unknown', message: 'unknown', fingerprint: 'SHA256:test' }
              server.realmInstalled = true
              return structuredClone(server)
            }
            case 'trust_host':
              servers.find((s) => s.id === args!.id)!.hostFingerprint = args!.fingerprint
              return
            case 'plugin:event|listen':
              return 1
          }
        },
      },
    })
  })
  await page.goto('/')
  await page.getByRole('button', { name: '添加服务器', exact: true }).first().click()
  const dialog = page.getByRole('dialog')
  await dialog.getByLabel('名称', { exact: true }).fill('Standalone realm')
  await dialog.getByLabel('主机', { exact: true }).fill('192.0.2.30')
  await dialog.getByLabel('SSH 密码', { exact: true }).fill('test-only-password')
  await dialog.getByLabel('启用 S-UI 面板管理', { exact: true }).uncheck()
  await dialog.getByLabel('启用 realm 端口转发管理', { exact: true }).check()
  await dialog.getByLabel('初始化 realm（未安装时安装）', { exact: true }).check()
  await dialog.getByRole('button', { name: '添加服务器', exact: true }).click()
  const trust = page.getByRole('alertdialog')
  await expect(trust).toContainText('SHA256:test')
  await trust.getByRole('button', { name: '信任并继续', exact: true }).click()
  await expect(page.getByRole('status')).toContainText('所选服务初始化完成')
  const calls = await page.evaluate(
    () => (window as unknown as { managementCalls: string[] }).managementCalls,
  )
  expect(calls.filter((cmd) => cmd === 'initialize_service')).toHaveLength(2)
  expect(calls).not.toContain('connect_server')
  await page.getByRole('button', { name: '端口转发', exact: true }).first().click()
  await expect(page.getByRole('button', { name: '新增规则', exact: true })).toBeEnabled()
})

test('SSH-only server and forwarding rule lifecycle persist without S-UI', async ({ page }) => {
  await page.goto('/')
  await page.getByRole('button', { name: '添加服务器', exact: true }).first().click()
  const dialog = page.getByRole('dialog')
  await dialog.getByLabel('名称', { exact: true }).fill('Alpine relay')
  await dialog.getByLabel('主机', { exact: true }).fill('192.0.2.25')
  await dialog.getByLabel('启用 S-UI 面板管理', { exact: true }).uncheck()
  await expect(dialog.getByLabel('面板主机', { exact: true })).toHaveCount(0)
  await expect(dialog.getByLabel('初始化 realm（未安装时安装）', { exact: true })).toHaveCount(0)
  await dialog.getByLabel('启用 realm 端口转发管理', { exact: true }).check()
  await expect(dialog.getByLabel('初始化 realm（未安装时安装）', { exact: true })).toBeDisabled()
  await dialog.getByRole('button', { name: '添加服务器', exact: true }).click()
  await expect(page.getByRole('heading', { name: 'Alpine relay' })).toBeVisible()
  await page.getByRole('button', { name: '端口转发', exact: true }).first().click()
  await page.getByRole('button', { name: '新增规则', exact: true }).click()
  await dialog.getByLabel('备注', { exact: true }).fill('Web relay')
  await dialog.getByLabel('入站端口', { exact: true }).fill('10443')
  await dialog.getByLabel('转发地址', { exact: true }).fill('2001:db8::1')
  await dialog.getByRole('button', { name: '保存规则', exact: true }).click()
  await expect(page.getByRole('heading', { name: 'Web relay' })).toBeVisible()
  await expect(page.getByText('[2001:db8::1]:443', { exact: true })).toBeVisible()
  await page.reload()
  await page.getByRole('button', { name: '端口转发', exact: true }).first().click()
  await page.getByRole('button', { name: '新增规则', exact: true }).click()
  await dialog.getByLabel('入站端口', { exact: true }).fill('10443')
  await dialog.getByLabel('转发地址', { exact: true }).fill('example.com')
  await dialog.getByRole('button', { name: '保存规则', exact: true }).click()
  await expect(dialog.getByRole('alert')).toHaveText('同一服务器的入站端口不能重复')
  await dialog.getByRole('button', { name: '取消', exact: true }).click()
  await page.getByRole('button', { name: '编辑', exact: true }).click()
  await expect(dialog.getByRole('combobox', { name: '选择服务器', exact: true })).toBeDisabled()
  await dialog.getByLabel('转发地址', { exact: true }).fill('example.org')
  await dialog.getByRole('button', { name: '保存规则', exact: true }).click()
  await page.getByRole('button', { name: '停用', exact: true }).click()
  await expect(page.getByText('已停用', { exact: true })).toBeVisible()
  await page.getByRole('button', { name: '启用', exact: true }).click()
  await expect(page.getByText('已启用', { exact: true })).toBeVisible()
  await page.getByRole('button', { name: '删除规则 Web relay', exact: true }).click()
  await page.getByRole('alertdialog').getByRole('button', { name: '删除规则', exact: true }).click()
  await expect(page.getByRole('heading', { name: '暂无转发规则' })).toBeVisible()
  await page.locator('.sidebar').getByRole('button', { name: '全部服务器' }).click()
  await page.getByRole('button', { name: '面板工作区', exact: true }).click()
  await page.getByRole('button', { name: '打开面板', exact: true }).click()
  await expect(dialog.getByText('Alpine relay')).toHaveCount(0)
})

test('forwarding supports English and dark theme', async ({ page }) => {
  await page.goto('/')
  await page.getByRole('button', { name: '偏好设置' }).click()
  await page.getByLabel('语言', { exact: true }).selectOption('en')
  await page.getByRole('button', { name: 'Dark', exact: true }).click()
  await page.getByRole('button', { name: 'Close', exact: true }).click()
  await page.getByRole('button', { name: 'Port forwarding', exact: true }).click()
  await expect(page.getByRole('heading', { name: 'Port forwarding' })).toBeVisible()
  await expect(page.getByRole('button', { name: 'Add rule', exact: true })).toBeDisabled()
  await expect(page.locator('html')).toHaveAttribute('data-theme', 'dark')
  await page.setViewportSize({ width: 960, height: 640 })
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true)
})
