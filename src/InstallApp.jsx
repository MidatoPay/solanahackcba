import { useEffect, useId, useState } from 'react';
import { useOptionalLanguage } from './i18n.jsx';
import { appInstaller } from './pwa.js';

const copy = {
  es: {
    title: 'Instalá MidatoPay', body: 'Accedé desde el ícono en tu pantalla de inicio.',
    install: 'Instalar app', how: 'Cómo instalar', later: 'Ahora no', opening: 'Abriendo…',
    ios: 'Abrí esta página en Safari. Tocá Compartir → Agregar a inicio (o Agregar a la pantalla de inicio) → Agregar. Si aparece “Abrir como app web”, dejalo activado.',
    android: 'Abrí el menú del navegador y elegí Instalar app o Agregar a la pantalla principal.',
    embedded: 'Abrí esta página en el navegador del teléfono: Safari en iPhone o Chrome en Android. Luego seguí estos pasos:',
    desktop: 'Usá el ícono de instalación en Chrome o Edge, o Archivo → Agregar al Dock en Safari.',
    error: 'No se pudo abrir la instalación. Podés instalar desde el menú del navegador.',
  },
  en: {
    title: 'Install MidatoPay', body: 'Open it from the icon on your home screen.',
    install: 'Install app', how: 'How to install', later: 'Not now', opening: 'Opening…',
    ios: 'Open this page in Safari. Tap Share → Add to Home Screen → Add. If “Open as Web App” appears, leave it enabled.',
    android: 'Open the browser menu and choose Install app or Add to Home screen.',
    embedded: 'Open this page in your phone’s browser: Safari on iPhone or Chrome on Android. Then follow these steps:',
    desktop: 'Use the install icon in Chrome or Edge, or File → Add to Dock in Safari.',
    error: 'Installation could not open. You can install from the browser menu.',
  },
  zh: {
    title: '安装 MidatoPay', body: '通过主屏幕上的图标快速打开应用。',
    install: '安装应用', how: '如何安装', later: '暂时不用', opening: '正在打开…',
    ios: '在 Safari 中打开此页面，点击“分享”→“添加到主屏幕”→“添加”。如果出现“作为网页 App 打开”，请保持开启。',
    android: '打开浏览器菜单，选择“安装应用”或“添加到主屏幕”。',
    embedded: '请在手机浏览器中打开此页面：iPhone 使用 Safari，Android 使用 Chrome。然后按照以下步骤操作：',
    desktop: '使用 Chrome 或 Edge 中的安装图标，或在 Safari 中选择“文件”→“添加到程序坞”。',
    error: '无法打开安装界面。请通过浏览器菜单安装。',
  },
};

export default function InstallApp({ automatic = false, controller = appInstaller }) {
  const { lang } = useOptionalLanguage();
  const text = copy[lang] || copy.en;
  const id = useId();
  const [state, setState] = useState(controller.getState);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(false);
  const [help, setHelp] = useState(false);
  useEffect(() => {
    const update = () => setState(controller.getState());
    const unsubscribe = controller.subscribe(update);
    if (automatic) controller.reconsider();
    update();
    return unsubscribe;
  }, [controller, automatic]);
  useEffect(() => {
    if (automatic && state.suggested) {
      controller.markPresented();
      setHelp(false);
      setError(false);
    }
  }, [automatic, state.suggested, controller]);

  if (state.standalone || (automatic ? !state.suggested : state.suggested)) return null;
  const native = state.canPrompt && !state.inAppBrowser && state.platform !== 'ios';
  async function install() {
    if (!native) { setHelp(value => !value); return; }
    setBusy(true);
    setError(false);
    try {
      const outcome = await controller.install();
      if (outcome === 'unavailable' || outcome === 'dismissed') setHelp(true);
    } catch { setError(true); setHelp(true); }
    finally { setBusy(false); }
  }
  return (
    <section className={`mp-install-card${automatic ? ' mp-install-suggestion' : ''}`} aria-labelledby={id}>
      <h2 id={id}>{text.title}</h2>
      <p>{text.body}</p>
      <div className="mp-install-actions">
        <button type="button" onClick={install} disabled={busy} aria-expanded={!native ? help : undefined}
          aria-controls={!native ? `${id}-help` : undefined}>
          {busy ? text.opening : native ? text.install : text.how}
        </button>
        {automatic && <button type="button" className="mp-install-later" onClick={() => controller.dismiss()}>{text.later}</button>}
      </div>
      {help && <div id={`${id}-help`} className="mp-install-help">
        {state.inAppBrowser && <p>{text.embedded}</p>}
        <p>{text[state.platform]}</p>
      </div>}
      {error && <p role="status">{text.error}</p>}
    </section>
  );
}
