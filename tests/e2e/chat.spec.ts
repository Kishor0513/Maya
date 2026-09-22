import { test, expect, type Page } from '@playwright/test';

// Happy-path E2E: type → Maya streams a full answer. The brain is stubbed
// at the network layer (canned SSE), so this runs offline, free, and fast.

const STREAM_FRAMES = [
  'data: {"delta": "Hey there! "}\n\n',
  'data: {"delta": "I\\u2019m Maya, live from the test rig."}\n\n',
  'data: [DONE]\n\n',
];

async function stubBrain(page: Page) {
  await page.route('**/api/chat/stream', async (route) => {
    await route.fulfill({
      status: 200,
      contentType: 'text/event-stream',
      body: STREAM_FRAMES.join(''),
    });
  });
  await page.route('**/api/chat', async (route) => {
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({ text: 'Fallback answer.' }),
    });
  });
}

async function dismissOnboarding(page: Page) {
  await page.getByRole('button', { name: 'Meet Maya' }).click();
  await page.getByRole('button', { name: 'Continue' }).click();
  await page.getByLabel('Your name').fill('Tester');
  await page.getByRole('button', { name: 'Start talking' }).click();
}

test.beforeEach(async ({ page }) => {
  await stubBrain(page);
  await page.goto('/?view=chat');
  await dismissOnboarding(page);
});

test('typed message streams a full assistant answer', async ({ page }) => {
  await page.locator('#maya-text').fill('Hello Maya');
  await page.keyboard.press('Enter');
  await expect(page.getByText('Hello Maya').first()).toBeVisible();
  await expect(page.getByText(/live from the test rig/)).toBeVisible({ timeout: 20000 });
  // No error toast may appear on the happy path.
  await expect(page.getByRole('alert')).toHaveCount(0);
});

test('suggestion chip sends and streams', async ({ page }) => {
  await page.getByRole('button', { name: 'Just say hi' }).click();
  await expect(page.getByText(/live from the test rig/)).toBeVisible({ timeout: 20000 });
});
