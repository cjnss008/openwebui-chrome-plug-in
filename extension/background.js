const openStateByTab = new Map();

async function openPanelForTab(tab) {
  if (!tab || tab.id === undefined) {
    return false;
  }
  try {
    await chrome.sidePanel.setOptions({ tabId: tab.id, path: 'sidebar.html', enabled: true });
  } catch (err) {
    console.error('sidePanel.setOptions failed', err);
  }

  if (typeof chrome.sidePanel?.open === 'function') {
    const attempts = [];
    attempts.push({ tabId: tab.id });
    if (tab.windowId !== undefined) {
      attempts.push({ windowId: tab.windowId });
    }
    attempts.push({});
    for (const args of attempts) {
      try {
        await chrome.sidePanel.open(args);
        return true;
      } catch (err) {
        console.warn('sidePanel.open failed', err, args);
      }
    }
  }

  if (typeof chrome.sidePanel?.setPanelBehavior === 'function') {
    try {
      await chrome.sidePanel.setPanelBehavior({ openPanelOnActionClick: true });
    } catch (err) {
      console.warn('setPanelBehavior failed', err);
    }
  }
  return false;
}

async function closePanelForTab(tabId) {
  try {
    await chrome.sidePanel.setOptions({ tabId, enabled: false });
  } catch (err) {
    console.error('sidePanel.setOptions disable failed', err);
  }
}

async function togglePanel() {
  const [tab] = await chrome.tabs.query({ active: true, lastFocusedWindow: true });
  if (!tab || tab.id === undefined) {
    return;
  }
  const key = String(tab.id);
  const isOpen = openStateByTab.get(key) === true;
  if (isOpen) {
    await closePanelForTab(tab.id);
    openStateByTab.set(key, false);
    return;
  }
  const opened = await openPanelForTab(tab);
  if (opened) {
    openStateByTab.set(key, true);
  }
}

chrome.runtime.onInstalled.addListener(() => {
  if (typeof chrome.sidePanel?.setPanelBehavior === 'function') {
    chrome.sidePanel
      .setPanelBehavior({ openPanelOnActionClick: false })
      .catch((err) => console.warn('setPanelBehavior(init) failed', err));
  }
});

chrome.action.onClicked.addListener(() => {
  togglePanel().catch((err) => console.error('togglePanel failed', err));
});

chrome.runtime.onMessage.addListener((msg, sender) => {
  if (!msg) return;
  if (msg.type === 'panel-state' && sender.tab && sender.tab.id !== undefined) {
    openStateByTab.set(String(sender.tab.id), msg.isOpen === true);
  }
  if (msg.type === 'close-panel' && msg.tabId !== undefined) {
    closePanelForTab(msg.tabId).catch((err) => console.error('closePanelForTab failed', err));
    openStateByTab.set(String(msg.tabId), false);
  }
  if (msg.type === 'open-panel') {
    chrome.tabs.query({ active: true, lastFocusedWindow: true }).then((tabs) => {
      const tab = tabs[0];
      openPanelForTab(tab)
        .then((ok) => {
          if (ok && tab && tab.id !== undefined) {
            openStateByTab.set(String(tab.id), true);
          }
        })
        .catch((err) => console.error('openPanelForTab(msg) failed', err));
    });
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
