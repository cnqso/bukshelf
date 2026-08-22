import { expect, test } from '@playwright/test';

const FRONTEND_ORIGIN = 'http://localhost:43282';
const DIAGNOSTICS_ORIGIN = 'http://localhost:43283';
const E2E_OWNER_PASSWORD = 'bukshelf-e2e-password';

interface Diagnostics {
  errors: string[];
}

const fetchServerErrors = async ({
  request,
}: {
  request: import('@playwright/test').APIRequestContext;
}): Promise<string[]> => {
  const response = await request.get(DIAGNOSTICS_ORIGIN);
  const body = (await response.json()) as Diagnostics;
  return body.errors;
};

test.beforeEach(async ({ page }) => {
  await page.addInitScript(() => window.localStorage.setItem('demoBooksFetched', 'true'));
});

test('the production standalone build renders signed-out and signed-in views with no server-side module errors', async ({
  page,
  request,
}) => {
  // The real regression target: a broken externalized-dependency symlink in
  // the shipped .next tree throws inside Next's server render, but Next
  // still returns 200 (degrading to client rendering) and the browser
  // console stays quiet. Only the server's own stderr shows it — see
  // apps/bukshelf-server/Dockerfile and e2e/bukshelf-prod/server.ts.
  expect(await fetchServerErrors({ request })).toEqual([]);

  await page.goto('/');
  await expect(page.getByRole('heading', { name: 'Books worth keeping close.' })).toBeVisible();
  await expect(page.getByRole('heading', { name: 'The Deterministic Shelf' })).toBeVisible();

  await page.getByRole('link', { name: /Log in/ }).click();
  await expect(page.getByRole('heading', { name: 'Unlock Bukshelf' })).toBeVisible();
  await page.getByLabel('Password').fill(E2E_OWNER_PASSWORD);
  await page.getByRole('button', { name: 'Unlock shelf' }).click();

  await expect(page).toHaveURL(`${FRONTEND_ORIGIN}/`);
  await expect(page.locator('[aria-label="Your Library"]')).toBeVisible();
  await expect(
    page.getByRole('heading', { name: 'The Deterministic Shelf', exact: true }),
  ).toBeVisible();

  expect(await fetchServerErrors({ request })).toEqual([]);
});
