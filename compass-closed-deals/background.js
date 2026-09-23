/* ============================================
   Deal - CLOSED DEALS | BACKGROUND SERVICE WORKER
   Orchestrates the automation: tab management,
   message routing, auto-save, and human-like pacing.
   ============================================ */

/* ===== STATE ===== */
let session = null;
let isPaused = false;
let isStopped = false;
let activeTabId = null;

/* ===== MESSAGE HANDLER ===== */
chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  // Ignore messages from content scripts reporting status (those are tab-level)
  if (sender.tab) return false;

  switch (message.action) {
    case 'startAutomation':
      session = {
        state: 'RUNNING',
        records: message.records,
        logs: []
      };
      isPaused = false;
      isStopped = false;
      saveSession();
      runAutomation();
      sendResponse({ success: true });
      break;

    case 'pauseAutomation':
      isPaused = true;
      if (session) session.state = 'PAUSED';
      saveSession();
      addLog('warning', '⏸ Automation paused');
      sendResponse({ success: true });
      break;

    case 'resumeAutomation':
      isPaused = false;
      if (session) session.state = 'RUNNING';
      saveSession();
      addLog('info', '▶ Automation resumed');
      sendResponse({ success: true });
      break;

    case 'stopAutomation':
      isStopped = true;
      if (session) session.state = 'STOPPED';
      saveSession();
      sendResponse({ success: true });
      break;

    case 'getState':
      sendResponse({ session });
      break;

    case 'clearSession':
      session = null;
      isPaused = false;
      isStopped = false;
      chrome.storage.local.remove('session');
      sendResponse({ success: true });
      break;
  }
  return true;
});

/* ===== KEEP-ALIVE ===== */
chrome.alarms.create('keepAlive', { periodInMinutes: 0.4 });
chrome.alarms.onAlarm.addListener((alarm) => {
  if (alarm.name === 'keepAlive') {
    // Keep service worker alive during automation
    if (session && session.state === 'RUNNING') {
      console.log('[Deal] Keep-alive ping — automation active');
    }
  }
});

/* ===== AUTOMATION ENGINE ===== */
async function runAutomation() {
  const records = session.records;

  // Group records by agent URL (preserve insertion order)
  const agentGroups = [];
  const agentMap = new Map();

  for (let i = 0; i < records.length; i++) {
    const url = records[i].agentUrl;
    if (!agentMap.has(url)) {
      agentMap.set(url, agentGroups.length);
      agentGroups.push({ url, indices: [] });
    }
    agentGroups[agentMap.get(url)].indices.push(i);
  }

  addLog('info', ` Starting automation — ${agentGroups.length} agent${agentGroups.length !== 1 ? 's' : ''} | ${records.length} listing${records.length !== 1 ? 's' : ''}`);

  // Process each agent group
  for (let g = 0; g < agentGroups.length; g++) {
    if (isStopped) break;

    const group = agentGroups[g];
    const agentNum = g + 1;
    const totalAgents = agentGroups.length;

    addLog('info', ` [${agentNum}/${totalAgents}] Opening agent: ${truncateUrl(group.url)}`);
    notifyPopup({ type: 'currentProcessing', agentUrl: group.url, listingId: 'Loading page...' });

    // ---- Open Tab ----
    let tab;
    try {
      tab = await openTab(group.url);
      activeTabId = tab.id;
      await waitForTabComplete(tab.id, 30000);

      // Human-like delay after page load
      await humanDelay(2000, 4000);

    } catch (error) {
      addLog('error', `Failed to open page: ${error.message}`);

      // Mark all listings for this agent as error
      for (const idx of group.indices) {
        updateRecordStatus(idx, 'Error - Page Load Failed');
      }
      await saveSession();
      continue;
    }

    // ---- Process each listing ID for this agent ----
    for (let l = 0; l < group.indices.length; l++) {
      if (isStopped) break;

      // Wait while paused
      while (isPaused && !isStopped) {
        await sleep(500);
      }
      if (isStopped) break;

      const recordIndex = group.indices[l];
      const record = records[recordIndex];
      const listingNum = l + 1;
      const totalListings = group.indices.length;

      // Update current processing indicator
      notifyPopup({
        type: 'currentProcessing',
        agentUrl: group.url,
        listingId: `${record.listingId}  (${listingNum}/${totalListings})`
      });

      // Mark as processing
      updateRecordStatus(recordIndex, 'Processing');
      addLog('info', ` [${listingNum}/${totalListings}] Processing: ${record.listingId}`);

      // Send command to content script
      try {
        const result = await sendMessageToTab(tab.id, {
          action: 'addListingId',
          listingId: record.listingId
        });

        const status = result?.status || 'Error - No Response';
        updateRecordStatus(recordIndex, status);

        const icon = getStatusIcon(status);
        const level = getStatusLevel(status);
        addLog(level, `${icon} ${status}: ${record.listingId}`);

      } catch (error) {
        const errorMsg = error.message || 'Unknown error';
        updateRecordStatus(recordIndex, `Error - ${errorMsg}`);
        addLog('error', `Error: ${record.listingId} — ${errorMsg}`);
      }

      // Auto-save after every listing
      await saveSession();

      // Human-like delay before next listing (skip if last)
      if (l < group.indices.length - 1 && !isStopped) {
        await humanDelay(2000, 4000);
      }
    }

    // ---- Close tab ----
    try {
      if (tab) {
        await chrome.tabs.remove(tab.id);
      }
    } catch (e) {
      // Tab might already be closed by the user
    }
    activeTabId = null;

    addLog('info', `[${agentNum}/${totalAgents}] Agent complete — tab closed`);

    // Delay before opening next agent's tab
    if (g < agentGroups.length - 1 && !isStopped) {
      session.state = 'PAUSED_FOR_NEXT_AGENT';
      isPaused = false; // Ensure normal pause flag is false
      saveSession();
      addLog('warning', '⏸ Paused at agent boundary. Click "Run Next Agent" to continue.');
      notifyPopup({ type: 'stateChange', state: 'PAUSED_FOR_NEXT_AGENT' });

      while (session.state === 'PAUSED_FOR_NEXT_AGENT' && !isStopped) {
        await sleep(500);
      }
    }
  }

  // ---- Finalize ----
  if (!isStopped) {
    session.state = 'COMPLETED';
    addLog('info', ' All done! All records have been processed.');
    notifyPopup({ type: 'stateChange', state: 'COMPLETED' });
  } else {
    session.state = 'STOPPED';
    notifyPopup({ type: 'stateChange', state: 'STOPPED' });
  }

  await saveSession();
}

/* ===== TAB MANAGEMENT ===== */
function openTab(url) {
  return new Promise((resolve, reject) => {
    try {
      chrome.tabs.create({ url, active: true }, (tab) => {
        if (chrome.runtime.lastError) {
          reject(new Error(chrome.runtime.lastError.message));
        } else {
          resolve(tab);
        }
      });
    } catch (e) {
      reject(e);
    }
  });
}

function waitForTabComplete(tabId, timeout = 30000) {
  return new Promise((resolve, reject) => {
    let resolved = false;

    const timer = setTimeout(() => {
      if (!resolved) {
        resolved = true;
        chrome.tabs.onUpdated.removeListener(listener);
        reject(new Error('Page load timeout (30s)'));
      }
    }, timeout);

    const listener = (id, changeInfo) => {
      if (id === tabId && changeInfo.status === 'complete' && !resolved) {
        resolved = true;
        clearTimeout(timer);
        chrome.tabs.onUpdated.removeListener(listener);
        resolve();
      }
    };

    chrome.tabs.onUpdated.addListener(listener);

    // Check if already complete
    chrome.tabs.get(tabId, (tab) => {
      if (!chrome.runtime.lastError && tab && tab.status === 'complete' && !resolved) {
        resolved = true;
        clearTimeout(timer);
        chrome.tabs.onUpdated.removeListener(listener);
        resolve();
      }
    });
  });
}

async function sendMessageToTab(tabId, message, maxRetries = 3) {
  for (let attempt = 1; attempt <= maxRetries; attempt++) {
    try {
      const response = await chrome.tabs.sendMessage(tabId, message);
      return response;
    } catch (error) {
      if (attempt < maxRetries) {
        console.log(`[] Retry ${attempt}/${maxRetries} — waiting before retry...`);
        await sleep(2000);
      } else {
        throw new Error(`Content script unreachable after ${maxRetries} attempts`);
      }
    }
  }
}

/* ===== STATUS & LOGGING ===== */
function updateRecordStatus(index, status) {
  if (!session || !session.records[index]) return;
  session.records[index].status = status;
  notifyPopup({ type: 'statusUpdate', recordIndex: index, status });
}

function addLog(level, message) {
  const now = new Date();
  const time = now.toTimeString().substring(0, 8);
  const log = { time, message, level };

  if (session) {
    // Keep logs capped at 500 entries to prevent storage bloat
    if (session.logs.length >= 500) {
      session.logs = session.logs.slice(-400);
    }
    session.logs.push(log);
  }

  notifyPopup({ type: 'logEntry', log });
}

function notifyPopup(message) {
  try {
    chrome.runtime.sendMessage(message).catch(() => {
      // Popup is closed — message not delivered. State is in storage.
    });
  } catch (e) {
    // Ignore — popup is not open
  }
}

/* ===== PERSISTENCE ===== */
async function saveSession() {
  if (session) {
    try {
      await chrome.storage.local.set({ session });
    } catch (e) {
      console.error('[Deal] Failed to save session:', e);
    }
  }
}

// On startup, check for interrupted session
chrome.runtime.onStartup?.addListener(async () => {
  const data = await chrome.storage.local.get('session');
  if (data.session && data.session.state === 'RUNNING') {
    // Session was interrupted (browser closed while running)
    data.session.state = 'STOPPED';
    await chrome.storage.local.set({ session: data.session });
    console.log('[Deal] Interrupted session marked as stopped');
  }
});

/* ===== UTILITY FUNCTIONS ===== */
function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function humanDelay(min, max) {
  const delay = Math.floor(Math.random() * (max - min + 1)) + min;
  return sleep(delay);
}

function truncateUrl(url) {
  if (!url) return '—';
  const match = url.match(/agent-profile-editor\/([a-f0-9]+)\//);
  if (match) {
    const id = match[1];
    const shortId = id.length > 12 ? id.substring(0, 6) + '...' + id.substring(id.length - 4) : id;
    return `.../${shortId}/edit`;
  }
  return url.length > 45 ? url.substring(0, 22) + '...' + url.substring(url.length - 15) : url;
}

function getStatusIcon(status) {
  switch (status) {
    case 'Added By Listing ID': return '✅';
    case 'Already Exists': return '🟡';
    case 'Invalid Listing ID': return '🔴';
    case 'Processing': return '⏳';
    default: return '⚠️';
  }
}

function getStatusLevel(status) {
  switch (status) {
    case 'Added By Listing ID': return 'success';
    case 'Already Exists': return 'warning';
    case 'Invalid Listing ID': return 'error';
    case 'Processing': return 'info';
    default: return 'error';
  }
}
