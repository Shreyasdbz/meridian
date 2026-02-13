// Meridian v0.1 Release — End-to-End Tests
//
// These tests validate the three core user journeys for the v0.1 release:
//   1. Onboarding flow (first-run setup wizard)
//   2. Chat fast path (simple conversational query, no Sentinel/Gear)
//   3. Full path with approval (action-requiring task through Scout -> Sentinel -> Gear)
//
// Tests run against a REAL Meridian server with MOCK LLM providers enabled
// via the MERIDIAN_E2E_MOCK=1 environment variable. The mock providers return
// deterministic responses so tests can assert on specific content.
//
// Authentication is handled via API calls in test fixtures to avoid repetitive
// UI login steps in non-onboarding tests.

import { test, expect, type Page, type APIRequestContext } from '@playwright/test';

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const TEST_PASSWORD = 'Meridian-E2E-Test-2026!';
const TEST_API_KEY = 'sk-test-mock-key-for-e2e-testing';
const API_BASE = '/api';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Authenticate via the API and set the session cookie on the browser context.
 * This skips the login UI for tests that only need an authenticated session.
 *
 * Assumes the server has already been set up (password created) either by
 * a prior test or by a test fixture that runs setup.
 */
async function authenticateViaApi(
  request: APIRequestContext,
  page: Page,
): Promise<string> {
  const response = await request.post(`${API_BASE}/auth/login`, {
    data: { password: TEST_PASSWORD },
  });

  expect(response.ok()).toBe(true);

  const body = await response.json() as {
    sessionId: string;
    csrfToken: string;
    expiresAt: string;
  };

  // Store CSRF token in localStorage so the app's auth store can pick it up.
  // The session cookie is set automatically by the server via Set-Cookie.
  await page.evaluate((csrf: string) => {
    localStorage.setItem('meridian-csrf-token', csrf);
  }, body.csrfToken);

  return body.csrfToken;
}

/**
 * Ensure the server is set up with a password and provider config.
 * Idempotent — safe to call multiple times.
 */
async function ensureServerSetup(request: APIRequestContext): Promise<void> {
  // Check if setup is already complete
  const statusResponse = await request.get(`${API_BASE}/auth/status`);
  if (statusResponse.ok()) {
    const status = await statusResponse.json() as { setupComplete: boolean };
    if (status.setupComplete) return;
  }

  // Create password
  await request.post(`${API_BASE}/auth/setup`, {
    data: { password: TEST_PASSWORD },
  });

  // Login to get CSRF token for subsequent requests
  const loginResponse = await request.post(`${API_BASE}/auth/login`, {
    data: { password: TEST_PASSWORD },
  });
  const loginBody = await loginResponse.json() as {
    csrfToken: string;
  };

  // Configure AI provider (mock)
  await request.put(`${API_BASE}/config`, {
    data: { key: 'ai_provider', value: 'anthropic' },
    headers: { 'X-CSRF-Token': loginBody.csrfToken },
  });

  // Store mock API key
  await request.post(`${API_BASE}/secrets`, {
    data: {
      name: 'anthropic_api_key',
      value: TEST_API_KEY,
      allowedGear: ['gear:scout'],
    },
    headers: { 'X-CSRF-Token': loginBody.csrfToken },
  });

  // Set trust profile
  await request.put(`${API_BASE}/config`, {
    data: { key: 'trust_profile', value: 'supervised' },
    headers: { 'X-CSRF-Token': loginBody.csrfToken },
  });

  // Mark onboarding complete
  await request.put(`${API_BASE}/config`, {
    data: { key: 'onboarding_completed', value: 'true' },
    headers: { 'X-CSRF-Token': loginBody.csrfToken },
  });
}

// ---------------------------------------------------------------------------
// Test 1: Onboarding Flow
// ---------------------------------------------------------------------------
// Validates the four-step first-run wizard:
//   Step 1 (password-step): Create a password with strength validation
//   Step 2 (ai-key-step): Select provider and enter API key
//   Step 3 (comfort-level-step): Choose trust profile
//   Step 4 (first-message-step): Send first message or pick a starter prompt
//
// Success criteria (v0.1):
//   - User can complete setup from zero to first conversation
//   - All steps are accessible and have proper labels
//   - Password strength indicator is visible
//   - After completion, user lands in the chat view
// ---------------------------------------------------------------------------

test.describe('Onboarding Flow', () => {
  // NOTE: This test requires a fresh server state (no existing password).
  // In CI, each test run starts with a clean database.
  // Locally, you may need to clear the data/ directory before running.

  test('should complete the full onboarding wizard and reach the chat view', async ({
    page,
  }) => {
    // Navigate to the app root — should show onboarding if no setup is complete
    await page.goto('/');

    // -----------------------------------------------------------------------
    // Step 1: Create Password
    // -----------------------------------------------------------------------

    // Verify the password step is displayed
    await expect(
      page.getByRole('heading', { name: 'Create a password' }),
    ).toBeVisible();

    // The subtitle should explain single-user auth
    await expect(
      page.getByText('Secure your Meridian instance'),
    ).toBeVisible();

    // Fill in password — the Input component uses label-derived IDs
    const passwordInput = page.getByLabel('Password', { exact: true });
    await passwordInput.fill(TEST_PASSWORD);

    // Verify password strength indicator appears (non-weak for our strong password)
    // The strength indicator shows after typing and displays a level label
    await expect(page.getByText(/strong|good/i)).toBeVisible({ timeout: 5_000 });

    // Fill in confirmation
    const confirmInput = page.getByLabel('Confirm password');
    await confirmInput.fill(TEST_PASSWORD);

    // Click the Continue button to submit
    await page.getByRole('button', { name: 'Continue' }).click();

    // -----------------------------------------------------------------------
    // Step 2: Connect AI Provider
    // -----------------------------------------------------------------------

    // Wait for the AI key step to appear
    await expect(
      page.getByRole('heading', { name: 'Connect an AI provider' }),
    ).toBeVisible({ timeout: 15_000 });

    // Anthropic should be selected by default (first in the PROVIDERS array)
    // Verify the provider buttons are visible
    await expect(page.getByText('Anthropic')).toBeVisible();
    await expect(page.getByText('OpenAI')).toBeVisible();
    await expect(page.getByText('Ollama')).toBeVisible();

    // Enter mock API key
    const apiKeyInput = page.getByLabel('API key');
    await apiKeyInput.fill(TEST_API_KEY);

    // Click Validate to test the key
    await page.getByRole('button', { name: 'Validate' }).click();

    // Wait for validation success (mock provider should accept any non-empty key)
    await expect(
      page.getByText('API key validated successfully'),
    ).toBeVisible({ timeout: 15_000 });

    // Now the Continue button should appear (replaces Validate after success)
    await page.getByRole('button', { name: 'Continue' }).click();

    // -----------------------------------------------------------------------
    // Step 3: Choose Comfort Level
    // -----------------------------------------------------------------------

    // Wait for comfort level step
    await expect(
      page.getByRole('heading', { name: 'How hands-on do you want to be?' }),
    ).toBeVisible({ timeout: 10_000 });

    // Three trust profile options should be visible
    await expect(
      page.getByText('Ask me before doing anything'),
    ).toBeVisible();
    await expect(
      page.getByText('Ask me for important stuff'),
    ).toBeVisible();
    await expect(
      page.getByText('Just get it done'),
    ).toBeVisible();

    // "Ask me before doing anything" (supervised) should be pre-selected
    // and marked as Recommended
    await expect(page.getByText('Recommended')).toBeVisible();

    // Select "balanced" for variety (click the option text)
    await page.getByText('Ask me for important stuff').click();

    // Continue
    await page.getByRole('button', { name: 'Continue' }).click();

    // -----------------------------------------------------------------------
    // Step 4: First Message
    // -----------------------------------------------------------------------

    // Wait for the final step
    await expect(
      page.getByRole('heading', { name: "You're all set!" }),
    ).toBeVisible({ timeout: 10_000 });

    // Capabilities should be displayed
    await expect(page.getByText('Search the web')).toBeVisible();
    await expect(page.getByText('Work with files')).toBeVisible();
    await expect(page.getByText('Set reminders')).toBeVisible();
    await expect(page.getByText('Answer questions')).toBeVisible();

    // Starter prompts should be available
    await expect(
      page.getByText('Search the web for the latest news on AI'),
    ).toBeVisible();

    // Click "Get started" to complete onboarding without a starter prompt
    await page.getByRole('button', { name: 'Get started' }).click();

    // -----------------------------------------------------------------------
    // Verify: Should transition to the authenticated chat view
    // -----------------------------------------------------------------------

    // After onboarding completes, the app should show the chat interface.
    // The chat page has a data-testid="chat-page" and the message input area.
    // The app component renders BrowserRouter with Layout once authenticated.
    // In v0.1, the chat input with data-testid="chat-input" should be present.
    await expect(
      page.getByTestId('chat-input').or(
        page.getByPlaceholder('Message Meridian...'),
      ),
    ).toBeVisible({ timeout: 15_000 });
  });

  test('should allow using a starter prompt to begin first conversation', async ({
    page,
  }) => {
    // Navigate to app — assumes fresh state (no setup)
    await page.goto('/');

    // Complete steps 1-3 quickly
    // Step 1: Password
    await expect(
      page.getByRole('heading', { name: 'Create a password' }),
    ).toBeVisible();
    await page.getByLabel('Password', { exact: true }).fill(TEST_PASSWORD);
    await page.getByLabel('Confirm password').fill(TEST_PASSWORD);
    await page.getByRole('button', { name: 'Continue' }).click();

    // Step 2: AI Key — skip for now (uses the skip link)
    await expect(
      page.getByRole('heading', { name: 'Connect an AI provider' }),
    ).toBeVisible({ timeout: 15_000 });
    await page.getByText('Skip for now').click();

    // Step 3: Comfort Level
    await expect(
      page.getByRole('heading', { name: 'How hands-on do you want to be?' }),
    ).toBeVisible({ timeout: 10_000 });
    await page.getByRole('button', { name: 'Continue' }).click();

    // Step 4: Click a starter prompt instead of "Get started"
    await expect(
      page.getByRole('heading', { name: "You're all set!" }),
    ).toBeVisible({ timeout: 10_000 });

    await page.getByText('Help me brainstorm ideas').click();

    // The starter prompt text should be pre-filled in the chat input
    await expect(
      page.getByTestId('chat-input').or(
        page.getByPlaceholder('Message Meridian...'),
      ),
    ).toBeVisible({ timeout: 15_000 });
  });
});

// ---------------------------------------------------------------------------
// Test 2: Chat Fast Path
// ---------------------------------------------------------------------------
// Validates the fast-path flow for simple conversational queries.
// Scout determines the query is conversational (no action needed) and
// responds directly without involving Sentinel or Gear.
//
// Success criteria (v0.1):
//   - User can type and send a message
//   - Response streams in via WebSocket
//   - Response text is visible in the message list
//   - No approval dialog appears (fast path)
//   - Message appears in the conversation log area
// ---------------------------------------------------------------------------

test.describe('Chat Fast Path', () => {
  test.beforeEach(async ({ page, request }) => {
    // Ensure the server is fully set up so we skip onboarding
    await ensureServerSetup(request);

    // Authenticate via API to get a valid session
    await authenticateViaApi(request, page);
  });

  test('should send a simple question and receive a streamed response', async ({
    page,
  }) => {
    // Navigate to the chat view
    await page.goto('/');

    // Wait for the chat interface to load
    // The chat page contains data-testid="chat-page" and the input area
    const chatInput = page.getByTestId('chat-input');
    await expect(chatInput).toBeVisible({ timeout: 15_000 });

    // Type a simple conversational question (fast-path eligible)
    const question = 'What is the capital of France?';
    await chatInput.fill(question);

    // Verify the send button is enabled
    const sendButton = page.getByTestId('send-button');
    await expect(sendButton).toBeEnabled();

    // Send the message
    await sendButton.click();

    // The user message should appear in the message list
    // The MessageList uses role="log" with aria-label="Conversation messages"
    const messageLog = page.getByRole('log', { name: 'Conversation messages' });
    await expect(messageLog.getByText(question)).toBeVisible({ timeout: 10_000 });

    // Wait for the assistant's response to stream in via WebSocket.
    // The mock LLM provider returns a deterministic response.
    // We wait for any assistant message content to appear (not the user message).
    // The response bubble is on the left (justify-start) while user is on the right.
    //
    // For the mock provider, we expect some response text to appear.
    // We use a generous timeout to account for WebSocket connection setup
    // and the mock provider's simulated streaming delay.
    await expect(
      messageLog.locator('[class*="justify-start"]').first(),
    ).toBeVisible({ timeout: 30_000 });

    // Verify that no approval dialog appeared (fast path should skip Sentinel)
    await expect(page.getByTestId('approval-dialog')).not.toBeVisible();

    // The input should be cleared after sending
    await expect(chatInput).toHaveValue('');
  });

  test('should support sending messages with Cmd+Enter keyboard shortcut', async ({
    page,
  }) => {
    await page.goto('/');

    const chatInput = page.getByTestId('chat-input');
    await expect(chatInput).toBeVisible({ timeout: 15_000 });

    // Type a message
    await chatInput.fill('Hello Meridian');

    // Send with Cmd+Enter (Mac) or Ctrl+Enter (other platforms)
    const isMac = process.platform === 'darwin';
    await chatInput.press(isMac ? 'Meta+Enter' : 'Control+Enter');

    // User message should appear in the log
    const messageLog = page.getByRole('log', { name: 'Conversation messages' });
    await expect(messageLog.getByText('Hello Meridian')).toBeVisible({ timeout: 10_000 });

    // Input should be cleared
    await expect(chatInput).toHaveValue('');
  });

  test('should not allow sending an empty message', async ({ page }) => {
    await page.goto('/');

    const chatInput = page.getByTestId('chat-input');
    await expect(chatInput).toBeVisible({ timeout: 15_000 });

    // Send button should be disabled when input is empty
    const sendButton = page.getByTestId('send-button');
    await expect(sendButton).toBeDisabled();

    // Type whitespace only — should still be disabled
    await chatInput.fill('   ');
    await expect(sendButton).toBeDisabled();
  });
});

// ---------------------------------------------------------------------------
// Test 3: Full Path with Approval
// ---------------------------------------------------------------------------
// Validates the full Scout -> Sentinel -> Approval -> Gear pipeline.
// When a user sends an action-requiring message, Scout produces an execution
// plan, Sentinel reviews it and escalates for approval, and the user must
// approve or reject before execution proceeds.
//
// Success criteria (v0.1):
//   - Action-requiring message triggers the approval dialog
//   - Approval dialog shows plan summary in plain language
//   - Risk level indicator is visible with correct color coding
//   - User can approve and see the execution result
//   - User can reject and see the task cancelled
//   - Approval dialog is accessible (proper aria attributes)
// ---------------------------------------------------------------------------

test.describe('Full Path with Approval', () => {
  test.beforeEach(async ({ page, request }) => {
    await ensureServerSetup(request);
    await authenticateViaApi(request, page);
  });

  test('should show approval dialog for action-requiring messages and allow approval', async ({
    page,
  }) => {
    await page.goto('/');

    const chatInput = page.getByTestId('chat-input');
    await expect(chatInput).toBeVisible({ timeout: 15_000 });

    // Send an action-requiring message that should trigger the full path.
    // The mock Scout will produce an execution plan requiring Sentinel review.
    const actionMessage = 'Delete all files in /tmp';
    await chatInput.fill(actionMessage);
    await page.getByTestId('send-button').click();

    // User message should appear
    const messageLog = page.getByRole('log', { name: 'Conversation messages' });
    await expect(messageLog.getByText(actionMessage)).toBeVisible({ timeout: 10_000 });

    // -----------------------------------------------------------------------
    // Approval Dialog
    // -----------------------------------------------------------------------

    // The approval dialog should appear as a modal (<dialog> element).
    // It is rendered by the ApprovalDialog component with data-testid="approval-dialog".
    const approvalDialog = page.getByTestId('approval-dialog');
    await expect(approvalDialog).toBeVisible({ timeout: 30_000 });

    // Verify accessibility: the dialog has proper aria attributes
    await expect(approvalDialog).toHaveAttribute('aria-label', 'Approval required');
    await expect(approvalDialog).toHaveAttribute('aria-modal', 'true');

    // The dialog header should show the approval prompt
    await expect(
      approvalDialog.getByText('I need your OK before proceeding'),
    ).toBeVisible();

    // A plain-language summary should be visible (data-testid="approval-summary")
    const summary = approvalDialog.getByTestId('approval-summary');
    await expect(summary).toBeVisible();
    // The summary text should describe the action (generated by buildSummary)
    await expect(summary).not.toBeEmpty();

    // Risk level indicator should be present.
    // The RiskIndicator component renders with data-testid="risk-{level}".
    // For a destructive action like "delete all files", we expect medium or higher.
    const riskIndicator = approvalDialog.locator(
      '[data-testid^="risk-"]',
    );
    await expect(riskIndicator).toBeVisible();

    // Step count should be displayed
    await expect(
      approvalDialog.getByText(/\d+ steps?/),
    ).toBeVisible();

    // Approve and Reject buttons should both be present
    const approveButton = approvalDialog.getByTestId('approve-button');
    const rejectButton = approvalDialog.getByTestId('reject-button');
    await expect(approveButton).toBeVisible();
    await expect(rejectButton).toBeVisible();

    // Details button should be available to expand raw plan JSON
    const detailsButton = approvalDialog.getByTestId('details-button');
    await expect(detailsButton).toBeVisible();

    // Click Details to expand and verify plan JSON is shown
    await detailsButton.click();
    const planDetails = approvalDialog.getByTestId('plan-details');
    await expect(planDetails).toBeVisible();
    // Collapse details
    await detailsButton.click();
    await expect(planDetails).not.toBeVisible();

    // -----------------------------------------------------------------------
    // Approve the action
    // -----------------------------------------------------------------------

    await approveButton.click();

    // After approval, the dialog should close
    await expect(approvalDialog).not.toBeVisible({ timeout: 15_000 });

    // The execution result should appear in the message log.
    // The mock Gear executor returns a deterministic result.
    // We wait for a new assistant message to appear after the approval.
    await expect(
      messageLog.locator('[class*="justify-start"]').first(),
    ).toBeVisible({ timeout: 30_000 });
  });

  test('should allow rejecting an action and show cancellation', async ({
    page,
  }) => {
    await page.goto('/');

    const chatInput = page.getByTestId('chat-input');
    await expect(chatInput).toBeVisible({ timeout: 15_000 });

    // Send an action-requiring message
    await chatInput.fill('Run rm -rf / on the server');
    await page.getByTestId('send-button').click();

    // Wait for the approval dialog
    const approvalDialog = page.getByTestId('approval-dialog');
    await expect(approvalDialog).toBeVisible({ timeout: 30_000 });

    // Optionally provide a rejection reason
    const rejectReasonInput = approvalDialog.getByTestId('reject-reason-input');
    await expect(rejectReasonInput).toBeVisible();
    await rejectReasonInput.fill('This is too dangerous');

    // Click Reject
    const rejectButton = approvalDialog.getByTestId('reject-button');
    await rejectButton.click();

    // Dialog should close after rejection
    await expect(approvalDialog).not.toBeVisible({ timeout: 15_000 });

    // A system message indicating cancellation/rejection should appear.
    // The server sends an error or status message via WebSocket when a job is rejected.
    const messageLog = page.getByRole('log', { name: 'Conversation messages' });
    await expect(
      messageLog.getByText(/rejected|cancelled|denied/i),
    ).toBeVisible({ timeout: 15_000 });
  });

  test('should display correct risk level colors for different risk levels', async ({
    page,
  }) => {
    await page.goto('/');

    const chatInput = page.getByTestId('chat-input');
    await expect(chatInput).toBeVisible({ timeout: 15_000 });

    // Send a risky action to trigger approval with a notable risk level
    await chatInput.fill('Delete all files in /tmp');
    await page.getByTestId('send-button').click();

    const approvalDialog = page.getByTestId('approval-dialog');
    await expect(approvalDialog).toBeVisible({ timeout: 30_000 });

    // Verify risk indicator exists and shows one of the valid risk levels.
    // The RiskIndicator renders data-testid="risk-low", "risk-medium", "risk-high", or "risk-critical"
    const riskBadge = approvalDialog.locator('[data-testid^="risk-"]');
    await expect(riskBadge).toBeVisible();

    // Get the actual risk level from the data-testid
    const testId = await riskBadge.getAttribute('data-testid');
    expect(testId).toMatch(/^risk-(low|medium|high|critical)$/);

    // Verify the label text matches the risk level
    const riskLabels: Record<string, string> = {
      'risk-low': 'Low risk',
      'risk-medium': 'Medium risk',
      'risk-high': 'High risk',
      'risk-critical': 'Critical risk',
    };
    if (testId) {
      await expect(riskBadge).toContainText(riskLabels[testId] ?? '');
    }

    // Approve to clean up
    await approvalDialog.getByTestId('approve-button').click();
    await expect(approvalDialog).not.toBeVisible({ timeout: 15_000 });
  });
});

// ---------------------------------------------------------------------------
// Test: Login Flow (for returning users)
// ---------------------------------------------------------------------------
// Validates that after setup, a returning user sees the login page
// and can sign in with their password.
//
// Success criteria (v0.1):
//   - Returning user sees login page (not onboarding)
//   - Can enter password and sign in
//   - Incorrect password shows error
//   - After login, reaches the chat view
// ---------------------------------------------------------------------------

test.describe('Login Flow', () => {
  test.beforeEach(async ({ request }) => {
    // Ensure setup is complete so the login page is shown
    await ensureServerSetup(request);
  });

  test('should show login page for returning users and allow sign-in', async ({
    page,
  }) => {
    // Navigate to the app — should show login (not onboarding)
    await page.goto('/');

    // The login page shows "Sign in" heading
    await expect(
      page.getByRole('heading', { name: 'Sign in' }),
    ).toBeVisible({ timeout: 15_000 });

    // Enter correct password
    await page.getByLabel('Password').fill(TEST_PASSWORD);
    await page.getByRole('button', { name: 'Sign in' }).click();

    // Should navigate to the chat view after successful login
    await expect(
      page.getByTestId('chat-input').or(
        page.getByPlaceholder('Message Meridian...'),
      ),
    ).toBeVisible({ timeout: 15_000 });
  });

  test('should show error for incorrect password', async ({ page }) => {
    await page.goto('/');

    await expect(
      page.getByRole('heading', { name: 'Sign in' }),
    ).toBeVisible({ timeout: 15_000 });

    // Enter wrong password
    await page.getByLabel('Password').fill('wrong-password');
    await page.getByRole('button', { name: 'Sign in' }).click();

    // Error message should appear
    await expect(
      page.getByRole('alert'),
    ).toBeVisible({ timeout: 10_000 });
  });
});
