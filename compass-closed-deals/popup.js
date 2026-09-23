/* ============================================
   CLOSED DEALS | POPUP LOGIC
   Handles file import, UI updates, controls,
   message passing, session recovery, and export.
   ============================================ */

/* ===== STATE ===== */
let records = [];
let logs = [];
let automationState = 'IDLE'; // IDLE, RUNNING, PAUSED, COMPLETED, STOPPED
let stats = { total: 0, added: 0, exists: 0, invalid: 0, queue: 0, error: 0 };

/* ===== DOM CACHE ===== */
const el = {};

/* ===== INIT ===== */
document.addEventListener('DOMContentLoaded', init);

async function init() {
  cacheElements();
  if (el.headerVersion) {
    const manifestData = chrome.runtime.getManifest();
    el.headerVersion.textContent = 'v' + manifestData.version;
  }
  setupEventListeners();
  setupMessageListener();
  await checkExistingSession();
}

function cacheElements() {
  el.btnDownloadTemplate = document.getElementById('btn-download-template');
  el.headerVersion = document.getElementById('header-version');
  // Screens
  el.screenImport = document.getElementById('screen-import');
  el.screenProgress = document.getElementById('screen-progress');
  el.screenDashboard = document.getElementById('screen-dashboard');

  // Import
  el.uploadArea = document.getElementById('upload-area');
  el.fileInput = document.getElementById('file-input');
  el.fileInfo = document.getElementById('file-info');
  el.fileName = document.getElementById('file-name');
  el.fileSize = document.getElementById('file-size');
  el.fileRemove = document.getElementById('file-remove');
  el.previewSection = document.getElementById('preview-section');
  el.previewAgents = document.getElementById('preview-agents');
  el.previewListings = document.getElementById('preview-listings');
  el.previewTbody = document.getElementById('preview-tbody');
  el.btnStart = document.getElementById('btn-start');

  // Progress
  el.statTotal = document.getElementById('stat-total');
  el.statAdded = document.getElementById('stat-added');
  el.statExists = document.getElementById('stat-exists');
  el.statInvalid = document.getElementById('stat-invalid');
  el.statQueue = document.getElementById('stat-queue');
  el.progressFill = document.getElementById('progress-fill');
  el.progressText = document.getElementById('progress-text');
  el.processingAgent = document.getElementById('processing-agent');
  el.processingListing = document.getElementById('processing-listing');
  el.btnPause = document.getElementById('btn-pause');
  el.btnResume = document.getElementById('btn-resume');
  el.btnNextAgent = document.getElementById('btn-next-agent');
  el.btnStop = document.getElementById('btn-stop');
  el.btnExportProgress = document.getElementById('btn-export-progress');
  el.logsContainer = document.getElementById('logs-container');
  el.logIndicator = document.getElementById('log-indicator');

  // Dashboard
  el.dashTotal = document.getElementById('dash-total');
  el.dashAdded = document.getElementById('dash-added');
  el.dashExists = document.getElementById('dash-exists');
  el.dashInvalid = document.getElementById('dash-invalid');
  el.dashError = document.getElementById('dash-error');
  el.heroSubtitle = document.getElementById('hero-subtitle');
  el.btnExportFinal = document.getElementById('btn-export-final');
  el.btnCopyData = document.getElementById('btn-copy-data');
  el.btnNewSession = document.getElementById('btn-new-session');
}

/* ===== EVENT LISTENERS ===== */
function setupEventListeners() {
  if (el.btnDownloadTemplate) {
    el.btnDownloadTemplate.addEventListener('click', downloadTemplate);
  }

  // File upload — click
  el.uploadArea.addEventListener('click', () => el.fileInput.click());
  el.fileInput.addEventListener('change', (e) => {
    if (e.target.files[0]) handleFile(e.target.files[0]);
  });

  // File upload — drag & drop
  el.uploadArea.addEventListener('dragover', (e) => {
    e.preventDefault();
    el.uploadArea.classList.add('drag-over');
  });
  el.uploadArea.addEventListener('dragleave', () => {
    el.uploadArea.classList.remove('drag-over');
  });
  el.uploadArea.addEventListener('drop', (e) => {
    e.preventDefault();
    el.uploadArea.classList.remove('drag-over');
    if (e.dataTransfer.files[0]) handleFile(e.dataTransfer.files[0]);
  });

  // File remove
  el.fileRemove.addEventListener('click', (e) => {
    e.stopPropagation();
    clearFile();
  });

  // Controls
  el.btnStart.addEventListener('click', startProcessing);
  el.btnPause.addEventListener('click', pauseProcessing);
  el.btnResume.addEventListener('click', resumeProcessing);
  el.btnNextAgent.addEventListener('click', resumeProcessing);
  el.btnStop.addEventListener('click', stopProcessing);
  el.btnExportProgress.addEventListener('click', exportResults);
  el.btnExportFinal.addEventListener('click', exportResults);
  el.btnCopyData.addEventListener('click', copyResultsToClipboard);
  el.btnNewSession.addEventListener('click', newSession);
}

/* ===== MESSAGE LISTENER ===== */
function setupMessageListener() {
  chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
    handleBackgroundMessage(message);
  });
}

/* ===== SESSION RECOVERY ===== */
async function checkExistingSession() {
  try {
    const data = await chrome.storage.local.get('session');
    if (data.session && data.session.state !== 'IDLE') {
      restoreSession(data.session);
    }
  } catch (e) {
    console.error('[Deal] Failed to check session:', e);
  }
}

function restoreSession(session) {
  records = session.records || [];
  logs = session.logs || [];
  automationState = session.state;

  // Recalculate stats from records
  recalcStats();

  if (automationState === 'COMPLETED' || automationState === 'STOPPED') {
    showDashboard();
  } else {
    // RUNNING or PAUSED
    showScreen('screen-progress');
    updateStatsUI();
    updateProgressBar();

    // Restore log entries
    el.logsContainer.innerHTML = '';
    logs.forEach((log) => appendLogDOM(log));
    scrollLogsToBottom();

    // Update button states
    if (automationState === 'PAUSED') {
      el.btnPause.classList.add('hidden');
      el.btnResume.classList.remove('hidden');
      el.btnNextAgent.classList.add('hidden');
      el.logIndicator.classList.add('paused');
    } else if (automationState === 'PAUSED_FOR_NEXT_AGENT') {
      el.btnPause.classList.add('hidden');
      el.btnResume.classList.add('hidden');
      el.btnNextAgent.classList.remove('hidden');
      el.logIndicator.classList.add('paused');
    }
  }
}

/* ===== FILE HANDLING ===== */
function handleFile(file) {
  const validTypes = [
    'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
    'application/vnd.ms-excel',
    'text/csv'
  ];

  const ext = file.name.split('.').pop().toLowerCase();
  if (!['xlsx', 'xls', 'csv'].includes(ext)) {
    showToast('Please upload an Excel file (.xlsx, .xls) or CSV file.');
    return;
  }

  // Show file info
  el.fileName.textContent = file.name;
  el.fileSize.textContent = formatFileSize(file.size);
  el.fileInfo.classList.remove('hidden');

  // Parse file
  const reader = new FileReader();
  reader.onload = (e) => {
    try {
      const data = new Uint8Array(e.target.result);
      const workbook = XLSX.read(data, { type: 'array' });
      const sheet = workbook.Sheets[workbook.SheetNames[0]];
      const rows = XLSX.utils.sheet_to_json(sheet, { header: 1 });

      parseRecords(rows);
    } catch (error) {
      showToast('Error parsing file: ' + error.message);
      clearFile();
    }
  };
  reader.readAsArrayBuffer(file);
}

function parseRecords(rows) {
  records = [];

  // Find header row — look for a row containing "Agent" and "Listing"
  let startIdx = 0;
  for (let i = 0; i < Math.min(rows.length, 5); i++) {
    const row = rows[i];
    if (row && row.length >= 2) {
      const col0 = String(row[0] || '').toLowerCase();
      const col1 = String(row[1] || '').toLowerCase();
      if (col0.includes('agent') || col1.includes('listing')) {
        startIdx = i + 1; // Skip header
        break;
      }
    }
  }

  // If no header found, assume first row is data
  if (startIdx === 0 && rows.length > 0) {
    const firstRow = rows[0];
    if (firstRow && String(firstRow[0] || '').startsWith('http')) {
      startIdx = 0;
    } else {
      startIdx = 1; // Assume first row is header
    }
  }

  // Parse data rows
  for (let i = startIdx; i < rows.length; i++) {
    const row = rows[i];
    if (!row || row.length < 2) continue;

    const agentUrl = String(row[0] || '').trim();
    const listingId = String(row[1] || '').trim();

    if (!agentUrl || !listingId) continue;

    records.push({
      index: records.length,
      agentUrl,
      listingId,
      status: 'In Queue'
    });
  }

  if (records.length === 0) {
    showToast('No valid records found. Ensure the file has Agent URLs and Listing IDs.');
    clearFile();
    return;
  }

  // Calculate stats
  const uniqueAgents = new Set(records.map((r) => r.agentUrl)).size;

  // Update preview badges
  el.previewAgents.textContent = `${uniqueAgents} Agent${uniqueAgents !== 1 ? 's' : ''}`;
  el.previewListings.textContent = `${records.length} Listing${records.length !== 1 ? 's' : ''}`;

  // Populate preview table (show first 100 rows max)
  el.previewTbody.innerHTML = '';
  const displayRecords = records.slice(0, 100);
  displayRecords.forEach((r, idx) => {
    const tr = document.createElement('tr');
    tr.innerHTML = `
      <td>${idx + 1}</td>
      <td title="${escapeHtml(r.agentUrl)}">${escapeHtml(truncateUrl(r.agentUrl))}</td>
      <td class="cell-mono">${escapeHtml(r.listingId)}</td>
    `;
    el.previewTbody.appendChild(tr);
  });

  if (records.length > 100) {
    const tr = document.createElement('tr');
    tr.innerHTML = `<td colspan="3" style="text-align:center;color:var(--text-muted);">... and ${records.length - 100} more rows</td>`;
    el.previewTbody.appendChild(tr);
  }

  // Show preview section
  el.previewSection.classList.remove('hidden');
}

function clearFile() {
  el.fileInput.value = '';
  el.fileInfo.classList.add('hidden');
  el.previewSection.classList.add('hidden');
  records = [];
}

/* ===== AUTOMATION CONTROLS ===== */
async function startProcessing() {
  if (records.length === 0) return;

  automationState = 'RUNNING';
  stats = {
    total: records.length,
    added: 0,
    exists: 0,
    invalid: 0,
    queue: records.length,
    error: 0
  };
  logs = [];

  // Switch to progress screen first
  showScreen('screen-progress');
  updateStatsUI();
  updateProgressBar();

  // Clear logs
  el.logsContainer.innerHTML = '';
  el.logIndicator.className = 'log-indicator';

  // Add initial log
  const uniqueAgents = new Set(records.map((r) => r.agentUrl)).size;
  addLogEntry('info', `📂 Loaded ${records.length} records | ${uniqueAgents} unique agent${uniqueAgents !== 1 ? 's' : ''}`);

  // Send to background
  try {
    await chrome.runtime.sendMessage({
      action: 'startAutomation',
      records: records
    });
  } catch (error) {
    addLogEntry('error', `🔴 Failed to start automation: ${error.message}`);
  }
}

function pauseProcessing() {
  chrome.runtime.sendMessage({ action: 'pauseAutomation' });
  automationState = 'PAUSED';
  el.btnPause.classList.add('hidden');
  el.btnResume.classList.remove('hidden');
  el.logIndicator.classList.add('paused');
  addLogEntry('warning', '⏸ Automation paused by user');
}

function resumeProcessing() {
  chrome.runtime.sendMessage({ action: 'resumeAutomation' });
  automationState = 'RUNNING';
  el.btnResume.classList.add('hidden');
  el.btnNextAgent.classList.add('hidden');
  el.btnPause.classList.remove('hidden');
  el.logIndicator.classList.remove('paused');
  addLogEntry('info', '▶ Automation resumed');
}

function stopProcessing() {
  if (!confirm('Stop processing? Remaining items will stay as "In Queue".\n\nYou can still export current progress.')) {
    return;
  }
  chrome.runtime.sendMessage({ action: 'stopAutomation' });
  automationState = 'STOPPED';
  el.logIndicator.classList.add('stopped');
  addLogEntry('error', '⏹ Automation stopped by user');

  // Short delay then show dashboard
  setTimeout(() => showDashboard(), 800);
}

async function newSession() {
  if (!confirm('Start a new session?\n\nMake sure you\'ve exported the results first!')) {
    return;
  }

  await chrome.storage.local.remove('session');
  records = [];
  logs = [];
  automationState = 'IDLE';
  stats = { total: 0, added: 0, exists: 0, invalid: 0, queue: 0, error: 0 };

  // Reset UI
  showScreen('screen-import');
  el.previewSection.classList.add('hidden');
  el.fileInfo.classList.add('hidden');
  el.fileInput.value = '';
  el.logsContainer.innerHTML = '<div class="log-empty">Waiting to start...</div>';
  el.logIndicator.className = 'log-indicator';
  el.btnPause.classList.remove('hidden');
  el.btnResume.classList.add('hidden');
  el.btnNextAgent.classList.add('hidden');
}

/* ===== UI UPDATE FUNCTIONS ===== */
function showScreen(screenId) {
  document.querySelectorAll('.screen').forEach((s) => s.classList.remove('active'));
  document.getElementById(screenId).classList.add('active');
}

function recalcStats() {
  stats = { total: records.length, added: 0, exists: 0, invalid: 0, queue: 0, error: 0 };
  records.forEach((r) => {
    switch (r.status) {
      case 'Added By Listing ID': stats.added++; break;
      case 'Already Exists': stats.exists++; break;
      case 'Invalid Listing ID': stats.invalid++; break;
      case 'In Queue': case 'Processing': stats.queue++; break;
      default:
        if (r.status.startsWith('Error')) stats.error++;
        else stats.queue++;
        break;
    }
  });
}

function updateStatsUI() {
  el.statTotal.textContent = stats.total;
  el.statAdded.textContent = stats.added;
  el.statExists.textContent = stats.exists;
  el.statInvalid.textContent = stats.invalid;
  el.statQueue.textContent = stats.queue;
}

function updateProgressBar() {
  const processed = stats.total - stats.queue;
  const percent = stats.total > 0 ? Math.round((processed / stats.total) * 100) : 0;
  el.progressFill.style.width = `${percent}%`;
  el.progressText.textContent = `${percent}%`;
}

function addLogEntry(level, message) {
  const now = new Date();
  const time = now.toTimeString().substring(0, 8);
  const log = { time, message, level };
  logs.push(log);
  appendLogDOM(log);
  scrollLogsToBottom();
}

function appendLogDOM(log) {
  // Remove "waiting" placeholder
  const empty = el.logsContainer.querySelector('.log-empty');
  if (empty) empty.remove();

  const entry = document.createElement('div');
  entry.className = `log-entry log-${log.level}`;
  entry.innerHTML = `<span class="log-time">[${log.time}]</span><span class="log-msg">${escapeHtml(log.message)}</span>`;
  el.logsContainer.appendChild(entry);
}

function scrollLogsToBottom() {
  el.logsContainer.scrollTop = el.logsContainer.scrollHeight;
}

function updateCurrentProcessing(agentUrl, listingId) {
  el.processingAgent.textContent = truncateUrl(agentUrl);
  el.processingAgent.title = agentUrl;
  el.processingListing.textContent = listingId || '—';
}

function showDashboard() {
  recalcStats();

  el.dashTotal.textContent = stats.total;
  el.dashAdded.textContent = stats.added;
  el.dashExists.textContent = stats.exists;
  el.dashInvalid.textContent = stats.invalid;
  el.dashError.textContent = stats.error;

  if (automationState === 'STOPPED') {
    el.heroSubtitle.textContent = `Stopped — ${stats.queue} items still in queue`;
  } else {
    el.heroSubtitle.textContent = `All ${stats.total} records have been processed`;
  }

  showScreen('screen-dashboard');
}

/* ===== MESSAGE HANDLER ===== */
function handleBackgroundMessage(message) {
  switch (message.type) {
    case 'statusUpdate':
      handleStatusUpdate(message);
      break;

    case 'logEntry':
      addLogEntry(message.log.level, message.log.message);
      break;

    case 'stateChange':
      handleStateChange(message.state);
      break;

    case 'currentProcessing':
      updateCurrentProcessing(message.agentUrl, message.listingId);
      break;

    case 'recordsSync':
      // Full records sync from background
      if (message.records) {
        records = message.records;
        recalcStats();
        updateStatsUI();
        updateProgressBar();
      }
      break;
  }
}

function handleStatusUpdate(msg) {
  const record = records[msg.recordIndex];
  if (!record) return;

  // Decrement old status counter
  const oldStatus = record.status;
  if (oldStatus === 'In Queue' || oldStatus === 'Processing') stats.queue--;
  else if (oldStatus === 'Added By Listing ID') stats.added--;
  else if (oldStatus === 'Already Exists') stats.exists--;
  else if (oldStatus === 'Invalid Listing ID') stats.invalid--;
  else if (oldStatus.startsWith('Error')) stats.error--;

  // Update record
  record.status = msg.status;

  // Increment new status counter
  switch (msg.status) {
    case 'Added By Listing ID': stats.added++; break;
    case 'Already Exists': stats.exists++; break;
    case 'Invalid Listing ID': stats.invalid++; break;
    case 'In Queue': case 'Processing': stats.queue++; break;
    default:
      if (msg.status.startsWith('Error')) stats.error++;
      else stats.queue++;
      break;
  }

  updateStatsUI();
  updateProgressBar();
}

function handleStateChange(state) {
  automationState = state;

  if (state === 'COMPLETED') {
    el.logIndicator.classList.add('stopped');
    el.logIndicator.style.background = 'var(--clr-added)';
    addLogEntry('info', '🎉 All records have been processed!');
    setTimeout(() => showDashboard(), 1200);
  } else if (state === 'STOPPED') {
    el.logIndicator.classList.add('stopped');
    addLogEntry('error', '⏹ Automation stopped');
    setTimeout(() => showDashboard(), 800);
  } else if (state === 'PAUSED_FOR_NEXT_AGENT') {
    el.btnPause.classList.add('hidden');
    el.btnResume.classList.add('hidden');
    el.btnNextAgent.classList.remove('hidden');
    el.logIndicator.classList.add('paused');
  }
}

/* ===== EXPORT ===== */
function exportResults() {
  if (records.length === 0) {
    showToast('No records to export.');
    return;
  }

  const exportData = records.map((r) => ({
    'Agent Profile Link': r.agentUrl,
    'Listing IDs': r.listingId,
    'Status': r.status
  }));

  const ws = XLSX.utils.json_to_sheet(exportData);
  const wb = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(wb, ws, 'Results');

  // Set column widths
  ws['!cols'] = [
    { wch: 65 },  // Agent Profile Link
    { wch: 25 },  // Listing IDs
    { wch: 25 }   // Status
  ];

  const wbout = XLSX.write(wb, { bookType: 'xlsx', type: 'array' });
  const blob = new Blob([wbout], { type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' });
  const url = URL.createObjectURL(blob);

  const a = document.createElement('a');
  a.href = url;
  a.download = `Deals_Closed_${formatDateForFile()}.xlsx`;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  URL.revokeObjectURL(url);

  addLogEntry('info', '📥 Results exported successfully');
}

function copyResultsToClipboard() {
  if (records.length === 0) {
    showToast('No records to copy.');
    return;
  }

  const header = ['Agent Profile Link', 'Listing IDs', 'Status'].join('\t');
  const rows = records.map((r) => [r.agentUrl, r.listingId, r.status].join('\t'));
  const tsv = [header, ...rows].join('\n');

  navigator.clipboard.writeText(tsv).then(() => {
    addLogEntry('info', '📋 Data copied to clipboard');
    showToast('Data copied to clipboard!');
  }).catch((err) => {
    addLogEntry('error', '🔴 Failed to copy data: ' + err.message);
    showToast('Failed to copy data.');
  });
}

function downloadTemplate() {
  const exportData = [];
  // Create 1000 empty rows so Excel retains the format for them
  for (let i = 0; i < 1000; i++) {
    exportData.push({
      'Agent Profile Link': '',
      'Listing IDs': ''
    });
  }

  const ws = XLSX.utils.json_to_sheet(exportData);

  // Force 'Text' format (@) for the Listing IDs column (Column B, index 1)
  for (let r = 1; r <= 1000; r++) {
    const cellRef = XLSX.utils.encode_cell({ c: 1, r: r });
    if (!ws[cellRef]) ws[cellRef] = { t: 's', v: '' };
    ws[cellRef].z = '@';
  }

  const wb = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(wb, ws, 'Template');

  // Set column widths
  ws['!cols'] = [
    { wch: 65 },  // Agent Profile Link
    { wch: 25 }   // Listing IDs
  ];

  const wbout = XLSX.write(wb, { bookType: 'xlsx', type: 'array' });
  const blob = new Blob([wbout], { type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' });
  const url = URL.createObjectURL(blob);

  const a = document.createElement('a');
  a.href = url;
  a.download = `Deals_Template.xlsx`;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  URL.revokeObjectURL(url);
}

/* ===== UTILITY FUNCTIONS ===== */
function truncateUrl(url) {
  if (!url) return '—';
  if (url.length <= 50) return url;

  // Extract the agent ID from the URL
  const match = url.match(/agent-profile-editor\/([a-f0-9]+)\//);
  if (match) {
    const id = match[1];
    const shortId = id.length > 12 ? id.substring(0, 6) + '...' + id.substring(id.length - 4) : id;
    return `.../${shortId}/edit`;
  }

  return url.substring(0, 25) + '...' + url.substring(url.length - 15);
}

function escapeHtml(str) {
  const div = document.createElement('div');
  div.textContent = str;
  return div.innerHTML;
}

function formatFileSize(bytes) {
  if (bytes < 1024) return bytes + ' B';
  if (bytes < 1024 * 1024) return (bytes / 1024).toFixed(1) + ' KB';
  return (bytes / (1024 * 1024)).toFixed(1) + ' MB';
}

function formatDateForFile() {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}_${String(d.getHours()).padStart(2, '0')}${String(d.getMinutes()).padStart(2, '0')}`;
}

function showToast(message) {
  // Simple alert fallback for popup
  alert(message);
}
