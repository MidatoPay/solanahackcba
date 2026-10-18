export function createInstallController(browser) {
  const listeners = new Set();
  const media = browser?.matchMedia?.('(display-mode: standalone)');
  let promptEvent = null;
  let installed = false;
  let state;
  const publish = () => {
    state = { standalone: installed || Boolean(media?.matches || browser?.navigator?.standalone),
      canPrompt: Boolean(promptEvent) };
    for (const listener of listeners) listener();
  };
  const onPrompt = event => { event.preventDefault(); promptEvent = event; publish(); };
  const onInstalled = () => { installed = true; promptEvent = null; publish(); };
  browser?.addEventListener('beforeinstallprompt', onPrompt);
  browser?.addEventListener('appinstalled', onInstalled);
  media?.addEventListener?.('change', publish);
  publish();
  return {
    getState: () => state,
    subscribe(listener) { listeners.add(listener); return () => listeners.delete(listener); },
    async install() {
      if (!promptEvent || state.standalone) return 'unavailable';
      const event = promptEvent;
      promptEvent = null;
      publish();
      // Must be called synchronously from the user's click, before awaiting.
      await event.prompt();
      return (await event.userChoice).outcome;
    },
    dispose() {
      browser?.removeEventListener('beforeinstallprompt', onPrompt);
      browser?.removeEventListener('appinstalled', onInstalled);
      media?.removeEventListener?.('change', publish);
      listeners.clear();
    },
  };
}

// Capture the prompt before Profile mounts, including during restored sessions.
export const appInstaller = createInstallController(typeof window === 'undefined' ? null : window);

export async function registerAppWorker(browser = window) {
  if (!browser.isSecureContext || !browser.navigator?.serviceWorker) return null;
  return browser.navigator.serviceWorker.register('/sw.js', { scope: '/', updateViaCache: 'none' });
}
