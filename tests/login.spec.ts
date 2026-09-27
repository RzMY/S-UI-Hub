import { test, expect } from '@playwright/test'
import { readFileSync } from 'node:fs'

const script = readFileSync('src-tauri/src/panel_login.js', 'utf8')
const password = 'test-only-quote"$!<>&'

test('auto-login submits the exact credentials once and never on another origin', async ({ page }) => {
  await page.route('http://127.0.0.1:15420/app/login', (route) =>
    route.fulfill({
      contentType: 'text/html',
      body: '<form><input type="text"><input type="password"><button type="submit">Login</button></form>',
    }),
  )
  await page.goto('/app/login')
  await page.evaluate(() => {
    Object.assign(window, { submissions: [] })
    document.querySelector('form')!.addEventListener('submit', (event) => {
      event.preventDefault()
      const data = Array.from(document.querySelectorAll('input')).map((input) => input.value)
      ;(window as unknown as { submissions: string[][] }).submissions.push(data)
    })
  })
  const args = { origin: 'http://127.0.0.1:15420', path: '/app/login', username: 'hub-admin', password }
  await page.evaluate(`(${script})(${JSON.stringify({ ...args, origin: 'http://wrong.example' })})`)
  await expect(page.locator('input[type=password]')).toHaveValue('')
  await page.evaluate(`(${script})(${JSON.stringify(args)})`)
  await expect
    .poll(() => page.evaluate(() => (window as unknown as { submissions: string[][] }).submissions))
    .toEqual([['hub-admin', password]])
})

test('auto-login never fills a password form outside the configured login path', async ({ page }) => {
  await page.goto('/')
  await page.setContent(
    '<form><input type="text"><input type="password"><button type="submit">Save</button></form>',
  )
  await page.evaluate(
    `(${script})(${JSON.stringify({ origin: 'http://127.0.0.1:15420', path: '/app/login', username: 'hub-admin', password })})`,
  )
  await expect(page.locator('input[type=password]')).toHaveValue('')
})
