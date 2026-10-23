import { useRef, useState } from "react";
import { usePrivy } from "@privy-io/react-auth";
import { useExportWallet, useWallets } from "@privy-io/react-auth/solana";
import { useLanguage } from "./i18n.jsx";
import { openTreasuryWalletExport, treasuryExportWallets } from "./treasuryWalletExport.js";
import {transferApi} from './transfers.js';
import {nativeSecurityOperation} from './securitySession.js';

const KEYS = ["title", "wallet", "active", "notice", "button", "opening", "error"];

export default function TreasuryWalletExport({ treasuryAddress, authorized=false, divider=false }) {
  const { ready, authenticated, user, getAccessToken } = usePrivy();
  const { ready: walletsReady } = useWallets();
  const { exportWallet } = useExportWallet();
  const { t } = useLanguage();
  const text = Object.fromEntries(KEYS.map((key) => [key, t(`treasuryExport.${key}`)]));
  const [busy, setBusy] = useState(false), [error, setError] = useState(false), [expanded, setExpanded] = useState(false);
  const exporting = useRef(false);
  const addresses = treasuryExportWallets(user).filter(address=>address===treasuryAddress);
  const selected = treasuryAddress;

  if (!authorized || !ready || !authenticated || !walletsReady || !user?.id || !addresses.length) return null;

  const open = async () => {
    if (exporting.current) return;
    exporting.current = true; setBusy(true); setError(false);
    try {
      await openTreasuryWalletExport({ ready, authenticated, user, address: selected, exportWallet:options=>nativeSecurityOperation(()=>exportWallet(options)),
        authorize:()=>transferApi('/treasury/export-access',getAccessToken) });
    } catch {
      // Do not expose SDK errors that could contain sensitive export information.
      setError(true);
    } finally {
      exporting.current = false; setBusy(false);
    }
  };

  // Fila de Perfil → Administración; se expande para ver la tesorería y abrir la exportación de Privy.
  return <div>
    {divider && <div aria-hidden="true" style={{ height: 1, background: "#ECECF0" }} />}
    <button type="button" onClick={() => setExpanded((v) => !v)} aria-expanded={expanded}
      style={{ display: "flex", alignItems: "center", gap: 12, width: "100%", border: 0, background: "transparent", padding: "12px 0", font: "inherit", color: "inherit", textAlign: "left", cursor: "pointer" }}>
      <span style={{ width: 36, height: 36, borderRadius: 12, background: "#FFEADF", color: "#fe6c1c", display: "grid", placeItems: "center", flexShrink: 0 }}>
        <svg width="20" height="20" viewBox="0 0 24 24" fill="none" aria-hidden="true"><rect x="5" y="10.5" width="14" height="9.5" rx="2" stroke="currentColor" strokeWidth="1.8" /><path d="M8.5 10.5V8a3.5 3.5 0 0 1 7 0v2.5" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" /></svg>
      </span>
      <span style={{ flex: 1, minWidth: 0 }}>
        <span style={{ display: "block", fontSize: 15, fontWeight: 500, color: "#16161A" }}>{text.title}</span>
        <span style={{ display: "block", fontSize: 12.5, color: "#7A7A85", marginTop: 2 }}>{text.active}</span>
      </span>
      <svg width="18" height="18" viewBox="0 0 24 24" fill="none" aria-hidden="true" style={{ color: "#7A7A85", transform: expanded ? "rotate(90deg)" : "none", transition: "transform .15s ease", flexShrink: 0 }}>
        <path d="M9 5l7 7-7 7" stroke="currentColor" strokeWidth="1.9" strokeLinecap="round" strokeLinejoin="round" />
      </svg>
    </button>
    {expanded && <div style={{ padding: "0 0 14px 48px", display: "flex", flexDirection: "column", gap: 10 }}>
      <div>
        <div style={{ fontSize: 12.5, color: "#7A7A85" }}>{text.wallet}</div>
        <div style={{ marginTop: 3, overflowWrap: "anywhere", fontFamily: "ui-monospace, monospace", fontSize: 12.5, color: "#16161A", lineHeight: 1.5 }}>{selected}</div>
      </div>
      <div style={{ fontSize: 12.5, color: "#B45309", background: "#FFF3E6", borderRadius: 12, padding: "10px 12px", lineHeight: 1.45 }}>{text.notice}</div>
      <button type="button" onClick={open} disabled={busy} aria-busy={busy}
        style={{ padding: "12px 14px", borderRadius: 14, border: 0, background: "#FF5A00", color: "white", font: "inherit", fontSize: 14.5, fontWeight: 600, cursor: busy ? "wait" : "pointer", opacity: busy ? 0.7 : 1 }}>
        {busy ? text.opening : text.button}
      </button>
      {error && <div role="alert" style={{ fontSize: 12.5, color: "#E4483D" }}>{text.error}</div>}
    </div>}
  </div>;
}
