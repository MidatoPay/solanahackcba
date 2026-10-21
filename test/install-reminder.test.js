import test from 'node:test';
import assert from 'node:assert/strict';
import { createInstallController, INSTALL_REMINDER_MS, INSTALL_REMINDER_KEY } from '../src/pwa.js';

function fixture({ ua = 'Android Chrome/140', storage = new Map(), stamp = 1000, denied = false } = {}) {
  const win = new EventTarget();
  const document = Object.assign(new EventTarget(), { visibilityState: 'visible' });
  const media = Object.assign(new EventTarget(), { matches: false });
  let clock = stamp, writes = 0;
  Object.assign(win, { document, navigator: { userAgent: ua }, matchMedia: () => media,
    localStorage: {
      getItem(key) { if (denied) throw Error('Denied'); return storage.get(key) ?? null; },
      setItem(key, value) { if (denied) throw Error('Denied'); writes++; storage.set(key, value); },
    },
  });
  const controller = createInstallController(win, { now: () => clock });
  return { win, document, media, storage, controller, advance: ms => { clock += ms; },
    writes: () => writes, focus: () => win.dispatchEvent(new Event('focus')),
    present() { controller.reconsider(); controller.markPresented(); },
  };
}

test('first visit records only a rendered suggestion, with no StrictMode or repeated-event duplicate', () => {
  const f = fixture();
  assert.equal(f.controller.getState().suggested, false);
  f.controller.reconsider();
  assert.equal(f.controller.getState().suggested, true);
  assert.equal(f.storage.size, 0);
  f.controller.markPresented();
  f.controller.markPresented();
  f.focus();
  assert.equal(f.writes(), 1);
  assert.equal(f.storage.get(INSTALL_REMINDER_KEY), '1000');
  f.controller.dismiss();
  f.focus();
  assert.equal(f.controller.getState().suggested, false);
  f.controller.dispose();
});

test('reload shares cooldown across accounts; exact 12-hour boundary offers on return only', () => {
  const first = fixture();
  first.present();
  first.controller.dispose();
  const f = fixture({ storage: first.storage, stamp: 1000 + INSTALL_REMINDER_MS - 1 });
  f.present();
  assert.equal(f.controller.getState().suggested, false);
  f.advance(1);
  assert.equal(f.controller.getState().suggested, false, 'no automatic timer while continuously active');
  f.focus();
  assert.equal(f.controller.getState().suggested, true);
  f.controller.markPresented();
  f.controller.dismiss();
  f.focus();
  assert.equal(f.controller.getState().suggested, false);
  f.controller.dispose();
});

test('hidden pages do not consume reminders; visibility return after 12 hours offers again', () => {
  const f = fixture();
  f.document.visibilityState = 'hidden';
  f.present();
  assert.equal(f.controller.getState().suggested, false);
  assert.equal(f.writes(), 0);
  f.document.visibilityState = 'visible';
  f.document.dispatchEvent(new Event('visibilitychange'));
  f.controller.markPresented();
  f.controller.dismiss();
  f.advance(INSTALL_REMINDER_MS + 500);
  f.document.visibilityState = 'hidden';
  f.focus();
  assert.equal(f.controller.getState().suggested, false);
  f.document.visibilityState = 'visible';
  f.document.dispatchEvent(new Event('visibilitychange'));
  assert.equal(f.controller.getState().suggested, true);
  f.controller.dispose();
});

test('blocked storage keeps the session cooldown and malformed timestamps do not suppress offers', () => {
  const f = fixture({ denied: true });
  f.present();
  f.controller.dismiss();
  f.focus();
  assert.equal(f.controller.getState().suggested, false);
  f.advance(INSTALL_REMINDER_MS);
  f.focus();
  assert.equal(f.controller.getState().suggested, true);
  f.controller.dispose();
  for (const value of ['broken', '-1', 'Infinity', '999999999999999']) {
    const invalid = fixture({ storage: new Map([[INSTALL_REMINDER_KEY, value]]) });
    invalid.present();
    assert.equal(invalid.controller.getState().suggested, true, value);
    invalid.controller.dispose();
  }
});

test('desktop and installed app do not suggest; iPhone and embedded Android offer manual guidance', () => {
  const desktop = fixture({ ua: 'Windows Chrome/140' });
  desktop.present();
  assert.equal(desktop.controller.getState().suggested, false);
  desktop.controller.dispose();
  for (const installed of ['media', 'ios']) {
    const f = fixture({ ua: 'iPhone Safari' });
    if (installed === 'media') f.media.matches = true;
    else f.win.navigator.standalone = true;
    f.media.dispatchEvent(new Event('change'));
    f.present();
    assert.equal(f.controller.getState().suggested, false);
    f.controller.dispose();
  }
  for (const [ua, platform, inAppBrowser] of [
    ['iPhone Safari', 'ios', false], ['iPhone Instagram', 'ios', true],
    ['Android; wv) Chrome', 'android', true],
  ]) {
    const f = fixture({ ua });
    f.present();
    assert.equal(f.controller.getState().suggested, true);
    assert.equal(f.controller.getState().platform, platform);
    assert.equal(f.controller.getState().inAppBrowser, inAppBrowser);
    assert.equal(f.controller.getState().canPrompt, false);
    f.controller.dispose();
  }
});

test('accepted install hides card; cancellation or failure consumes event and preserves manual fallback', async () => {
  for (const outcome of ['accepted', 'dismissed', 'failed']) {
    const f = fixture();
    f.present();
    f.win.dispatchEvent(Object.assign(new Event('beforeinstallprompt', { cancelable: true }), {
      prompt: () => outcome === 'failed' ? Promise.reject(Error('Failed')) : Promise.resolve(),
      userChoice: Promise.resolve({ outcome }),
    }));
    if (outcome === 'failed') await assert.rejects(f.controller.install(), /Failed/);
    else assert.equal(await f.controller.install(), outcome);
    assert.equal(f.controller.getState().suggested, outcome !== 'accepted');
    assert.equal(await f.controller.install(), 'unavailable');
    f.win.dispatchEvent(new Event('appinstalled'));
    assert.equal(f.controller.getState().suggested, false);
    f.advance(INSTALL_REMINDER_MS);
    f.focus();
    assert.equal(f.controller.getState().suggested, false);
    f.controller.dispose();
  }
});

test('storage notification prevents a second tab showing a pending suggestion', () => {
  const f = fixture();
  f.controller.reconsider();
  f.storage.set(INSTALL_REMINDER_KEY, '1000');
  f.win.dispatchEvent(Object.assign(new Event('storage'), { key: INSTALL_REMINDER_KEY }));
  assert.equal(f.controller.getState().suggested, false);
  f.controller.dispose();
  f.advance(INSTALL_REMINDER_MS);
  f.focus();
  assert.equal(f.controller.getState().suggested, false, 'disposed listeners stay inactive');
});
