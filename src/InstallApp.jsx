import { useEffect, useState } from 'react';
import { useLanguage } from './i18n.jsx';
import { appInstaller } from './pwa.js';

export default function InstallApp() {
  const { lang } = useLanguage();
  const en = lang === 'en';
  const [state, setState] = useState(appInstaller.getState);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(false);
  useEffect(() => {
    const update = () => setState(appInstaller.getState());
    const unsubscribe = appInstaller.subscribe(update);
    update();
    return unsubscribe;
  }, []);
  if (state.standalone) return null;
  async function install() {
    setBusy(true); setError(false);
    try { await appInstaller.install(); }
    catch { setError(true); }
    finally { setBusy(false); }
  }
  return (
    <section aria-label={en ? 'Install MidatoPay' : 'Instalar MidatoPay'}
      style={{ background: '#fff', border: '1px solid #e7e7ee', borderRadius: 20, padding: 20 }}>
      <h3 style={{ margin: 0, fontSize: 16, color: '#242431' }}>{en ? 'MidatoPay on your home screen' : 'MidatoPay en tu pantalla de inicio'}</h3>
      <p style={{ fontSize: 13, color: '#606071', lineHeight: 1.5 }}>
        {en ? 'Open your account directly from the app icon.' : 'Abrí tu cuenta directamente desde el ícono de la app.'}
      </p>
      {state.canPrompt && (
        <button type="button" onClick={install} disabled={busy}
          style={{ minHeight: 44, padding: '10px 20px', border: 0, borderRadius: 12, background: '#a93600', color: '#fff', font: 'inherit', fontWeight: 600, cursor: busy ? 'wait' : 'pointer' }}>
          {busy ? (en ? 'Opening…' : 'Abriendo…') : (en ? 'Install app' : 'Instalar app')}
        </button>
      )}
      {!state.canPrompt && !busy && (
        <details>
          <summary style={{ cursor: 'pointer', minHeight: 44, display: 'list-item', alignContent: 'center', fontSize: 14, fontWeight: 600, color: '#a93600' }}>
            {en ? 'How to install' : 'Cómo instalar'}
          </summary>
          <ul style={{ paddingLeft: 20, fontSize: 13, lineHeight: 1.6, color: '#606071' }}>
            <li>{en ? 'iPhone / iPad: open in Safari, tap Share, then Add to Home Screen.' : 'iPhone / iPad: abrí en Safari, tocá Compartir y luego Agregar a inicio.'}</li>
            <li>{en ? 'Android: open the browser menu and choose Install app or Add to Home screen.' : 'Android: abrí el menú del navegador y elegí Instalar app o Agregar a la pantalla principal.'}</li>
            <li>{en ? 'Computer: use the install icon in Chrome / Edge, or File → Add to Dock in Safari.' : 'Computadora: usá el ícono de instalación en Chrome / Edge, o Archivo → Agregar al Dock en Safari.'}</li>
          </ul>
        </details>
      )}
      {error && <p role="status" style={{ fontSize: 13, color: '#a93600' }}>
        {en ? 'Use your browser menu to install the app.' : 'Usá el menú de tu navegador para instalar la app.'}
      </p>}
    </section>
  );
}
