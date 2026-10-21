export const INSTALL_REMINDER_MS = 12 * 60 * 60 * 1000;
export const INSTALL_REMINDER_KEY = 'midatopay.install.lastShown';

export function createInstallController(browser, { now = Date.now } = {}) {
  const listeners = new Set();
  const media = browser?.matchMedia?.('(display-mode: standalone)');
  const ua = browser?.navigator?.userAgent || '';
  const platform = /iPhone|iPad|iPod/i.test(ua) ||
    (/Macintosh/i.test(ua) && browser?.navigator?.maxTouchPoints > 1) ? 'ios' :
    /Android/i.test(ua) ? 'android' : 'desktop';
  const inAppBrowser = /FBAN|FBAV|Instagram|Line\/|; wv\)|WebView/i.test(ua);
  let promptEvent = null, installed = false, suggested = false, recorded = false;
  let lastShown = null, state;
  const visible = () => !browser?.document || browser.document.visibilityState === 'visible';
  const readLastShown = () => {
    try {
      const value = browser?.localStorage?.getItem(INSTALL_REMINDER_KEY);
      const stamp = value === null || value === undefined ? NaN : Number(value);
      if (Number.isFinite(stamp) && stamp >= 0 && stamp <= now()) lastShown = Math.max(lastShown ?? 0, stamp);
    } catch { /* Private browsing can deny storage; keep the session timestamp. */ }
    return lastShown;
  };
  const publish = () => {
    const standalone = installed || Boolean(media?.matches || browser?.navigator?.standalone);
    if (standalone) suggested = false;
    state = { standalone, canPrompt: Boolean(promptEvent), platform, inAppBrowser, suggested };
    for (const listener of listeners) listener();
  };
  const reconsider = () => {
    if (!visible() || state.standalone || platform === 'desktop' || suggested) return;
    const previous = readLastShown();
    if (previous !== null && now() - previous < INSTALL_REMINDER_MS) return;
    suggested = true;
    recorded = false;
    publish();
  };
  const onPrompt = event => { event.preventDefault(); promptEvent = event; publish(); };
  const onInstalled = () => { installed = true; promptEvent = null; publish(); };
  const onStorage = event => {
    if (event.key !== INSTALL_REMINDER_KEY) return;
    readLastShown();
    // Another visible tab may have presented the card before this tab rendered it.
    if (suggested && !recorded && lastShown !== null && now() - lastShown < INSTALL_REMINDER_MS) {
      suggested = false;
      publish();
    }
  };
  browser?.addEventListener('beforeinstallprompt', onPrompt);
  browser?.addEventListener('appinstalled', onInstalled);
  browser?.addEventListener('focus', reconsider);
  browser?.addEventListener('storage', onStorage);
  browser?.document?.addEventListener('visibilitychange', reconsider);
  media?.addEventListener?.('change', publish);
  publish();
  return {
    getState: () => state,
    subscribe(listener) { listeners.add(listener); return () => listeners.delete(listener); },
    reconsider,
    markPresented() {
      if (!suggested || recorded || !visible()) return;
      recorded = true;
      lastShown = now();
      try { browser?.localStorage?.setItem(INSTALL_REMINDER_KEY, String(lastShown)); } catch { /* Session fallback. */ }
    },
    dismiss() { suggested = false; publish(); },
    async install() {
      if (!promptEvent || state.standalone) return 'unavailable';
      const event = promptEvent;
      promptEvent = null;
      publish();
      // Keep this call in the user's click gesture, before the first await.
      await event.prompt();
      const outcome = (await event.userChoice).outcome;
      if (outcome === 'accepted') { suggested = false; publish(); }
      return outcome;
    },
    dispose() {
      browser?.removeEventListener('beforeinstallprompt', onPrompt);
      browser?.removeEventListener('appinstalled', onInstalled);
      browser?.removeEventListener('focus', reconsider);
      browser?.removeEventListener('storage', onStorage);
      browser?.document?.removeEventListener('visibilitychange', reconsider);
      media?.removeEventListener?.('change', publish);
      listeners.clear();
    },
  };
}

// Register early, including before login and before Profile mounts.
export const appInstaller = createInstallController(typeof window === 'undefined' ? null : window);

export async function registerAppWorker(browser = window) {
  if (!browser.isSecureContext || !browser.navigator?.serviceWorker) return null;
  return browser.navigator.serviceWorker.register('/sw.js', { scope: '/', updateViaCache: 'none' });
}
