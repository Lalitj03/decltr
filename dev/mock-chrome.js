// A small in-memory model of the chrome.* APIs Decltr uses. It mirrors the
// behaviors that matter: window order, contiguous groups, a window closing when
// its last tab leaves, groups vanishing when empty, and the events Chrome fires
// (including isWindowClosing on tab removal).
// Used by the unit tests and by the browser UI preview (dev/serve.mjs).

const makeEvent = () => {
  const fns = [];
  return {
    addListener: (fn) => fns.push(fn),
    removeListener: (fn) => void fns.splice(fns.indexOf(fn), 1),
    __emit: (...args) => fns.slice().forEach((fn) => fn(...args)),
  };
};

export function createMockChrome({ tabs: seed = [], groups: seedGroups = [], bookmarks: seedBookmarks = true } = {}) {
  let nextTabId = 1000;
  let nextGroupId = 1;
  let nextWindowId = 2;
  let nextBookmarkId = 100;

  const state = { windows: new Set([1]), tabs: [], groups: new Map(), storage: { local: {}, session: {} }, focusedWindow: 1 };
  const ev = {
    tabsCreated: makeEvent(), tabsRemoved: makeEvent(), tabsUpdated: makeEvent(), tabsMoved: makeEvent(),
    tabsAttached: makeEvent(), tabsDetached: makeEvent(),
    groupsCreated: makeEvent(), groupsUpdated: makeEvent(), groupsRemoved: makeEvent(), groupsMoved: makeEvent(),
    windowsRemoved: makeEvent(), storageChanged: makeEvent(),
  };
  // Chrome delivers events after the API call has returned.
  const fire = (event, ...args) => queueMicrotask(() => event.__emit(...args));

  for (const g of seedGroups) {
    state.groups.set(g.id, { id: g.id, title: g.title, color: g.color, windowId: g.windowId ?? 1, collapsed: false });
    nextGroupId = Math.max(nextGroupId, g.id + 1);
  }
  for (const t of seed) {
    const id = t.id ?? nextTabId++;
    state.tabs.push({
      id, windowId: t.windowId ?? 1, index: 0, url: t.url, title: t.title ?? t.url, pinned: Boolean(t.pinned),
      active: Boolean(t.active), audible: Boolean(t.audible), groupId: t.groupId ?? -1, favIconUrl: t.favIconUrl ?? '',
    });
  }

  const copy = (o) => ({ ...o });
  const ids = (v) => (Array.isArray(v) ? v : [v]);
  const inWindow = (w) => state.tabs.filter((t) => t.windowId === w).sort((a, b) => a.index - b.index);
  const need = (id) => {
    const t = state.tabs.find((x) => x.id === id);
    if (!t) throw new Error(`No tab with id: ${id}.`);
    return t;
  };

  /** Re-number tabs, drop empty groups and (non-primary) empty windows, firing the matching events. */
  const reindex = () => {
    for (const w of state.windows) state.tabs.filter((t) => t.windowId === w).forEach((t, i) => (t.index = i));
    for (const [gid, g] of [...state.groups]) {
      if (!state.tabs.some((t) => t.groupId === gid)) {
        state.groups.delete(gid);
        fire(ev.groupsRemoved, copy(g));
      }
    }
    for (const w of [...state.windows]) {
      if (w !== 1 && !state.tabs.some((t) => t.windowId === w)) {
        state.windows.delete(w);
        fire(ev.windowsRemoved, w);
      }
    }
  };

  /** Remove tabs and fire onRemoved the way Chrome does, flagging a window that closes with them. */
  function removeTabs(toRemove) {
    const set = new Set(toRemove.map((t) => t.id));
    const closing = new Set();
    for (const w of new Set(toRemove.map((t) => t.windowId))) {
      if (inWindow(w).every((t) => set.has(t.id))) closing.add(w);
    }
    state.tabs = state.tabs.filter((t) => !set.has(t.id));
    for (const t of toRemove) fire(ev.tabsRemoved, t.id, { windowId: t.windowId, isWindowClosing: closing.has(t.windowId) });
    reindex();
    for (const w of closing) if (w === 1) fire(ev.windowsRemoved, w);
  }

  // Place `moving` tabs at `index` of `windowId`, preserving their given order.
  function place(moving, windowId, index) {
    const rest = inWindow(windowId).filter((t) => !moving.includes(t));
    const at = index < 0 || index > rest.length ? rest.length : index;
    moving.forEach((t) => (t.windowId = windowId));
    const order = [...rest.slice(0, at), ...moving, ...rest.slice(at)];
    state.tabs = [...state.tabs.filter((t) => t.windowId !== windowId), ...order];
    order.forEach((t, i) => (t.index = i));
  }

  const chrome = {
    __state: state,
    __events: ev,
    /** Test helper: change a tab the way a page would (title, url, favicon, status) and fire onUpdated. */
    __setTab(id, props) {
      const t = need(id);
      Object.assign(t, props);
      fire(ev.tabsUpdated, id, { ...props }, copy(t));
    },
    windows: {
      getCurrent: async () => ({ id: 1 }),
      get: async (id) => {
        if (!state.windows.has(id)) throw new Error(`No window with id: ${id}.`);
        return { id };
      },
      getAll: async ({ populate } = {}) =>
        [...state.windows].map((id) => ({ id, ...(populate ? { tabs: inWindow(id).map(copy) } : {}) })),
      update: async (id, props) => {
        if (!state.windows.has(id)) throw new Error(`No window with id: ${id}.`);
        if (props.focused) state.focusedWindow = id;
        return { id };
      },
      create: async ({ tabId, url, focused } = {}) => {
        const id = nextWindowId++;
        state.windows.add(id);
        let created;
        if (tabId !== undefined) {
          const t = need(tabId);
          const oldWindow = t.windowId;
          t.groupId = -1;
          place([t], id, 0);
          fire(ev.tabsDetached, t.id, { oldWindowId: oldWindow, oldPosition: 0 });
          fire(ev.tabsAttached, t.id, { newWindowId: id, newPosition: 0 });
        } else {
          created = {
            id: nextTabId++, windowId: id, index: 0, url: url ?? 'chrome://newtab/', title: url ?? 'New Tab',
            pinned: false, active: true, audible: false, groupId: -1, favIconUrl: '',
          };
          state.tabs.push(created);
          place([created], id, 0);
          fire(ev.tabsCreated, copy(created));
        }
        reindex();
        if (focused !== false) state.focusedWindow = id;
        return { id, focused: focused !== false, tabs: inWindow(id).map(copy) };
      },
      remove: async (id) => {
        if (!state.windows.has(id)) throw new Error(`No window with id: ${id}.`);
        removeTabs(inWindow(id));
        if (id !== 1) return;
        state.windows.delete(1);
      },
      onRemoved: ev.windowsRemoved,
    },
    tabs: {
      query: async ({ windowId } = {}) => state.tabs.filter((t) => windowId === undefined || t.windowId === windowId).sort((a, b) => a.index - b.index).map(copy),
      get: async (id) => copy(need(id)),
      update: async (id, props) => {
        const t = need(id);
        const changed = {};
        if ('pinned' in props && props.pinned !== t.pinned) {
          t.pinned = props.pinned;
          changed.pinned = props.pinned;
        }
        if (props.active) {
          state.tabs.filter((x) => x.windowId === t.windowId).forEach((x) => (x.active = false));
          t.active = true;
        }
        if (Object.keys(changed).length) fire(ev.tabsUpdated, id, changed, copy(t));
        return copy(t);
      },
      create: async ({ windowId = 1, url = 'chrome://newtab/', index, active = true, pinned = false }) => {
        if (!state.windows.has(windowId)) throw new Error(`No window with id: ${windowId}.`);
        const t = { id: nextTabId++, windowId, index: 0, url, title: url, pinned, active, audible: false, groupId: -1, favIconUrl: '' };
        state.tabs.push(t);
        place([t], windowId, index ?? -1);
        fire(ev.tabsCreated, copy(t));
        return copy(t);
      },
      remove: async (v) => {
        removeTabs(ids(v).map(need));
      },
      move: async (v, { windowId, index }) => {
        const moving = ids(v).map(need);
        const w = windowId ?? moving[0].windowId;
        for (const t of moving) {
          const from = { windowId: t.windowId, index: t.index };
          if (t.windowId !== w) t.groupId = -1;
          place([t], w, index);
          if (from.windowId === w) fire(ev.tabsMoved, t.id, { windowId: w, fromIndex: from.index, toIndex: t.index });
          else {
            fire(ev.tabsDetached, t.id, { oldWindowId: from.windowId, oldPosition: from.index });
            fire(ev.tabsAttached, t.id, { newWindowId: w, newPosition: t.index });
          }
        }
        reindex();
        return moving.map(copy);
      },
      group: async ({ tabIds, groupId, createProperties }) => {
        const moving = ids(tabIds).map(need);
        let gid = groupId;
        let windowId;
        if (gid === undefined) {
          windowId = createProperties?.windowId ?? moving[0].windowId;
          gid = nextGroupId++;
          state.groups.set(gid, { id: gid, title: '', color: 'grey', windowId, collapsed: false });
          fire(ev.groupsCreated, copy(state.groups.get(gid)));
        } else {
          if (!state.groups.has(gid)) throw new Error(`No group with id: ${gid}.`);
          windowId = state.groups.get(gid).windowId;
        }
        moving.forEach((t) => (t.windowId = windowId));
        moving.forEach((t) => (t.groupId = gid));
        // Make the group contiguous, anchored at its first member.
        const win = inWindow(windowId);
        const members = win.filter((t) => t.groupId === gid);
        const anchor = win.findIndex((t) => t.groupId === gid);
        const others = win.filter((t) => t.groupId !== gid);
        const order = [...others.slice(0, anchor), ...members, ...others.slice(anchor)];
        state.tabs = [...state.tabs.filter((t) => t.windowId !== windowId), ...order];
        reindex();
        for (const t of moving) fire(ev.tabsUpdated, t.id, { groupId: gid }, copy(t));
        return gid;
      },
      ungroup: async (v) => {
        const moving = ids(v).map(need);
        moving.forEach((t) => (t.groupId = -1));
        reindex();
        for (const t of moving) fire(ev.tabsUpdated, t.id, { groupId: -1 }, copy(t));
      },
      onCreated: ev.tabsCreated,
      onRemoved: ev.tabsRemoved,
      onUpdated: ev.tabsUpdated,
      onMoved: ev.tabsMoved,
      onAttached: ev.tabsAttached,
      onDetached: ev.tabsDetached,
    },
    tabGroups: {
      query: async ({ windowId } = {}) => [...state.groups.values()].filter((g) => windowId === undefined || g.windowId === windowId).map(copy),
      get: async (id) => {
        const g = state.groups.get(id);
        if (!g) throw new Error(`No group with id: ${id}.`);
        return copy(g);
      },
      update: async (id, props) => {
        const g = state.groups.get(id);
        if (!g) throw new Error(`No group with id: ${id}.`);
        Object.assign(g, props);
        fire(ev.groupsUpdated, copy(g));
        return copy(g);
      },
      onUpdated: ev.groupsUpdated,
      onCreated: ev.groupsCreated,
      onRemoved: ev.groupsRemoved,
      onMoved: ev.groupsMoved,
    },
    bookmarks: (() => {
      const nodes = new Map();
      const add = (n) => (nodes.set(n.id, n), n);
      add({ id: '0', title: '', children: [] });
      if (seedBookmarks) {
        add({ id: '1', parentId: '0', title: 'Bookmarks bar' });
        add({ id: '2', parentId: '0', title: 'Other bookmarks', folderType: 'other' });
      }
      const kids = (pid) => [...nodes.values()].filter((n) => n.parentId === pid);
      const tree = (n) => ({ ...n, children: n.url ? undefined : kids(n.id).map(tree) });
      return {
        getTree: async () => [tree(nodes.get('0'))],
        getChildren: async (id) => kids(id).map(copy),
        create: async ({ parentId, title, url }) => add({ id: String(nextBookmarkId++), parentId, title, url }),
        update: async (id, changes) => {
          if (!nodes.has(id)) throw new Error("Can't find bookmark for id.");
          Object.assign(nodes.get(id), changes);
          return copy(nodes.get(id));
        },
        remove: async (id) => {
          if (!nodes.has(id)) throw new Error("Can't find bookmark for id.");
          if (kids(id).length) throw new Error("Can't remove non-empty folder (use recursive remove instead).");
          nodes.delete(id);
        },
        __nodes: nodes,
      };
    })(),
    storage: {
      local: makeArea(state.storage.local, 'local'),
      session: makeArea(state.storage.session, 'session'),
      onChanged: ev.storageChanged,
    },
    permissions: {
      __granted: new Set(),
      __answer: true, // what the user "clicks" when Chrome asks
      contains: async ({ origins = [], permissions = [] }) => [...origins, ...permissions].every((o) => chrome.permissions.__granted.has(o)),
      request: async ({ origins = [], permissions = [] }) => {
        chrome.permissions.__asked = [...(chrome.permissions.__asked ?? []), [...origins, ...permissions]];
        if (chrome.permissions.__answer) [...origins, ...permissions].forEach((o) => chrome.permissions.__granted.add(o));
        return chrome.permissions.__answer;
      },
    },
    declarativeNetRequest: (() => {
      let rules = [];
      return {
        updateDynamicRules: async ({ removeRuleIds = [], addRules = [] }) => {
          rules = rules.filter((r) => !removeRuleIds.includes(r.id)).concat(addRules);
        },
        getDynamicRules: async () => rules.map((r) => JSON.parse(JSON.stringify(r))),
      };
    })(),
    sidePanel: { setPanelBehavior: async () => {} },
    runtime: { id: 'testextensionid', onInstalled: { addListener() {} }, onStartup: { addListener() {} } },
  };

  function makeArea(store, areaName) {
    const clone = (v) => JSON.parse(JSON.stringify(v));
    return {
      get: async (keys) => {
        if (keys == null) return clone(store);
        const list = typeof keys === 'string' ? [keys] : Array.isArray(keys) ? keys : Object.keys(keys);
        const out = typeof keys === 'object' && !Array.isArray(keys) ? { ...keys } : {};
        for (const k of list) if (k in store) out[k] = clone(store[k]);
        return out;
      },
      set: async (obj) => {
        const changes = {};
        for (const [k, v] of Object.entries(obj)) changes[k] = { oldValue: store[k], newValue: clone(v) };
        Object.assign(store, clone(obj));
        fire(ev.storageChanged, changes, areaName);
      },
      remove: async (k) => {
        const changes = {};
        for (const key of ids(k)) {
          if (key in store) changes[key] = { oldValue: store[key] };
          delete store[key];
        }
        if (Object.keys(changes).length) fire(ev.storageChanged, changes, areaName);
      },
    };
  }

  reindex();
  return chrome;
}
