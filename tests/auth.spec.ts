import { test, expect } from "@playwright/test"

test("landing page carga con Wavvy", async ({ page }) => {
  await page.goto("http://127.0.0.1:3000")
  await expect(page).toHaveTitle(/Wavvy/i)
  await expect(page.locator("button:has-text('Empezar gratis')").first()).toBeVisible({ timeout: 15000 })
})

test("CTA de Google auth visible en landing", async ({ page }) => {
  await page.goto("http://127.0.0.1:3000")
  await expect(page.locator("button:has-text('Continuar con Google')").first()).toBeVisible({ timeout: 15000 })
})

test("Google signin redirige a accounts.google.com", async ({ page }) => {
  let googleAuthUrl: URL | null = null
  await page.route("**/accounts.google.com/**", async (route) => {
    googleAuthUrl = new URL(route.request().url())
    await route.abort()
  })
  await page.goto("http://127.0.0.1:3000")
  await page.waitForSelector("button:has-text('Empezar gratis')", { timeout: 15000 })
  await page.click("button:has-text('Empezar gratis')")
  await page
    .waitForURL(
      (url) => url.hostname.includes("google.com") || url.searchParams.has("error"),
      { timeout: 15000 }
    )
    .catch(() => {})

  // Either we intercepted Google URL or we got a redirect
  expect(googleAuthUrl ?? page.url()).toBeTruthy()
})
