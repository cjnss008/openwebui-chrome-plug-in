const openStateByTab = new Map();

async function togglePanel() {
  const [tab] = await chrome.tabs.query({ active: true, lastFocusedWindow: true });
  if (!tab || tab.id === undefined) {
    return;
  }
  const key = String(tab.id);
  const isOpen = openStateByTab.get(key) === true;
  if (!isOpen) {
    await chrome.sidePanel.setOptions({ tabId: tab.id, path: 'sidebar.html', enabled: true });
    await chrome.sidePanel.open({ tabId: tab.id });
    openStateByTab.set(key, true);
  } else {
    await chrome.sidePanel.setOptions({ tabId: tab.id, enabled: false });
    openStateByTab.set(key, false);
  }
}

chrome.action.onClicked.addListener(() => {
  togglePanel().catch((err) => console.error('togglePanel failed', err));
});

chrome.runtime.onMessage.addListener((msg, sender) => {
  if (msg && msg.type === 'panel-state' && sender.tab && sender.tab.id !== undefined) {
    openStateByTab.set(String(sender.tab.id), msg.isOpen === true);
  }
});

if (chrome.sidePanel && chrome.sidePanel.onSessionStateChanged) {
  chrome.sidePanel.onSessionStateChanged.addListener((sessionState) => {
    const { tabId, panelOpen } = sessionState;
    if (tabId !== undefined) {
      openStateByTab.set(String(tabId), panelOpen === true);
    }
  });
}
