export const MAX_TABS = 300;

/** Read the tabs and groups of the window this panel belongs to. */
export async function snapshot({ includePinned = false, limit = MAX_TABS } = {}) {
  const win = await chrome.windows.getCurrent();
  const [all, groupList] = await Promise.all([
    chrome.tabs.query({ windowId: win.id }),
    chrome.tabGroups.query({ windowId: win.id }),
  ]);
  const groups = new Map(groupList.map((g) => [g.id, { id: g.id, title: g.title ?? '', color: g.color, collapsed: Boolean(g.collapsed) }]));
  const eligible = all.filter((t) => includePinned || !t.pinned);
  const tabs = eligible.slice(0, limit).map((t) => ({
    id: t.id,
    index: t.index,
    title: t.title || t.url || 'Untitled',
    url: t.url || t.pendingUrl || '',
    favIconUrl: t.favIconUrl || '',
    pinned: Boolean(t.pinned),
    active: Boolean(t.active),
    audible: Boolean(t.audible),
    groupId: t.groupId ?? -1,
  }));
  return {
    windowId: win.id,
    total: all.length,
    pinnedCount: all.filter((t) => t.pinned).length,
    truncated: eligible.length > limit,
    tabs,
    byId: new Map(tabs.map((t) => [t.id, t])),
    groups,
  };
}

/**
 * Name the model sees for each group. Unnamed groups get a stable label, otherwise
 * their tabs would look ungrouped and could not be ungrouped or closed by name.
 */
export function groupLabels(groups) {
  const labels = new Map();
  let unnamed = 0;
  for (const g of groups.values()) {
    labels.set(g.id, g.title || `Unnamed group ${++unnamed}`);
  }
  return labels;
}

/** The payload sent to the server. Queries and fragments are stripped there too. */
export function toApiTabs(snap) {
  const labels = groupLabels(snap.groups);
  return snap.tabs.map((t) => ({
    id: t.id,
    title: t.title,
    url: t.url,
    group: t.groupId !== -1 ? labels.get(t.groupId) : undefined,
    active: t.active || undefined,
    audible: t.audible || undefined,
  }));
}
