import { expect, test } from '@playwright/test';

const FRONTEND_ORIGIN = 'http://localhost:43281';
const BUKSHELF_ORIGIN = 'http://localhost:43282';
const E2E_OWNER_PASSWORD = 'bukshelf-e2e-password';

const observeBrowserErrors = (page: import('@playwright/test').Page) => {
  const errors: string[] = [];
  const failedResponses: { status: number; url: string }[] = [];
  page.on('console', (message) => {
    if (
      message.type() === 'error' &&
      !/^Failed to load resource: the server responded with a status of 401/.test(message.text())
    )
      errors.push(message.text());
  });
  page.on('pageerror', (error) => errors.push(error.message));
  page.on('response', (response) => {
    if (response.status() >= 400)
      failedResponses.push({ status: response.status(), url: response.url() });
  });
  return { errors, failedResponses };
};

test.beforeEach(async ({ page }) => {
  await page.addInitScript(() => window.localStorage.setItem('demoBooksFetched', 'true'));
});

test('signed-out visitors see the public SQLite shelf served by Bun', async ({ page }) => {
  const browser = observeBrowserErrors(page);
  const publicRequest = page.waitForResponse(
    (response) => response.url() === `${BUKSHELF_ORIGIN}/api/public/library`,
  );
  await page.goto('/');

  await expect(page.getByRole('heading', { name: 'Books worth keeping close.' })).toBeVisible();
  await expect(page.getByRole('heading', { name: 'The Deterministic Shelf' })).toBeVisible();
  await expect(page.getByText('Bukshelf Test Suite')).toBeVisible();
  await expect(page.getByAltText('Cover of The Deterministic Shelf')).toBeVisible();

  const response = await publicRequest;
  expect(response.request().url().startsWith(BUKSHELF_ORIGIN)).toBe(true);
  expect(response.headers()['access-control-allow-origin']).toBe(FRONTEND_ORIGIN);
  const payload = (await response.json()) as { books: Record<string, unknown>[] };
  expect(payload.books).toHaveLength(1);
  expect(payload.books[0]).toEqual({
    id: expect.any(String),
    title: 'The Deterministic Shelf',
    author: 'Bukshelf Test Suite',
    coverUrl: expect.stringMatching(/^\/api\/public\/library\/covers\//),
  });
  expect(JSON.stringify(payload)).not.toContain('book bytes');
  expect(JSON.stringify(payload)).not.toContain('bukshelf-e2e-book');
  expect(browser.errors).toEqual([]);
  expect(
    browser.failedResponses.every(
      (response) =>
        response.status === 401 && response.url === `${BUKSHELF_ORIGIN}/api/auth/session`,
    ),
  ).toBe(true);
});

test('the owner login rejects a bad password and authenticates directly with Bun', async ({
  page,
}) => {
  const browser = observeBrowserErrors(page);
  const legacyInboxRequests: string[] = [];
  page.on('request', (request) => {
    if (request.url().includes('/send/inbox/')) legacyInboxRequests.push(request.url());
  });
  await page.goto('/');
  await page.getByRole('link', { name: /Log in/ }).click();
  await expect(page.getByRole('heading', { name: 'Unlock Bukshelf' })).toBeVisible();

  await page.getByLabel('Password').fill('incorrect-password');
  await page.getByRole('button', { name: 'Unlock shelf' }).click();
  await expect(page.getByText('Invalid password')).toBeVisible();
  // Chromium reports the intentional 401 as a console resource error. The
  // successful owner session below must be clean.
  browser.errors.length = 0;
  browser.failedResponses.length = 0;

  const loginResponse = page.waitForResponse(
    (response) =>
      response.url() === `${BUKSHELF_ORIGIN}/api/auth/login` && response.status() === 200,
  );
  await page.getByLabel('Password').fill(E2E_OWNER_PASSWORD);
  await page.getByRole('button', { name: 'Unlock shelf' }).click();
  await loginResponse;

  await expect(page).toHaveURL(`${FRONTEND_ORIGIN}/`);
  await expect(page.locator('[aria-label="Your Library"]')).toBeVisible();
  await expect(
    page.getByRole('heading', { name: 'The Deterministic Shelf', exact: true }),
  ).toBeVisible();

  const bookDownload = page.waitForResponse((response) => {
    const url = new URL(response.url());
    return (
      url.origin === BUKSHELF_ORIGIN &&
      url.pathname === '/api/files' &&
      url.searchParams.get('path') ===
        'Readest/Books/bukshelf-e2e-book/The Deterministic Shelf.epub' &&
      response.status() === 200
    );
  });
  await page.getByRole('button', { name: 'Download Book' }).click();
  expect(await (await bookDownload).body()).toEqual(Buffer.from('e2e book bytes'));
  const session = await page.evaluate(() => ({
    token: window.localStorage.getItem('token'),
    user: window.localStorage.getItem('user'),
  }));
  expect(session.token).toBeTruthy();
  expect(session.user).toContain('owner@bukshelf.test');
  expect(legacyInboxRequests).toEqual([]);
  expect(browser.failedResponses).toEqual([]);
  expect(browser.errors).toEqual([]);
});

test('a stored owner session survives a full page reload', async ({ page }) => {
  const browser = observeBrowserErrors(page);
  await page.goto('/auth?redirect=/');
  await page.getByLabel('Password').fill(E2E_OWNER_PASSWORD);
  await page.getByRole('button', { name: 'Unlock shelf' }).click();
  await expect(page.locator('[aria-label="Your Library"]')).toBeVisible();
  await expect(
    page.getByRole('heading', { name: 'The Deterministic Shelf', exact: true }),
  ).toBeVisible();
  browser.errors.length = 0;
  browser.failedResponses.length = 0;

  const restoredSession = page.waitForResponse(
    (response) =>
      response.url() === `${BUKSHELF_ORIGIN}/api/auth/session` && response.status() === 200,
  );
  await page.reload();
  await restoredSession;

  await expect(page.locator('[aria-label="Your Library"]')).toBeVisible();
  await expect(page.getByRole('heading', { name: 'Books worth keeping close.' })).toBeHidden();
  expect(browser.failedResponses).toEqual([]);
  expect(browser.errors).toEqual([]);
});
