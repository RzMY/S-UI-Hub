import { test, expect } from '@playwright/test'
import { readFileSync } from 'node:fs'

test('global language and theme persist, synchronize tabs and follow system changes', async ({
  page,
  context,
}) => {
  await page.goto('/')
  await page.getByRole('button', { name: '偏好设置' }).click()
  await page.getByLabel('语言', { exact: true }).selectOption('en')
  await expect(page.getByRole('heading', { name: 'Preferences' })).toBeVisible()
  await page.getByRole('button', { name: 'Dark', exact: true }).click()
  await expect(page.locator('html')).toHaveAttribute('data-theme', 'dark')
  await page.getByRole('button', { name: 'Close', exact: true }).click()
  await expect(page.getByRole('heading', { name: 'My servers' })).toBeVisible()
  await page.reload()
  await expect(page.locator('html')).toHaveAttribute('lang', 'en')
  await expect(page.locator('html')).toHaveAttribute('data-theme', 'dark')
  const other = await context.newPage()
  await other.goto('/')
  await page.getByRole('button', { name: 'Preferences' }).click()
  await page.getByRole('button', { name: 'System', exact: true }).click()
  await page.emulateMedia({ colorScheme: 'light' })
  await expect(page.locator('html')).toHaveAttribute('data-theme', 'light')
  await page.emulateMedia({ colorScheme: 'dark' })
  await expect(page.locator('html')).toHaveAttribute('data-theme', 'dark')
  await page.getByLabel('Language', { exact: true }).selectOption('zh-CN')
  await expect(other.locator('html')).toHaveAttribute('lang', 'zh-CN')
  await expect(other.getByRole('heading', { name: '我的服务器' })).toBeVisible()
})

test('S-UI preferences adapter updates Vue without navigation or losing form data', async ({ page }) => {
  const script = readFileSync('src-tauri/src/panel_preferences.js', 'utf8')
  await page.goto('/')
  await page.evaluate(() => {
    const root = document.createElement('div')
    root.id = 'app'
    document.body.append(root)
    const theme = {
      change(value: string) {
        Object.assign(window, { appliedTheme: value })
      },
    }
    Object.assign(root, {
      __vue_app__: {
        config: { globalProperties: { $i18n: { locale: 'en' } } },
        _context: { provides: { [Symbol('vuetify:theme')]: theme } },
      },
    })
    const input = document.createElement('input')
    input.id = 'unsaved'
    input.value = 'unsaved server edit'
    document.body.append(input)
  })
  await page.evaluate(
    `(${script})(${JSON.stringify({ origin: 'http://127.0.0.1:15420', language: 'zh-CN', theme: 'dark' })})`,
  )
  await expect(page.locator('#unsaved')).toHaveValue('unsaved server edit')
  expect(await page.evaluate(() => [localStorage.getItem('locale'), localStorage.getItem('theme')])).toEqual([
    'zhHans',
    'dark',
  ])
  await page.evaluate(
    `(${script})(${JSON.stringify({ origin: 'http://127.0.0.1:15420', language: 'en', theme: 'light' })})`,
  )
  expect(await page.evaluate(() => [localStorage.getItem('locale'), localStorage.getItem('theme')])).toEqual([
    'en',
    'light',
  ])
  await expect(page).toHaveURL('http://127.0.0.1:15420/')
})
