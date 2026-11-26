# Opening big sessions without running out of memory

Opening a 650-tab session crashed Chrome: Decltr created every tab at once and every tab started loading.
These experiments run in a throwaway Chrome profile against a local server whose pages hold about 30 MB each.

## Can a tab be opened unloaded? (`run.mjs`, `wake.mjs`)

| Way of opening | Result |
| --- | --- |
| Create normally (before) | 20 tabs used 2.3 GB |
| Create, then unload (`tabs.discard`) at once | The address is erased: the tab becomes empty and stays empty when clicked |
| Create, wait until Chrome knows the address and title, then unload | Address and title kept; 120 tabs left Chrome using no more memory than before |

Chrome has no way to create a tab that starts unloaded (Firefox has `discarded: true`). Other findings:

- Unloading gives a tab a **new ID**. Groups and Undo must use the ID that `discard` returns.
- Grouping and collapsing unloaded tabs keeps them unloaded.
- Clicking an unloaded tab, or reloading it, loads the page normally.
- A page unloaded before it sent its title shows its address as the title until clicked.

## The shipped code (`real-open.mjs`)

`openSession` from the extension, opening 200 heavy tabs where every 10th page takes 5 seconds to send its title:

- 200 tabs, in order, 199 unloaded (the tab you land on stays loaded), groups and collapsed state rebuilt.
- Memory peaked at about 1.2 GB above the start while opening and ended below where it started.
- 40 seconds for 200 tabs, 6 loading at a time. The slow pages showed their address as their title;
  the session kept their real titles when the background worker synced the window.
- Clicking an unloaded tab loaded it. Undo closed the window.

## When was a tab last used? (`last-used.mjs`)

`tab.lastAccessed` (Chrome 121+) is kept for unloaded tabs. After a browser restart, Chrome kept it for some
tabs and reset it to the restart time for others. A reset only makes a tab look more recently used, so
"Archive old tabs" can miss tabs after a restart but never archives a tab that was really used recently.
