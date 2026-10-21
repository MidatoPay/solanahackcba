import { Fragment, useEffect, useRef, useState } from "react";
import { useLanguage } from "./i18n.jsx";
import { SOLANA, explorerAddressUrl } from "./chain.js";
import BusinessProfile from "./BusinessProfile.jsx";
import TreasuryWalletExport from "./TreasuryWalletExport.jsx";
import LanguageSelect from "./LanguageSelect.jsx";
import InstallApp from "./InstallApp.jsx";

// Perfil: identidad, negocio, cuenta, administración (solo admins) y cierre de sesión.
const C = { bg: "#F7F7F9", card: "#FFFFFF", ink: "#16161A", mut: "#7A7A85", line: "#ECECF0", accent: "#fe6c1c", orangeSoft: "#FFEADF", green: "#21B95B", red: "#E4483D", redSoft: "#FDECEA" };
const shortAddr = (a) => (a && a.length > 12 ? `${a.slice(0, 4)}…${a.slice(-4)}` : a || "—");
const cta = { border: 0, borderRadius: 18, padding: "16px 18px", font: "inherit", fontSize: 16, fontWeight: 600, cursor: "pointer", width: "100%" };

const Svg = ({ size = 20, children }) => <svg width={size} height={size} viewBox="0 0 24 24" fill="none" aria-hidden="true">{children}</svg>;
const stroke = { stroke: "currentColor", strokeLinecap: "round", strokeLinejoin: "round", strokeWidth: 1.8 };
const IconChevron = () => <Svg size={18}><path d="M9 5l7 7-7 7" {...stroke} strokeWidth="1.9" /></Svg>;
const IconExternal = () => <Svg size={16}><path d="M14 5h5v5M10 14L19 5" {...stroke} strokeWidth="2" /><path d="M19 13v5a1 1 0 0 1-1 1H6a1 1 0 0 1-1-1V6a1 1 0 0 1 1-1h5" {...stroke} strokeWidth="2" /></Svg>;
const IconCopy = ({ size = 16 }) => <Svg size={size}><rect x="8" y="8" width="12" height="12" rx="2" {...stroke} strokeWidth="1.9" /><path d="M16 8V6a2 2 0 0 0-2-2H6a2 2 0 0 0-2 2v8a2 2 0 0 0 2 2h2" {...stroke} strokeWidth="1.9" /></Svg>;
const IconCheck = ({ size = 16 }) => <Svg size={size}><path d="M5 12.5l5 5L19 7" {...stroke} strokeWidth="2.6" /></Svg>;
const IconExplorer = () => <Svg><circle cx="11" cy="11" r="6.5" {...stroke} /><path d="M16 16l4 4" {...stroke} /></Svg>;
const IconGlobe = () => <Svg><circle cx="12" cy="12" r="9" {...stroke} /><path d="M3 12h18M12 3c2.5 2.6 3.7 5.6 3.7 9s-1.2 6.4-3.7 9c-2.5-2.6-3.7-5.6-3.7-9S9.5 5.6 12 3Z" {...stroke} /></Svg>;
const IconFaucet = () => <Svg><path d="M8 4h8M12 4v3M7 10h10a2 2 0 0 1 2 2v2H5v-2a2 2 0 0 1 2-2Z" {...stroke} /><path d="M12 17.5c0 1.2-.8 2.5-1.5 2.5s-1.5-1.3-1.5-2.5S10.5 15 10.5 15s1.5 1.3 1.5 2.5Z" {...stroke} /></Svg>;
const IconChart = () => <Svg><path d="M4 19h16M7 16v-5M12 16V8M17 16v-8" {...stroke} /></Svg>;
const IconLogout = () => <Svg><path d="M10 4H6a2 2 0 0 0-2 2v12a2 2 0 0 0 2 2h4" {...stroke} /><path d="M15 16l4-4-4-4M19 12H9" {...stroke} /></Svg>;

export function Section({ title, children }) {
  return (
    <section>
      {title && <h3 style={{ margin: "0 0 8px 4px", fontSize: 13, fontWeight: 500, color: C.mut }}>{title}</h3>}
      <div style={{ background: C.bg, borderRadius: 22, padding: "2px 16px" }}>{children}</div>
    </section>
  );
}

export function SettingsRow({ icon, title, sub, onClick, href, trailing, danger }) {
  const inner = (
    <>
      <span style={{ width: 36, height: 36, borderRadius: 12, background: danger ? C.redSoft : C.orangeSoft, color: danger ? C.red : C.accent, display: "grid", placeItems: "center", flexShrink: 0 }}>{icon}</span>
      <span style={{ flex: 1, minWidth: 0 }}>
        <span style={{ display: "block", fontSize: 15, fontWeight: 500, color: danger ? C.red : C.ink }}>{title}</span>
        {sub && <span style={{ display: "block", fontSize: 12.5, color: C.mut, marginTop: 2, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{sub}</span>}
      </span>
      {trailing ?? (href ? <span style={{ color: C.mut, display: "grid" }}><IconExternal /></span> : onClick ? <span style={{ color: C.mut, display: "grid" }}><IconChevron /></span> : null)}
    </>
  );
  const style = { display: "flex", alignItems: "center", gap: 12, width: "100%", border: 0, background: "transparent", padding: "12px 0", font: "inherit", color: "inherit", textAlign: "left", textDecoration: "none", cursor: onClick || href ? "pointer" : "default" };
  if (href) return <a href={href} target="_blank" rel="noreferrer" style={style}>{inner}</a>;
  if (onClick) return <button type="button" onClick={onClick} style={style}>{inner}</button>;
  return <div style={style}>{inner}</div>;
}

const Divider = () => <div aria-hidden="true" style={{ height: 1, background: C.line }} />;


function useCopied() {
  const [copied, setCopied] = useState(null);
  useEffect(() => {
    if (!copied) return undefined;
    const timer = setTimeout(() => setCopied(null), 1500);
    return () => clearTimeout(timer);
  }, [copied]);
  const copy = async (key, value) => {
    try { await navigator.clipboard.writeText(value); setCopied(key); } catch { /* sin permiso de portapapeles */ }
  };
  return [copied, copy];
}

function LogoutSheet({ onConfirm, onClose }) {
  const { t } = useLanguage();
  const closeRef = useRef(onClose);
  closeRef.current = onClose;
  const titleRef = useRef(null);
  useEffect(() => {
    titleRef.current?.focus();
    const onKey = (event) => { if (event.key === "Escape") closeRef.current(); };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);
  return (
    <div className="mp-overlay" role="presentation" onClick={onClose} style={{ background: "rgba(16,16,22,.45)", alignItems: "flex-end" }}>
      <div role="dialog" aria-modal="true" aria-labelledby="mp-logout-title" onClick={(event) => event.stopPropagation()}
        style={{ background: C.card, borderRadius: "24px 24px 0 0", padding: "14px 20px calc(22px + env(safe-area-inset-bottom))", width: "100%", boxSizing: "border-box" }}>
        <div aria-hidden="true" style={{ width: 42, height: 4, borderRadius: 4, background: C.line, margin: "0 auto 18px" }} />
        <h2 id="mp-logout-title" ref={titleRef} tabIndex={-1} style={{ margin: 0, fontSize: 18, fontWeight: 600, color: C.ink, outline: "none" }}>{t("mas.logoutConfirmTitle")}</h2>
        <p style={{ margin: "8px 0 0", fontSize: 14, color: C.mut, lineHeight: 1.5 }}>{t("mas.logoutConfirmBody")}</p>
        <div style={{ display: "flex", flexDirection: "column", gap: 10, marginTop: 20 }}>
          <button type="button" onClick={onConfirm} style={{ ...cta, background: C.red, color: "#fff" }}>{t("mas.logoutConfirmBtn")}</button>
          <button type="button" onClick={onClose} style={{ ...cta, background: C.bg, color: C.ink }}>{t("mas.cancel")}</button>
        </div>
      </div>
    </div>
  );
}

export default function ProfileScreen({ email, address, nombre, onLogout, goReports, privyId, merchantProfile, treasuryExportAccess }) {
  const { t, lang } = useLanguage();
  const [confirmLogout, setConfirmLogout] = useState(false);
  const [copied, copy] = useCopied();
  const showAdmin = Boolean(goReports) || treasuryExportAccess?.authorized === true;
  const initial = (nombre || "?").trim().charAt(0).toUpperCase() || "?";

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 20 }}>
      <h2 style={{ fontSize: 24, fontWeight: 500, color: C.ink, margin: 0, letterSpacing: -0.3 }}>{t("mas.title")}</h2>

      <div style={{ display: "flex", flexDirection: "column", alignItems: "center", textAlign: "center", gap: 4 }}>
        <div aria-hidden="true" style={{ width: 68, height: 68, borderRadius: "50%", background: C.orangeSoft, color: C.accent, display: "grid", placeItems: "center", fontSize: 26, fontWeight: 500, marginBottom: 8 }}>
          {initial}
        </div>
        <div style={{ fontSize: 18, fontWeight: 500, color: C.ink, overflowWrap: "anywhere" }}>{nombre}</div>
        <div style={{ fontSize: 13.5, color: C.mut, overflowWrap: "anywhere" }}>{email || t("mas.noEmailAccount")}</div>
        <button type="button" onClick={() => copy("wallet", address)} aria-label={copied === "wallet" ? t("mas.copied") : t("mas.copyWalletAria")}
          style={{ marginTop: 10, display: "inline-flex", alignItems: "center", gap: 8, border: 0, borderRadius: 999, background: C.bg, padding: "7px 12px", font: "inherit", cursor: "pointer" }}>
          <span style={{ fontSize: 12.5, color: C.mut }}>{t("mas.walletLabel")}</span>
          <span style={{ fontSize: 12.5, fontFamily: "ui-monospace, monospace", color: C.ink }}>{shortAddr(address)}</span>
          <span style={{ color: copied === "wallet" ? C.green : C.accent, display: "grid" }}>{copied === "wallet" ? <IconCheck /> : <IconCopy />}</span>
        </button>
      </div>

      <Section title={t("mas.sectionBusiness")}>
        <BusinessProfile profile={merchantProfile.profile} error={merchantProfile.error} onSave={merchantProfile.save} onRetry={merchantProfile.retry} />
      </Section>

      <Section title={t("mas.sectionAccount")}>
        <SettingsRow icon={<IconExplorer />} title={t("mas.explorerTitle")} sub={t("mas.explorerSub")} href={explorerAddressUrl(address)} />
        {SOLANA.cluster === "devnet" && (
          <>
            <Divider />
            <SettingsRow icon={<IconFaucet />} title={t("mas.faucetTitle")} sub={t("mas.faucetSub")} href={SOLANA.faucet} />
          </>
        )}
        <Divider />
        <SettingsRow icon={<IconGlobe />} title={t("mas.languageTitle")} trailing={<LanguageSelect id="mp-profile-language" />} />
      </Section>

      <InstallApp />

      {showAdmin && (
        <Section title={t("mas.sectionAdmin")}>
          {goReports && <SettingsRow icon={<IconChart />} title={t("mas.reportsTitle")} sub={t("mas.reportsSub")} onClick={goReports} />}
          <TreasuryWalletExport key={privyId} treasuryAddress={treasuryExportAccess?.address} authorized={treasuryExportAccess?.authorized === true}
            divider={Boolean(goReports)} />
        </Section>
      )}

      <Section>
        <SettingsRow icon={<IconLogout />} title={t("mas.logoutTitle")} danger onClick={() => setConfirmLogout(true)} trailing={<Fragment />} />
      </Section>

      <div role="status" aria-live="polite" style={{ position: "absolute", width: 1, height: 1, overflow: "hidden", clip: "rect(0 0 0 0)" }}>
        {copied ? t("mas.copied") : ""}
      </div>

      {confirmLogout && <LogoutSheet onConfirm={onLogout} onClose={() => setConfirmLogout(false)} />}
    </div>
  );
}
