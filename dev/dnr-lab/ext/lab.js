const RULE_ID = 4242;
window.__lab = {
  async setRule(origin) {
    await chrome.declarativeNetRequest.updateDynamicRules({
      removeRuleIds: [RULE_ID],
      addRules: [{
        id: RULE_ID, priority: 1,
        action: { type: 'modifyHeaders', requestHeaders: [{ header: 'Origin', operation: 'set', value: origin }] },
        condition: { urlFilter: `|${origin}/`, initiatorDomains: [chrome.runtime.id], resourceTypes: ['xmlhttprequest'] },
      }],
    });
    return (await chrome.declarativeNetRequest.getDynamicRules()).length;
  },
  async clearRule() { await chrome.declarativeNetRequest.updateDynamicRules({ removeRuleIds: [RULE_ID] }); return true; },
  async call(url) {
    try {
      const r = await fetch(url, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ model: 'm', messages: [], format: { type: 'object', properties: { name: { type: 'string' } } } }) });
      return { status: r.status, body: (await r.text()).slice(0, 120) };
    } catch (e) { return { error: `${e.name}: ${e.message}` }; }
  },
};
