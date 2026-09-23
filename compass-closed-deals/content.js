/* ============================================
  CLOSED DEALS | CONTENT SCRIPT
   Injected into agent profile pages.
   Handles DOM automation with human-like behavior:
   smooth scrolling, character-by-character typing,
   and outcome detection via MutationObserver.
   ============================================ */

/* ===== MESSAGE HANDLER ===== */
chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (message.action === 'addListingId') {
    handleAddListingId(message.listingId)
      .then((result) => sendResponse(result))
      .catch((error) => sendResponse({ status: `Error - ${error.message}` }));
    return true; // Keep message channel open for async response
  }
});

/* ===== MAIN AUTOMATION FUNCTION ===== */
async function handleAddListingId(listingId) {
  try {
    // Step 1: Wait for and find the input field
    let input = await waitForElement(
      'input.js-addClosedDealByListingIdSHA',
      15000
    );

    // Step 2: Smooth-scroll to the input section (human-like)
    const section = input.closest('.layout-column')?.parentElement || input;
    section.scrollIntoView({ behavior: 'smooth', block: 'center' });
    await humanDelay(600, 1200);

    // Step 3: Click on the input to focus it (like a human would)
    input.click();
    input.focus();
    await humanDelay(200, 400);

    // Step 4: Clear any existing value in the input
    clearInputField(input);
    await humanDelay(100, 250);

    // Step 5: Paste the listing ID directly into the input (instant fill)
    await pasteDirectly(input, listingId);
    await humanDelay(300, 600);

    // Step 6: Find the ADD button
    const addButton = findAddButton();
    if (!addButton) {
      // Retry after a short wait
      await sleep(2000);
      const retryButton = findAddButton();
      if (!retryButton) {
        return { status: 'Error - ADD Button Not Found' };
      }
    }

    // Step 7: Count existing listing cards BEFORE clicking (for success detection)
    const cardCountBefore = countListingCards();

    // Step 8: Click the ADD button
    const btn = findAddButton();
    btn.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
    await humanDelay(200, 400);
    btn.click();

    // Step 9: Wait and detect the outcome
    const status = await detectOutcome(cardCountBefore);

    // Step 10: Small delay for page to settle before next action
    await humanDelay(400, 800);

    return { status };

  } catch (error) {
    console.error('[Deal Content] Error:', error);
    return { status: `Error - ${error.message}` };
  }
}

/* ===== DOM INTERACTION HELPERS ===== */

/**
 * Wait for an element to appear in the DOM.
 */
function waitForElement(selector, timeout = 10000) {
  return new Promise((resolve, reject) => {
    // Check if already exists
    const existing = document.querySelector(selector);
    if (existing) {
      resolve(existing);
      return;
    }

    let resolved = false;

    const observer = new MutationObserver(() => {
      const el = document.querySelector(selector);
      if (el && !resolved) {
        resolved = true;
        observer.disconnect();
        clearTimeout(timer);
        resolve(el);
      }
    });

    observer.observe(document.body, { childList: true, subtree: true });

    const timer = setTimeout(() => {
      if (!resolved) {
        resolved = true;
        observer.disconnect();
        reject(new Error('Element Not Found'));
      }
    }, timeout);
  });
}

/**
 * Clear input field value using native setter for framework compatibility.
 */
function clearInputField(input) {
  const nativeSetter = Object.getOwnPropertyDescriptor(
    window.HTMLInputElement.prototype,
    'value'
  ).set;

  nativeSetter.call(input, '');
  input.dispatchEvent(new Event('input', { bubbles: true }));
  input.dispatchEvent(new Event('change', { bubbles: true }));
}

/**
 * Paste the listing ID directly into the input field at once.
 * Uses native setter and dispatches input/change events for framework compatibility (React, etc.).
 */
async function pasteDirectly(input, text) {
  input.focus();

  // Dispatch paste event in case the page listens for paste actions
  try {
    const dataTransfer = new DataTransfer();
    dataTransfer.setData('text/plain', text);
    const pasteEvent = new ClipboardEvent('paste', {
      clipboardData: dataTransfer,
      bubbles: true,
      cancelable: true
    });
    input.dispatchEvent(pasteEvent);
  } catch (e) {
    // Fallback if ClipboardEvent construction is restricted
  }

  // Use native prototype setter to ensure React / UI frameworks detect the change
  const nativeSetter = Object.getOwnPropertyDescriptor(
    window.HTMLInputElement.prototype,
    'value'
  )?.set;

  if (nativeSetter) {
    nativeSetter.call(input, text);
  } else {
    input.value = text;
  }

  // Dispatch input & change events
  input.dispatchEvent(new Event('input', { bubbles: true, composed: true }));
  input.dispatchEvent(new Event('change', { bubbles: true, composed: true }));
}

/**
 * Find the ADD button on the page.
 * Uses multiple strategies to locate it reliably.
 */
function findAddButton() {
  // Strategy 1: Walk up from the input field to find the nearest ADD button
  const input = document.querySelector('input.js-addClosedDealByListingIdSHA');
  if (input) {
    let container = input.parentElement;
    for (let depth = 0; depth < 10 && container; depth++) {
      container = container.parentElement;
      if (!container) break;

      const buttons = container.querySelectorAll('button');
      for (const btn of buttons) {
        const text = btn.textContent.trim().toUpperCase();
        if (text === 'ADD') {
          return btn;
        }
      }
    }
  }

  // Strategy 2: Find any button with text "ADD" (not "REMOVE", not "ADD SPOTLIGHT")
  const allButtons = document.querySelectorAll('button');
  for (const btn of allButtons) {
    const text = btn.textContent.trim().toUpperCase();
    if (text === 'ADD') {
      return btn;
    }
  }

  // Strategy 3: Look for button with data-intent near the closed deal section
  const intentButtons = document.querySelectorAll('button[data-intent]');
  for (const btn of intentButtons) {
    const text = btn.textContent.trim().toUpperCase();
    if (text === 'ADD') {
      return btn;
    }
  }

  return null;
}

/**
 * Count the number of existing listing cards (each has a REMOVE button).
 */
function countListingCards() {
  const allButtons = document.querySelectorAll('button');
  let count = 0;
  for (const btn of allButtons) {
    if (btn.textContent.trim().toUpperCase() === 'REMOVE') {
      count++;
    }
  }
  return count;
}

/* ===== OUTCOME DETECTION ===== */

/**
 * Detect the outcome after clicking the ADD button.
 * Watches for:
 *   - Error toasts: "Closed deal already exists" or "Invalid listing data provided"
 *   - Success: A new listing card appears (REMOVE button count increases)
 * Timeout after 10 seconds.
 */
function detectOutcome(cardCountBefore) {
  return new Promise((resolve) => {
    let resolved = false;

    const cleanup = () => {
      resolved = true;
      if (observer) observer.disconnect();
      if (timeoutTimer) clearTimeout(timeoutTimer);
      if (cardCheckInterval) clearInterval(cardCheckInterval);
    };

    // --- MutationObserver for toast/notification detection ---
    const observer = new MutationObserver((mutations) => {
      if (resolved) return;

      for (const mutation of mutations) {
        for (const node of mutation.addedNodes) {
          if (node.nodeType !== Node.ELEMENT_NODE) continue;
          checkForStatusMessage(node, (status) => {
            if (!resolved) {
              cleanup();
              resolve(status);
            }
          });
        }
      }
    });

    observer.observe(document.body, {
      childList: true,
      subtree: true
    });

    // --- Periodic check for new listing cards (success case) ---
    const cardCheckInterval = setInterval(() => {
      if (resolved) return;

      const currentCount = countListingCards();
      if (currentCount > cardCountBefore) {
        cleanup();
        resolve('Added By Listing ID');
      }
    }, 400);

    // --- Timeout fallback ---
    const timeoutTimer = setTimeout(() => {
      if (resolved) return;

      // Final checks before timing out
      const finalCount = countListingCards();
      if (finalCount > cardCountBefore) {
        cleanup();
        resolve('Added By Listing ID');
        return;
      }

      // Check if any error message is visible on the page
      const pageText = document.body.innerText.toLowerCase();
      if (pageText.includes('closed deal already exists')) {
        cleanup();
        resolve('Already Exists');
        return;
      }
      if (pageText.includes('invalid listing data provided')) {
        cleanup();
        resolve('Invalid Listing ID');
        return;
      }

      cleanup();
      resolve('Error - Timeout');
    }, 10000);
  });
}

/**
 * Check a DOM node (and its descendants) for status messages.
 */
function checkForStatusMessage(node, callback) {
  const textContent = (node.textContent || '').toLowerCase();

  // Check for "Already Exists"
  if (textContent.includes('closed deal already exists')) {
    callback('Already Exists');
    return;
  }

  // Check for "Invalid Listing ID"
  if (textContent.includes('invalid listing data provided')) {
    callback('Invalid Listing ID');
    return;
  }

  // Check child elements (in case node is a wrapper)
  if (node.querySelectorAll) {
    const children = node.querySelectorAll('*');
    for (const child of children) {
      const childText = (child.textContent || '').toLowerCase();

      if (childText.includes('closed deal already exists')) {
        callback('Already Exists');
        return;
      }
      if (childText.includes('invalid listing data provided')) {
        callback('Invalid Listing ID');
        return;
      }
    }
  }
}

/* ===== UTILITY FUNCTIONS ===== */

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function humanDelay(min, max) {
  return sleep(randomInt(min, max));
}

function randomInt(min, max) {
  return Math.floor(Math.random() * (max - min + 1)) + min;
}
