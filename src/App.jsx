import { useState, useEffect, useRef, useCallback, useMemo } from "react";
import { usePrivy, useWallets as useEvmWallets } from "@privy-io/react-auth";
import { useWallets, useSignTransaction, useSignAndSendTransaction } from "@privy-io/react-auth/solana";
import { isAddress } from "@solana/kit";
import MercadoPagoCharge from "./MercadoPagoCharge.jsx";
import PaymentReports from "./PaymentReports.jsx";
import TreasuryWalletExport from "./TreasuryWalletExport.jsx";
import BusinessProfile from "./BusinessProfile.jsx";
import InstallApp from './InstallApp.jsx';
import {primarySolanaWallet} from './primaryWallet.js';
import {useSponsoredTransfers,transferApi,exactUsdc} from './transfers.js';
import TransferApproval from './TransferApproval.jsx';
import TransferReceipt from './TransferReceipt.jsx';
import { useMerchantProfile } from "./merchantProfile.js";
import { userDisplayName, merchantDisplayName } from "./merchantIdentity.js";
import { reportsApi } from "./paymentReports.js";
import { chargeApi } from "./charges.js";
import { paymentReceived, deliveryNoticeKey } from "./chargeStatus.js";
import jsQR from "jsqr";
import { SOLANA, explorerAddressUrl, explorerTxUrl } from "./chain.js";
import {
  armarMemo,
  estimateUsdcTransfer,
  getUsdcBalance,
  nuevaFactura,
  sendUsdc,
} from "./solana.js";
import { FALLBACK_FX_ARS_USD, getArsPerUsdc, quoteArsToUsdc, quoteUsdcToArs, usdcToArs } from "./fx.js";
import {
  estimateConvertUsdcToArs,
  runConvertArsToUsdc,
  runConvertUsdcToArs,
  refreshPairBalances,
} from "./flows.js";
import {
  getTreasuryAddress,
  getTreasuryBalance,
  isTreasuryConfigured,
  refreshTreasuryStatus,
} from "./treasury.js";
import { LanguageProvider, useLanguage, STACK_EN, STACK_ES } from "./i18n.jsx";
import {
  loadContacts,
  addContact,
  updateContact,
  removeContact,
  findByAlias,
  resolveRecipient,
  recipientCandidates,
  searchContacts,
  validateContact,
} from "./contacts.js";
import { loadTransactions, addTransaction, mergeByHash, activityStatusKey, activityRefreshInterval } from "./transactions.js";
import { parsePayUrl, slugifyAlias } from "./payQr.js";

// ————————————————————————————————————————————————
// MidatoPay × Solana — Pagos por voz
// Login con email o teléfono (Privy) → wallet embebida Solana.
// Transferencias reales de USDC (SPL) en Solana Devnet.
// ————————————————————————————————————————————————

const arsStorageKey = (address) => `mp_ars_balance_${address || ""}`;

function loadArsBalance(address) {
  if (!address || SOLANA.cluster !== "devnet") return 0;
  try {
    const raw = localStorage.getItem(arsStorageKey(address));
    const n = Number(raw);
    return Number.isFinite(n) && n > 0 ? n : 0;
  } catch {
    return 0;
  }
}

function persistArsBalance(address, amount) {
  if (!address) return;
  try {
    localStorage.setItem(arsStorageKey(address), String(Math.max(0, Number(amount) || 0)));
  } catch {
    /* ignore */
  }
}

// ————— design tokens (MidatoPay) —————
const C = {
  bg: "#F7F7F9",
  card: "#FFFFFF",
  ink: "#16161A",
  mut: "#7A7A85",
  line: "#ECECF0",
  orange: "#FF5A00",
  orangeSoft: "#FFEADF",
  violet: "#5C4CC7",
  violetSoft: "#ECEAFA",
  green: "#21B95B",
  red: "#E4483D",
};

/** Paleta del cliente externo (otra “app”, sin naranja MidatoPay). */
const G = {
  accent: "#5B4DB7",
  soft: "#EEEBF8",
  mid: "#7A6EC9",
  deep: "#4338A0",
};

// ————— util —————
const fmt = (n, d = 2, locale = "en-US") => Number(n).toLocaleString(locale, { minimumFractionDigits: d, maximumFractionDigits: d });
const fmt0 = (n, locale = "en-US") => Number(n).toLocaleString(locale, { maximumFractionDigits: 0 });
/** Montos ARS siempre en formato argentino: 32.940,00 */
const fmtArs = (n) =>
  Number(n).toLocaleString("es-AR", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
const short = (a) => (a ? a.slice(0, 4) + "…" + a.slice(-4) : "—");

/** USDC → ARS con cotización Chainlink (ARS por 1 USDC). Tolera saldo 0. */
function usdcBalanceToArs(usdcAmount, arsPerUsdc) {
  const usdc = Number(usdcAmount);
  const rate = Number(arsPerUsdc);
  if (!Number.isFinite(usdc) || usdc < 0) return null;
  if (!Number.isFinite(rate) || rate <= 0) return null;
  if (usdc === 0) return 0;
  try {
    return usdcToArs(usdc, rate);
  } catch {
    return null;
  }
}

function localParse(text, lang) {
  const t = text.toLowerCase();
  const chargeRe = lang === "en" ? /(charge|collect)/ : /(cobr)/;
  const sendRe = lang === "en" ? /(send|transfer|pay)/ : /(envi|mand|transfer|pag)/;
  const intent = chargeRe.test(t) ? "charge" : sendRe.test(t) ? "send" : "unknown";
  if (intent === "unknown") return { intent };

  const numMatch = t.replace(/\./g, "").match(/(\d+(?:[.,]\d+)?)/);
  const amount = numMatch ? parseFloat(numMatch[1].replace(",", ".")) : null;
  const defaultCurrency = intent === "charge" ? "ARS" : "USDC";
  const currency = /peso|ars/.test(t) ? "ARS" : defaultCurrency;

  if (intent === "charge") return { intent, amount, currency, recipient: null };

  let recipient = null;
  const recRe = lang === "en" ? /\bto\s+([a-záéíóúñ]+)/ : /\ba\s+([a-záéíóúñ]+)/;
  const m = t.match(recRe);
  if (m) recipient = m[1];
  return { intent, amount, currency, recipient };
}

async function claudeParse(text, lang, aliases, token) {
  if (!token) throw new Error("no-key");
  const res = await fetch("/parse-intent", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${token}`,
    },
    body: JSON.stringify({ text, lang, aliases }),
  });
  const data = await res.json().catch(() => ({}));
  if (res.status === 503 || data.error === "no-key") throw new Error("no-key");
  if (!res.ok) throw new Error(data.error || `parse_${res.status}`);
  return data.intent;
}

// ————— primitivos de UI —————
function Card({ children, style, onClick, className }) {
  return (
    <div
      onClick={onClick}
      className={className}
      style={{
        background: C.bg,
        borderRadius: 22,
        padding: 20,
        boxShadow: "none",
        ...style,
      }}
    >
      {children}
    </div>
  );
}

const btnOrange = {
  background: C.orange,
  color: "#fff",
  border: "none",
  borderRadius: 14,
  padding: "16px 20px",
  fontSize: 16,
  fontWeight: 700,
  cursor: "pointer",
  width: "100%",
  fontFamily: "inherit",
};
const btnOutline = {
  background: "transparent",
  color: C.orange,
  border: `1.5px solid ${C.orange}`,
  borderRadius: 14,
  padding: "16px 20px",
  fontSize: 16,
  fontWeight: 700,
  cursor: "pointer",
  width: "100%",
  fontFamily: "inherit",
};

function CircleAction({ icon, label, onClick, background }) {
  return (
    <button
      onClick={onClick}
      style={{ background: "none", border: "none", cursor: "pointer", display: "flex", flexDirection: "column", alignItems: "center", gap: 8, flex: 1, fontFamily: "inherit", padding: 0, minWidth: 0 }}
    >
      <div
        style={{
          width: 54,
          height: 54,
          borderRadius: "50%",
          background: background || C.orange,
          display: "grid",
          placeItems: "center",
          color: "#fff",
          flexShrink: 0,
        }}
      >
        {icon}
      </div>
      <span style={{ fontSize: 12, fontWeight: 600, color: C.mut, textAlign: "center", lineHeight: 1.2 }}>{label}</span>
    </button>
  );
}

const IconArrowDown = ({ size = 22 }) => (
  <svg width={size} height={size} viewBox="0 0 24 24" fill="none" aria-hidden>
    <path d="M12 5v14M5 12l7 7 7-7" stroke="currentColor" strokeWidth="2.4" strokeLinecap="round" strokeLinejoin="round" />
  </svg>
);

const IconArrowUp = ({ size = 22 }) => (
  <svg width={size} height={size} viewBox="0 0 24 24" fill="none" aria-hidden>
    <path d="M12 19V5M5 12l7-7 7 7" stroke="currentColor" strokeWidth="2.4" strokeLinecap="round" strokeLinejoin="round" />
  </svg>
);

const IconSwap = ({ size = 22 }) => (
  <svg width={size} height={size} viewBox="0 0 24 24" fill="none" aria-hidden>
    <path d="M7 8h14M17 4l4 4-4 4M17 16H3M7 20l-4-4 4-4" stroke="currentColor" strokeWidth="2.4" strokeLinecap="round" strokeLinejoin="round" />
  </svg>
);

const IconEye = ({ size = 22, crossed = false }) => (
  <svg width={size} height={size} viewBox="0 0 24 24" fill="none" aria-hidden>
    <path
      d="M2 12s3.5-7 10-7 10 7 10 7-3.5 7-10 7S2 12 2 12Z"
      stroke="currentColor"
      strokeWidth="1.8"
      strokeLinejoin="round"
    />
    <circle cx="12" cy="12" r="3" stroke="currentColor" strokeWidth="1.8" />
    {crossed && <path d="M4 4l16 16" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" />}
  </svg>
);

const IconArFlag = ({ size = 18 }) => (
  <svg width={size} height={size} viewBox="0 0 24 24" aria-hidden>
    <circle cx="12" cy="12" r="12" fill="#74ACDF" />
    <rect x="0" y="8" width="24" height="8" fill="#fff" />
    <circle cx="12" cy="12" r="2.6" fill="#F6B40E" />
  </svg>
);

const IconHome = ({ size = 22 }) => (
  <svg width={size} height={size} viewBox="0 0 24 24" fill="none" aria-hidden>
    <path d="M4 10.5 12 4l8 6.5V20a1 1 0 0 1-1 1h-5.2v-6.2H10.2V21H5a1 1 0 0 1-1-1v-9.5Z" stroke="currentColor" strokeWidth="1.8" strokeLinejoin="round" />
  </svg>
);

const IconActivity = ({ size = 22 }) => (
  <svg width={size} height={size} viewBox="0 0 24 24" fill="none" aria-hidden>
    <path d="M5 7h14M5 12h14M5 17h14" stroke="currentColor" strokeWidth="1.9" strokeLinecap="round" />
  </svg>
);

const IconStack = ({ size = 22 }) => (
  <svg width={size} height={size} viewBox="0 0 24 24" fill="none" aria-hidden>
    <rect x="4" y="5" width="7" height="14" rx="1.6" stroke="currentColor" strokeWidth="1.8" />
    <rect x="13" y="5" width="7" height="14" rx="1.6" stroke="currentColor" strokeWidth="1.8" />
  </svg>
);

const IconContacts = ({ size = 22 }) => (
  <svg width={size} height={size} viewBox="0 0 24 24" fill="none" aria-hidden>
    <path d="M7 4.5h11.5A1.5 1.5 0 0 1 20 6v12a1.5 1.5 0 0 1-1.5 1.5H7" stroke="currentColor" strokeWidth="1.8" strokeLinejoin="round" />
    <path d="M7 4.5A2.5 2.5 0 0 0 4.5 7v10A2.5 2.5 0 0 0 7 19.5" stroke="currentColor" strokeWidth="1.8" />
    <rect x="9.5" y="8" width="7" height="5.5" rx="1" stroke="currentColor" strokeWidth="1.5" />
    <path d="M10.5 16.5h5" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" />
  </svg>
);

const IconProfile = ({ size = 22 }) => (
  <svg width={size} height={size} viewBox="0 0 24 24" fill="none" aria-hidden>
    <circle cx="12" cy="8" r="3.5" stroke="currentColor" strokeWidth="1.8" />
    <path d="M5.5 19.5c1.6-3.2 4-4.8 6.5-4.8s4.9 1.6 6.5 4.8" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" />
  </svg>
);

const IconMic = ({ size = 26 }) => (
  <svg width={size} height={size} viewBox="0 0 24 24" fill="none" aria-hidden>
    <rect x="9" y="3.5" width="6" height="11" rx="3" stroke="currentColor" strokeWidth="1.9" />
    <path d="M6.5 11.5a5.5 5.5 0 0 0 11 0M12 17v3.5M9 20.5h6" stroke="currentColor" strokeWidth="1.9" strokeLinecap="round" />
  </svg>
);

const IconFaucet = ({ size = 20 }) => (
  <svg width={size} height={size} viewBox="0 0 24 24" fill="none" aria-hidden>
    <path d="M8 4h8M12 4v3M7 10h10a2 2 0 0 1 2 2v2H5v-2a2 2 0 0 1 2-2Z" stroke="currentColor" strokeWidth="1.8" strokeLinejoin="round" />
    <path d="M12 14v3.5a2.5 2.5 0 0 0 5 0V16" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" />
  </svg>
);

const IconSearch = ({ size = 20 }) => (
  <svg width={size} height={size} viewBox="0 0 24 24" fill="none" aria-hidden>
    <circle cx="11" cy="11" r="6.5" stroke="currentColor" strokeWidth="1.8" />
    <path d="M16.5 16.5 21 21" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" />
  </svg>
);

const IconGlobe = ({ size = 20 }) => (
  <svg width={size} height={size} viewBox="0 0 24 24" fill="none" aria-hidden>
    <circle cx="12" cy="12" r="9" stroke="currentColor" strokeWidth="1.8" />
    <path d="M3 12h18M12 3c2.8 2.6 4.2 5.7 4.2 9s-1.4 6.4-4.2 9c-2.8-2.6-4.2-5.7-4.2-9S9.2 5.6 12 3Z" stroke="currentColor" strokeWidth="1.8" />
  </svg>
);

const IconLogout = ({ size = 20 }) => (
  <svg width={size} height={size} viewBox="0 0 24 24" fill="none" aria-hidden>
    <path d="M10 4H6a2 2 0 0 0-2 2v12a2 2 0 0 0 2 2h4" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" />
    <path d="M14 8l4 4-4 4M18 12H9" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" />
  </svg>
);

const IconChevron = ({ size = 18 }) => (
  <svg width={size} height={size} viewBox="0 0 24 24" fill="none" aria-hidden>
    <path d="M9 5l7 7-7 7" stroke="currentColor" strokeWidth="1.9" strokeLinecap="round" strokeLinejoin="round" />
  </svg>
);

const IconChevronDown = ({ size = 16, up = false }) => (
  <svg
    width={size}
    height={size}
    viewBox="0 0 24 24"
    fill="none"
    aria-hidden
    style={{
      display: "block",
      transform: up ? "rotate(180deg)" : "none",
      transition: "transform .15s ease",
    }}
  >
    <path d="M6 9l6 6 6-6" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" />
  </svg>
);

const IconQrCode = ({ size = 22 }) => (
  <svg width={size} height={size} viewBox="0 0 24 24" fill="none" aria-hidden>
    <rect x="3" y="3" width="7" height="7" rx="1.2" stroke="currentColor" strokeWidth="2" />
    <rect x="14" y="3" width="7" height="7" rx="1.2" stroke="currentColor" strokeWidth="2" />
    <rect x="3" y="14" width="7" height="7" rx="1.2" stroke="currentColor" strokeWidth="2" />
    <path d="M14 14h3v3h-3zM19 14v3M14 19h3M17 19h3v3M19 21v-2" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" />
  </svg>
);

const IconFlash = ({ size = 22 }) => (
  <svg width={size} height={size} viewBox="0 0 24 24" fill="none" aria-hidden>
    <path d="M9 3.5h6l1.8 4.2H7.2L9 3.5Z" stroke="currentColor" strokeWidth="1.7" strokeLinejoin="round" />
    <rect x="8" y="7.5" width="8" height="11" rx="2" stroke="currentColor" strokeWidth="1.7" />
    <path d="M12 11.5v3" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" />
  </svg>
);

const IconCopy = ({ size = 18 }) => (
  <svg width={size} height={size} viewBox="0 0 24 24" fill="none" aria-hidden>
    <rect x="8" y="8" width="13" height="13" rx="2" stroke="currentColor" strokeWidth="2" />
    <path d="M16 8V5a2 2 0 0 0-2-2H5a2 2 0 0 0-2 2v9a2 2 0 0 0 2 2h3" stroke="currentColor" strokeWidth="2" />
  </svg>
);

const GRAD_COBRAR = "linear-gradient(180deg, #fe6c1c, #fe6c1c, #fe6c1c, #ffb58d, #ffb58d)";
const GRAD_CONVERTIR = "radial-gradient(circle at 0% 0%, #ffb58d, #fe6c1c, #fe6c1c, #ffb58d, #fe6c1c)";
const GRAD_PAGAR = "linear-gradient(180deg, #ffb58d, #ffb58d, #fe6c1c, #fe6c1c, #fe6c1c)";
const GRAD_ENVIAR = "linear-gradient(180deg, #fe6c1c, #fe6c1c, #e85a10, #ffb58d)";

function NavButton({ active, icon, label, onClick, accent = "#fe6c1c" }) {
  const glow = accent === "#fe6c1c" ? "rgba(254,108,28,.35)" : "rgba(91,77,183,.35)";
  return (
    <button
      onClick={onClick}
      style={{
        flex: 1,
        background: "none",
        border: "none",
        cursor: "pointer",
        display: "flex",
        flexDirection: "column",
        alignItems: "center",
        gap: 4,
        fontFamily: "inherit",
        padding: "4px 0 0",
        color: active ? accent : "#8A8A96",
        transition: "color .2s ease, transform .15s ease",
        transform: active ? "translateY(-1px)" : "none",
      }}
    >
      <span
        style={{
          display: "grid",
          placeItems: "center",
          width: 36,
          height: 28,
          filter: active ? `drop-shadow(0 4px 10px ${glow})` : "none",
        }}
      >
        {icon}
      </span>
      <span style={{ fontSize: 10, fontWeight: 600, letterSpacing: 0.1 }}>{label}</span>
    </button>
  );
}

// ————— Marca —————
function Mark({ size = 44, style }) {
  return (
    <img
      src="/logo.png"
      alt="MidatoPay"
      width={size}
      height={size}
      style={{ display: "block", width: size, height: size, ...style }}
    />
  );
}

function Wordmark({ size = 30 }) {
  return (
    <div style={{ fontSize: size, fontWeight: 700, letterSpacing: -0.6, color: "#6A6A72", lineHeight: 1 }}>
      Midato<span style={{ color: C.orange }}>Pay</span>
    </div>
  );
}

function Logo({ size = 44 }) {
  return <Mark size={size} />;
}

// ————— Selector de idioma —————
function LangToggle({ style, variant = "default" }) {
  const { lang, setLang } = useLanguage();
  const subtle = variant === "subtle";
  const pill = (id, label) => ({
    background: lang === id
      ? (subtle ? "rgba(255,255,255,0.18)" : C.ink)
      : "transparent",
    color: lang === id
      ? "#fff"
      : (subtle ? "rgba(255,255,255,0.55)" : C.mut),
    border: "none",
    borderRadius: 20,
    padding: subtle ? "5px 10px" : "6px 13px",
    fontSize: subtle ? 11.5 : 12.5,
    fontWeight: 700,
    cursor: "pointer",
    fontFamily: "inherit",
  });
  return (
    <div
      style={{
        display: "flex",
        gap: 2,
        background: subtle ? "rgba(0,0,0,0.28)" : C.bg,
        borderRadius: 22,
        padding: subtle ? 2 : 3,
        border: subtle ? "1px solid rgba(255,255,255,0.18)" : "none",
        backdropFilter: subtle ? "blur(8px)" : undefined,
        WebkitBackdropFilter: subtle ? "blur(8px)" : undefined,
        ...style,
      }}
    >
      <button onClick={() => setLang("en")} style={pill("en")} aria-pressed={lang === "en"}>
        EN
      </button>
      <button onClick={() => setLang("es")} style={pill("es")} aria-pressed={lang === "es"}>
        ES
      </button>
    </div>
  );
}

// ————— Login —————
/** Slide-to-unlock CTA (deslizar el knob hasta el final). */
function SlideToStart({ label, onComplete }) {
  const trackRef = useRef(null);
  const draggingRef = useRef(false);
  const startXRef = useRef(0);
  const originRef = useRef(0);
  const maxRef = useRef(0);
  const doneRef = useRef(false);
  const [x, setX] = useState(0);
  const [done, setDone] = useState(false);
  const [dragging, setDragging] = useState(false);

  const measure = () => {
    const track = trackRef.current;
    if (!track) return 0;
    const knob = 44;
    const pad = 4;
    return Math.max(0, track.clientWidth - knob - pad * 2);
  };

  const finish = () => {
    if (doneRef.current) return;
    doneRef.current = true;
    setDone(true);
    setDragging(false);
    setX(maxRef.current);
    onComplete?.();
  };

  const onPointerDown = (e) => {
    if (doneRef.current) return;
    e.preventDefault();
    maxRef.current = measure();
    draggingRef.current = true;
    setDragging(true);
    startXRef.current = e.clientX;
    originRef.current = x;
    e.currentTarget.setPointerCapture?.(e.pointerId);
  };

  const onPointerMove = (e) => {
    if (!draggingRef.current || doneRef.current) return;
    const dx = e.clientX - startXRef.current;
    const next = Math.min(maxRef.current, Math.max(0, originRef.current + dx));
    setX(next);
  };

  const xRef = useRef(0);
  xRef.current = x;

  const handleUp = () => {
    if (!draggingRef.current) return;
    draggingRef.current = false;
    setDragging(false);
    if (doneRef.current) return;
    const cur = xRef.current;
    const threshold = maxRef.current * 0.82;
    if (cur >= threshold) finish();
    else setX(0);
  };

  // Keyboard fallback: Enter / ArrowRight completes
  const onKeyDown = (e) => {
    if (doneRef.current) return;
    if (e.key === "Enter" || e.key === " " || e.key === "ArrowRight") {
      e.preventDefault();
      maxRef.current = measure();
      finish();
    }
  };

  const progress = maxRef.current > 0 ? x / maxRef.current : 0;

  return (
    <div
      ref={trackRef}
      className={`mp-onboard-slide-cta${done ? " is-done" : ""}${dragging ? " is-dragging" : ""}`}
      style={{ "--mp-slide-p": progress }}
      role="slider"
      aria-valuemin={0}
      aria-valuemax={100}
      aria-valuenow={done ? 100 : Math.round(progress * 100)}
      aria-label={label}
      tabIndex={0}
      onKeyDown={onKeyDown}
    >
      <div className="mp-onboard-slide-fill" style={{ width: x + 44 }} aria-hidden />
      <div className="mp-onboard-slide-label">{label}</div>
      <div className="mp-onboard-slide-chevs" aria-hidden>
        <svg viewBox="0 0 10 16" fill="none">
          <path d="M2 2l6 6-6 6" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round" />
        </svg>
        <svg viewBox="0 0 10 16" fill="none">
          <path d="M2 2l6 6-6 6" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round" />
        </svg>
        <svg viewBox="0 0 10 16" fill="none">
          <path d="M2 2l6 6-6 6" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round" />
        </svg>
      </div>
      <button
        type="button"
        className={`mp-onboard-slide-knob${dragging ? " is-dragging" : ""}`}
        style={{ transform: `translateX(${x}px) scale(${dragging || done ? 1.06 : 1})` }}
        aria-hidden
        tabIndex={-1}
        onPointerDown={onPointerDown}
        onPointerMove={onPointerMove}
        onPointerUp={handleUp}
        onPointerCancel={handleUp}
      >
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round">
          <path d="M5 12h14" />
          <path d="M13 6l6 6-6 6" />
        </svg>
      </button>
    </div>
  );
}

/** Entrada auth: splash → Get Started (slide) → carrusel → Login. Siempre desde splash si no hay sesión. */
function AuthEntry({ onLogin, ready }) {
  const { t } = useLanguage();
  const [phase, setPhase] = useState("splash");
  // splash | welcome | slides
  const [slide, setSlide] = useState(0);
  const slideCount = 5;
  const slideImages = ["/slides/1-slide.png", "/slides/2-slide.png", "/slides/3-slide.png", "/slides/4-slide.png", "/slides/5-slide.png"];
  const pausedRef = useRef(false);
  const swipeXRef = useRef(null);

  useEffect(() => {
    if (phase !== "splash") return undefined;
    const id = setTimeout(() => setPhase("welcome"), 3000);
    return () => clearTimeout(id);
  }, [phase]);

  useEffect(() => {
    if (phase !== "slides") return undefined;
    const id = setInterval(() => {
      if (pausedRef.current) return;
      setSlide((s) => (s + 1) % slideCount);
    }, 4500);
    return () => clearInterval(id);
  }, [phase, slideCount]);

  const startOnboarding = () => {
    setPhase("slides");
    setSlide(0);
  };

  const onSlidePointerDown = (e) => {
    pausedRef.current = true;
    swipeXRef.current = e.clientX;
  };

  const onSlidePointerUp = (e) => {
    pausedRef.current = false;
    const start = swipeXRef.current;
    swipeXRef.current = null;
    if (start == null) return;
    const dx = e.clientX - start;
    if (dx > 48) setSlide((s) => (s - 1 + slideCount) % slideCount);
    else if (dx < -48) setSlide((s) => (s + 1) % slideCount);
  };

  const authButtons = (
    <div className="mp-onboard-auth">
      <button onClick={onLogin} disabled={!ready} style={{ ...btnOrange, background: C.orange, boxShadow: "none", opacity: ready ? 1 : 0.5 }}>
        {ready ? t("login.loginBtn") : t("login.loadingBtn")}
      </button>
      <button
        type="button"
        className="mp-onboard-create"
        onClick={onLogin}
        disabled={!ready}
      >
        {t("login.createAccountBtn")}
      </button>
    </div>
  );

  if (phase === "splash") {
    return (
      <div className="mp-stage">
        <div className="mp-device mp-onboard" style={{ background: C.orange }}>
          <div className="mp-onboard-splash">
            <img src="/logo/logo.png" alt="MidatoPay" className="mp-onboard-splash-logo" />
          </div>
        </div>
      </div>
    );
  }

  if (phase === "welcome") {
    return (
      <div className="mp-stage">
        <div className="mp-device mp-onboard mp-onboard-welcome">
          <div className="mp-onboard-shell">
            <div className="mp-onboard-top">
              <div className="mp-onboard-brand">Midato<span>Pay</span></div>
              <LangToggle />
            </div>
            <div className="mp-onboard-hero" aria-hidden>
              <img src="/inicio-app/gato-solo3d.png" alt="" />
            </div>
            <div className="mp-onboard-welcome-body">
              <div className="mp-onboard-eyebrow">{t("onboarding.welcomeEyebrow")}</div>
              <h1 className="mp-onboard-title">
                {String(t("onboarding.welcomeTitle")).split("\n").map((line) => (
                  <span key={line} className="mp-onboard-title-line">{line}</span>
                ))}
              </h1>
            </div>
            <SlideToStart label={t("onboarding.getStarted")} onComplete={startOnboarding} />
          </div>
        </div>
      </div>
    );
  }

  // slides
  const slideKey = `onboarding.slides.${slide}`;
  const before = t(`${slideKey}.before`);
  const highlight = t(`${slideKey}.highlight`);
  const after = t(`${slideKey}.after`);

  return (
    <div className="mp-stage">
      <div className="mp-device mp-onboard">
        <div
          className="mp-onboard-shell"
          onPointerDown={onSlidePointerDown}
          onPointerUp={onSlidePointerUp}
          onPointerCancel={() => { pausedRef.current = false; swipeXRef.current = null; }}
        >
          <div className="mp-onboard-top mp-onboard-top-slides">
            <LangToggle variant="subtle" />
          </div>

          <div className="mp-onboard-slide" key={slide}>
            <div className={`mp-onboard-slide-visual${slide === slideCount - 1 ? " is-last" : ""}`} aria-hidden>
              {slideImages[slide] ? <img src={slideImages[slide]} alt="" /> : null}
            </div>
            <h1 className="mp-onboard-title">
              {before}
              {highlight ? <span className="mp-onboard-hi">{highlight}</span> : null}
              {after}
            </h1>
          </div>

          <div className="mp-onboard-dots" role="tablist" aria-label={t("onboarding.progressAria")}>
            {Array.from({ length: slideCount }, (_, i) => (
              <button
                key={i}
                type="button"
                aria-label={t("onboarding.slideAria", i + 1)}
                aria-current={i === slide ? "true" : undefined}
                className={`mp-onboard-dot${i === slide ? " is-active" : ""}`}
                onClick={() => setSlide(i)}
              />
            ))}
          </div>

          {authButtons}
        </div>
      </div>
    </div>
  );
}

/** Nombre del comercio embebido en el QR (vacío si era el label genérico). */
function guestMerchantName(who) {
  const w = String(who || "").trim();
  if (!w || /^your commerce$/i.test(w) || /^tu comercio$/i.test(w)) return "";
  return w;
}

// ————— Cliente demo (sin Privy): saldo ARS vía recaudadora + FAB QR —————
function GuestApp({ onExit, initialScan = null }) {
  const { t, locale } = useLanguage();
  // home | scan | link | confirm
  const [tab, setTab] = useState(initialScan ? "confirm" : "home");
  const [fxRate, setFxRate] = useState(FALLBACK_FX_ARS_USD);
  const [treasuryUsdc, setTreasuryUsdc] = useState(null);
  const [receipt, setReceipt] = useState(null);
  const [qr, setQr] = useState(initialScan);
  const [scanErr, setScanErr] = useState(""); // "" | invalid | CAMERA:...
  const [manualLink, setManualLink] = useState("");
  const [phase, setPhase] = useState("form");
  const [errMsg, setErrMsg] = useState("");
  const [torchOn, setTorchOn] = useState(false);

  const refreshTreasury = useCallback(async () => {
    try {
      const [bal, rate] = await Promise.all([getTreasuryBalance(), getArsPerUsdc()]);
      setTreasuryUsdc(bal);
      setFxRate(rate);
    } catch {
      /* RPC puede fallar */
    }
  }, []);

  useEffect(() => {
    refreshTreasury();
    const id = setInterval(refreshTreasury, 45_000);
    return () => clearInterval(id);
  }, [refreshTreasury]);

  const availableArs = treasuryUsdc == null ? null : usdcBalanceToArs(treasuryUsdc, fxRate);
  const quote = qr ? quoteArsToUsdc(qr.ars, fxRate) : null;

  const openScan = () => {
    setTab("scan");
    setQr(null);
    setScanErr("");
    setErrMsg("");
    setPhase("form");
    setManualLink("");
    setTorchOn(false);
  };

  const openLink = () => {
    setTab("link");
    setManualLink("");
    setScanErr("");
    setErrMsg("");
  };

  const goHome = () => {
    setTab("home");
    setQr(null);
    setScanErr("");
    setErrMsg("");
    setPhase("form");
    setManualLink("");
  };

  const applyDecoded = (raw) => {
    const parsed = parsePayUrl(raw);
    if (!parsed) {
      setScanErr("invalid");
      setTab("scan");
      setQr(null);
      return;
    }
    setScanErr("");
    setQr(parsed);
    setPhase("form");
    setErrMsg("");
    setTab("confirm");
  };

  const submit = async () => {
    setErrMsg("");
    setPhase("working");
    try {
      // Payouts de recaudadora firman en el server y requieren sesión Privy.
      throw new Error(t("guest.loginRequired"));
    } catch (e) {
      setErrMsg(String(e?.message || e));
      setPhase("error");
    }
  };

  const shell = (children, { pad = true, nav = true } = {}) => (
    <div className="mp-stage">
      <div className={`mp-device mp-guest${nav ? "" : " mp-no-nav"}`}>
        <div className="mp-scroll" style={{ padding: pad ? "22px 18px 24px" : 0 }}>{children}</div>
        {nav && (
          <nav className="mp-nav">
            <NavButton active={tab === "home"} icon={<IconHome />} label={t("nav.home")} onClick={goHome} accent={G.accent} />
            <div style={{ flex: 1 }} aria-hidden="true" />
            <div style={{ width: 64, flexShrink: 0 }} aria-hidden="true" />
            <div style={{ flex: 1 }} aria-hidden="true" />
            <NavButton active={false} icon={<IconLogout />} label={t("guest.exit")} onClick={onExit} accent={G.accent} />
            <button
              type="button"
              onClick={openScan}
              className="mp-fab"
              aria-label={t("guest.scanCta")}
            >
              <span className="mp-fab-shine" aria-hidden />
              <IconQrCode size={26} />
            </button>
          </nav>
        )}
      </div>
    </div>
  );

  if (receipt) {
    return shell(
      <Success
        receipt={receipt}
        hideFx
        onClose={(next) => {
          setReceipt(null);
          if (next === "pay" || next === "scan") openScan();
          else setTab("home");
        }}
      />
    );
  }

  if (tab === "scan" && scanErr === "invalid" && !qr) {
    return shell(
      <div style={{ display: "flex", flexDirection: "column", minHeight: "100%", padding: "28px 22px 28px", boxSizing: "border-box", background: C.card }}>
        <div style={{ flex: 1, display: "flex", flexDirection: "column", alignItems: "center", justifyContent: "center", textAlign: "center", gap: 12 }}>
          <div style={{ width: 88, height: 88, borderRadius: 22, background: "#FDECEA", display: "grid", placeItems: "center", color: C.red }}>
            <IconQrCode size={44} />
          </div>
          <div style={{ fontSize: 22, fontWeight: 700, color: C.ink, marginTop: 8 }}>{t("guest.invalidTitle")}</div>
          <div style={{ fontSize: 15, color: C.mut, lineHeight: 1.45, maxWidth: 280 }}>{t("guest.invalidBody")}</div>
        </div>
        <div style={{ display: "flex", flexDirection: "column", gap: 10 }}>
          <button type="button" onClick={() => { setScanErr(""); setTab("scan"); }} style={{ ...btnOrange, background: C.ink, boxShadow: "none" }}>
            {t("guest.scanAgain")}
          </button>
          <button type="button" onClick={goHome} style={{ ...btnOutline, borderColor: C.line, color: C.ink, background: C.bg }}>
            {t("guest.goHome")}
          </button>
        </div>
      </div>,
      { pad: false, nav: false }
    );
  }

  if (tab === "link") {
    return shell(
      <div style={{ display: "flex", flexDirection: "column", minHeight: "100%", padding: "22px 22px 28px", boxSizing: "border-box", background: C.card }}>
        <button type="button" onClick={openScan} aria-label={t("guest.backHome")} style={{ alignSelf: "flex-start", width: 40, height: 40, borderRadius: "50%", border: "none", background: C.bg, color: C.ink, fontSize: 26, lineHeight: 1, cursor: "pointer", fontFamily: "inherit", marginBottom: 18 }}>
          ‹
        </button>
        <h2 style={{ fontSize: 26, fontWeight: 700, color: C.ink, margin: "0 0 8px", letterSpacing: -0.4 }}>{t("guest.useLinkTitle")}</h2>
        <p style={{ fontSize: 15, color: C.mut, lineHeight: 1.45, margin: "0 0 20px" }}>{t("guest.useLinkBody")}</p>
        <textarea
          value={manualLink}
          onChange={(e) => setManualLink(e.target.value)}
          placeholder={t("pay.scanLinkPlaceholder")}
          rows={4}
          style={{ width: "100%", boxSizing: "border-box", border: `1px solid ${C.line}`, borderRadius: 16, padding: "14px 16px", fontSize: 15, fontFamily: "inherit", outline: "none", resize: "vertical", color: C.ink, background: C.bg }}
        />
        <div style={{ marginTop: "auto", paddingTop: 24, display: "flex", flexDirection: "column", gap: 10 }}>
          <button
            type="button"
            onClick={() => applyDecoded(manualLink)}
            disabled={!manualLink.trim()}
            style={{ ...btnOrange, background: G.accent, boxShadow: "none", opacity: manualLink.trim() ? 1 : 0.5 }}
          >
            {t("guest.useLinkCta")}
          </button>
          <button type="button" onClick={openScan} style={{ ...btnOutline, border: "none", color: C.mut }}>
            {t("guest.scanAgain")}
          </button>
        </div>
      </div>,
      { pad: false, nav: false }
    );
  }

  if (tab === "scan" && !qr) {
    return shell(
      <div className="mp-guest-scan">
        <div className="mp-guest-scan-top">
          <button type="button" onClick={goHome} className="mp-guest-scan-iconbtn" aria-label={t("guest.backHome")}>‹</button>
        </div>
        {!scanErr.startsWith("CAMERA:") ? (
          <div className="mp-guest-scan-stage">
            <QrScanner
              fill
              torchOn={torchOn}
              onDecode={applyDecoded}
              onCameraError={() => setScanErr("CAMERA:" + t("pay.scanCameraError"))}
            />
            <div className="mp-guest-scan-frame" aria-hidden />
            <div className="mp-guest-scan-laser" aria-hidden />
          </div>
        ) : (
          <div style={{ position: "absolute", inset: 0, display: "grid", placeItems: "center", padding: 24, color: "#fff", textAlign: "center", background: "#0b0b0d" }}>
            {scanErr.replace(/^CAMERA:/, "")}
          </div>
        )}
        <div className="mp-guest-scan-bottom">
          <button
            type="button"
            onClick={() => setTorchOn((v) => !v)}
            className={`mp-guest-scan-flash${torchOn ? " is-on" : ""}`}
            aria-label={t("guest.flash")}
            aria-pressed={torchOn}
          >
            <IconFlash size={24} />
          </button>
          <button type="button" onClick={openLink} style={{ ...btnOrange, background: "#fff", color: C.ink, boxShadow: "none" }}>
            {t("guest.useLink")}
          </button>
        </div>
      </div>,
      { pad: false, nav: false }
    );
  }

  if (tab === "confirm" && qr) {
    const merchantName = guestMerchantName(qr.who);
    return shell(
      <div style={{ display: "flex", flexDirection: "column", gap: 16 }}>
        <h2 style={{ fontSize: 26, fontWeight: 700, color: C.ink, margin: 0, letterSpacing: -0.4 }}>{t("guest.scanTitle")}</h2>
        <Card style={{ display: "flex", flexDirection: "column", gap: 14 }}>
          <div style={{ fontSize: 13, color: C.mut }}>{t("guest.payToLabel")}</div>
          <div>
            <div style={{ fontSize: 15, fontWeight: 600, color: C.ink }}>{t("guest.merchant")}</div>
            {merchantName ? (
              <div style={{ fontSize: 20, fontWeight: 700, color: G.accent, marginTop: 2, letterSpacing: -0.3 }}>
                {merchantName}
              </div>
            ) : null}
          </div>
          <div style={{ display: "flex", justifyContent: "space-between", fontSize: 14.5, marginTop: 6 }}>
            <span style={{ color: C.mut }}>{t("guest.youPay")}</span>
            <span style={{ fontWeight: 700, color: C.ink }}>$ {fmtArs(qr.ars)}</span>
          </div>
          {(phase === "error" || errMsg) && phase !== "working" && (
            <div style={{ background: "#FDECEA", color: C.red, fontSize: 14, lineHeight: 1.5, borderRadius: 12, padding: "12px 14px" }}>{errMsg}</div>
          )}
          <button
            type="button"
            onClick={submit}
            disabled={phase === "working" || !quote}
            style={{ ...btnOrange, background: G.accent, boxShadow: "none", opacity: phase === "working" || !quote ? 0.5 : 1 }}
          >
            {phase === "working" ? t("guest.paying") : t("guest.confirmCta")}
          </button>
          <button type="button" onClick={openScan} style={{ ...btnOutline, border: "none", color: C.mut }}>
            {t("guest.scanAgain")}
          </button>
        </Card>
      </div>
    );
  }

  return shell(
    <div style={{ display: "flex", flexDirection: "column", gap: 16 }}>
      <div style={{ display: "flex", alignItems: "center", gap: 12 }}>
        <div
          aria-hidden
          style={{
            width: 44,
            height: 44,
            borderRadius: "50%",
            background: G.soft,
            color: G.accent,
            display: "grid",
            placeItems: "center",
            fontWeight: 700,
            fontSize: 18,
          }}
        >
          C
        </div>
        <div>
          <div style={{ fontSize: 15, color: C.mut }}>{t("home.greetingHi")}</div>
          <div style={{ fontSize: 22, fontWeight: 700, color: G.accent, letterSpacing: -0.3 }}>{t("guest.name")}</div>
        </div>
      </div>

      <Card>
        <div style={{ fontSize: 14, color: C.mut, fontWeight: 600 }}>{t("home.available")}</div>
        <div style={{ display: "flex", alignItems: "center", gap: 10, marginTop: 8 }}>
          <img
            src="/monedas/ars.png"
            alt="ARS"
            width={34}
            height={34}
            style={{ width: 34, height: 34, borderRadius: "50%", objectFit: "cover", display: "block", flexShrink: 0 }}
          />
          <div style={{ fontSize: 34, fontWeight: 700, color: C.ink, letterSpacing: -0.8, lineHeight: 1.1 }}>
            {availableArs == null ? "—" : `$ ${fmtArs(availableArs)}`}
          </div>
        </div>
      </Card>
    </div>
  );
}

// ————— Inicio —————
function Home({
  nombre, address, balance, arsBalance,
  txs, goCharge, goConvert, goPay, goSend, fxRate, onOpenTransfer,
}) {
  const { t, locale } = useLanguage();
  const [oculto, setOculto] = useState(false);
  // Available y Funds (USDC) en ARS: siempre USDC × cotización Chainlink (ARS por 1 USDC).
  const usdcInArs = balance === null ? null : usdcBalanceToArs(balance, fxRate);
  const availableArs = (arsBalance || 0) + (usdcInArs || 0);
  const pendingUsdc=txs.filter(tx=>tx.source==="mercadopago" && tx.settled===false && paymentReceived(tx))
    .reduce((sum,tx)=>sum+Number(tx.amt || 0),0);
  const initial = (nombre || "?").trim().charAt(0).toUpperCase() || "?";

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 16 }}>
      <div style={{ display: "flex", alignItems: "center", gap: 12 }}>
        <div
          aria-hidden
          style={{
            width: 44,
            height: 44,
            borderRadius: "50%",
            background: C.orangeSoft,
            color: "#fe6c1c",
            display: "grid",
            placeItems: "center",
            fontSize: 18,
            fontWeight: 700,
            flexShrink: 0,
            letterSpacing: 0,
          }}
        >
          {initial}
        </div>
        <div style={{ fontSize: 21, flex: 1, minWidth: 0, lineHeight: 1.2 }}>
          <span style={{ fontWeight: 500, color: C.mut }}>{t("home.greetingHi")} </span>
          <span style={{ fontWeight: 700, color: "#fe6c1c" }}>{nombre}</span>
        </div>
      </div>

      <Card>
        <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center" }}>
          <span style={{ fontSize: 15, fontWeight: 600, color: C.mut }}>{t("home.available")}</span>
          <div style={{ display: "flex", alignItems: "center", gap: 6 }}>
            <IconArFlag size={18} />
            <span style={{ fontSize: 15, fontWeight: 700, color: C.mut }}>ARS</span>
          </div>
        </div>
        <div style={{ display: "flex", alignItems: "center", gap: 12, marginTop: 6 }}>
          <div style={{ fontSize: 38, fontWeight: 700, letterSpacing: -1, color: C.ink }}>
            {oculto ? "$ ••••••" : `$ ${fmtArs(availableArs)}`}
          </div>
          <button
            onClick={() => setOculto(!oculto)}
            aria-label={oculto ? "Show" : "Hide"}
            style={{
              background: "none",
              border: "none",
              cursor: "pointer",
              color: C.mut,
              display: "grid",
              placeItems: "center",
              padding: 4,
            }}
          >
            <IconEye crossed={oculto} />
          </button>
        </div>

        <div style={{ display: "flex", gap: 4, marginTop: 20 }}>
          <CircleAction icon={<IconArrowDown size={20} />} label={t("home.actionReceive")} onClick={goCharge} background={GRAD_COBRAR} />
          <CircleAction icon={<IconSwap size={20} />} label={t("home.actionConvert")} onClick={goConvert} background={GRAD_CONVERTIR} />
          <CircleAction icon={<IconQrCode size={20} />} label={t("home.actionPay")} onClick={goPay} background={GRAD_PAGAR} />
          <CircleAction icon={<IconArrowUp size={20} />} label={t("home.actionSend")} onClick={goSend} background={GRAD_ENVIAR} />
        </div>
      </Card>

      <Card>
        <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 14 }}>
          <span style={{ fontSize: 17, fontWeight: 700, color: C.ink }}>{t("home.fundsTitle")}</span>
          <a href={explorerAddressUrl(address)} target="_blank" rel="noreferrer" style={{ fontSize: 12, fontWeight: 700, color: C.orange, background: C.orangeSoft, padding: "5px 12px", borderRadius: 20, textDecoration: "none" }}>
            {t("home.viewAll")}
          </a>
        </div>
        <div style={{ display: "flex", alignItems: "center", gap: 12 }}>
          <img src="/monedas/usdc.png" alt="USDC" width={38} height={38} style={{ width: 38, height: 38, borderRadius: "50%", objectFit: "cover", display: "block", flexShrink: 0 }} />
          <div style={{ flex: 1, fontSize: 17, fontWeight: 700, color: C.ink }}>USDC</div>
          <div style={{ textAlign: "right" }}>
            <div style={{ fontSize: 17, fontWeight: 700, color: C.ink }}>{usdcInArs === null ? "—" : `$${fmtArs(usdcInArs)}`}</div>
            <div style={{ fontSize: 14, color: C.mut }}>{balance === null ? "" : `${fmt(balance, 2, locale)} USDC`}</div>
          </div>
        </div>
        {pendingUsdc>0 && <div style={{marginTop:12,fontSize:13,color:C.mut}}>{t("movs.pendingUsdc")}: {oculto?"••••••":fmt(pendingUsdc,6,locale)} USDC</div>}
        <div style={{ display: "flex", alignItems: "center", gap: 12, marginTop: 14, paddingTop: 14, borderTop: `1px solid ${C.line}` }}>
          <img src="/monedas/ars.png" alt="ARS" width={38} height={38} style={{ width: 38, height: 38, borderRadius: "50%", objectFit: "cover", display: "block", flexShrink: 0 }} />
          <div style={{ flex: 1, fontSize: 17, fontWeight: 700, color: C.ink }}>ARS</div>
          <div style={{ textAlign: "right" }}>
            <div style={{ fontSize: 17, fontWeight: 700, color: C.ink }}>{oculto ? "$ ••••••" : `$ ${fmtArs(arsBalance || 0)}`}</div>
          </div>
        </div>
        <div style={{ display: "flex", alignItems: "center", gap: 8, marginTop: 16, paddingTop: 14, borderTop: `1px solid ${C.line}` }}>
          <span style={{ color: C.violet, fontSize: 14 }}>ⓘ</span>
          <span style={{ fontSize: 13.5, color: C.violet, flex: 1 }}>{t("home.infoDigitalAssets")}</span>
        </div>
      </Card>

      <div
        style={{
          width: "100%",
          borderRadius: 22,
          overflow: "hidden",
          lineHeight: 0,
        }}
      >
        <img
          src="/banner/banner2.png"
          alt=""
          style={{
            display: "block",
            width: "100%",
            height: "auto",
          }}
        />
      </div>

      {SOLANA.cluster === "devnet" && balance !== null && balance < 0.5 && (
        <Card style={{ background: "#16161A", color: "#fff" }}>
          <div style={{ fontSize: 17, fontWeight: 700, lineHeight: 1.35 }}>{t("home.faucetCardTitle")}</div>
          <div style={{ fontSize: 13.5, opacity: 0.75, marginTop: 8, lineHeight: 1.5 }}>{t("home.faucetCardBody")}</div>
          <a href={SOLANA.faucet} target="_blank" rel="noreferrer" style={{ display: "inline-block", marginTop: 16, background: C.orange, color: "#fff", padding: "11px 22px", borderRadius: 12, fontSize: 14.5, fontWeight: 700, textDecoration: "none" }}>
            {t("home.faucetCardBtn")}
          </a>
        </Card>
      )}

      <div style={{ fontSize: 17, fontWeight: 700, color: C.ink, marginTop: 4 }}>{t("home.activityTitle")}</div>
      {txs.length === 0 ? (
        <Card style={{ fontSize: 14, color: C.mut, lineHeight: 1.55 }}>{t("home.activityEmpty")}</Card>
      ) : (
        txs.slice(0, 5).map((tx) => <TxCard key={tx.hash} tx={tx} compact onOpenTransfer={onOpenTransfer} />)
      )}
    </div>
  );
}

function AmountField({ label, value, onChange, placeholder, suffix, logo }) {
  return (
    <label style={{ display: "block" }}>
      <div style={{ fontSize: 13, fontWeight: 600, color: C.mut, marginBottom: 8 }}>{label}</div>
      <div style={{ display: "flex", alignItems: "center", gap: 10, background: C.card, borderRadius: 14, padding: "4px 14px", border: `1px solid ${C.line}` }}>
        <input
          value={value}
          onChange={(e) => onChange(e.target.value.replace(/[^\d.,]/g, "").replace(",", "."))}
          inputMode="decimal"
          placeholder={placeholder}
          style={{ flex: 1, border: "none", background: "transparent", fontSize: 22, fontWeight: 700, color: C.ink, padding: "14px 0", fontFamily: "inherit", outline: "none", minWidth: 0 }}
        />
        <div style={{ display: "flex", alignItems: "center", gap: 6, flexShrink: 0 }}>
          {logo && (
            <img src={logo} alt="" width={22} height={22} style={{ width: 22, height: 22, borderRadius: "50%", objectFit: "cover", display: "block" }} />
          )}
          <span style={{ fontSize: 14, fontWeight: 700, color: C.mut }}>{suffix}</span>
        </div>
      </div>
    </label>
  );
}

/** Panel de estimación de gas (previo a firmar con la wallet del usuario). */
function GasEstimatePanel({ estimate, loading, error, onRetry, locale, t }) {
  const rows = [];
  if (estimate) {
    rows.push([t("gas.totalNative"), `${fmt(estimate.feeNative, 6, locale)} ${estimate.nativeSymbol}`]);
    rows.push([t("gas.totalUsd"), `$${fmt(estimate.feeUsd, 6, locale)} USD`]);
  }

  return (
    <div style={{ marginTop: 16, paddingTop: 14, borderTop: `1px solid ${C.line}` }}>
      <div style={{ fontSize: 13, fontWeight: 700, color: C.mut, marginBottom: 10 }}>{t("gas.title")}</div>
      {loading && <div style={{ fontSize: 13.5, color: C.mut }}>{t("gas.estimating")}</div>}
      {!loading && error && (
        <div style={{ fontSize: 13.5, color: C.red, lineHeight: 1.45 }}>
          {error === "WALLET_DISCONNECTED" ? t("gas.walletMissing") : error}
          {onRetry && error !== "WALLET_DISCONNECTED" && (
            <button
              onClick={onRetry}
              style={{ display: "block", marginTop: 8, background: "none", border: "none", color: C.violet, fontWeight: 700, cursor: "pointer", padding: 0, fontFamily: "inherit", fontSize: 13 }}
            >
              {t("gas.retry")}
            </button>
          )}
        </div>
      )}
      {!loading && !error && estimate && (
        <div style={{ display: "grid", gap: 8, fontSize: 13.5 }}>
          {rows.map(([k, v]) => (
            <div key={k} style={{ display: "flex", justifyContent: "space-between", gap: 12 }}>
              <span style={{ color: C.mut }}>{k}</span>
              <span style={{ color: C.ink, fontWeight: 600, textAlign: "right", wordBreak: "break-all" }}>{v}</span>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

/** Hook: estima gas cuando cambian from/to/usdc/memo (debounce corto). */
function useGasEstimate({ enabled, from, to, usdc, memo, estimateFn }) {
  const [estimate, setEstimate] = useState(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");
  const [tick, setTick] = useState(0);
  const retry = useCallback(() => setTick((n) => n + 1), []);

  useEffect(() => {
    if (!enabled) {
      setEstimate(null);
      setError("");
      setLoading(false);
      return undefined;
    }
    if (!from) {
      setEstimate(null);
      setError("WALLET_DISCONNECTED");
      setLoading(false);
      return undefined;
    }
    if (!to || !Number.isFinite(Number(usdc)) || Number(usdc) <= 0) {
      setEstimate(null);
      setError("");
      setLoading(false);
      return undefined;
    }

    let alive = true;
    const timer = setTimeout(async () => {
      setLoading(true);
      setError("");
      try {
        const est = estimateFn
          ? await estimateFn()
          : await estimateUsdcTransfer({ from, to, usdc: Number(usdc), memo });
        if (alive) setEstimate(est);
      } catch (e) {
        if (alive) {
          setEstimate(null);
          setError(String(e?.message || e));
        }
      } finally {
        if (alive) setLoading(false);
      }
    }, 280);

    return () => {
      alive = false;
      clearTimeout(timer);
    };
  }, [enabled, from, to, usdc, memo, estimateFn, tick]);

  return { estimate, loading, error, retry };
}

/** Escaneo de QR por cámara (getUserMedia + jsQR sobre frames de <video>). */
function QrScanner({ onDecode, onCameraError, fill = false, torchOn = false }) {
  const videoRef = useRef(null);
  const canvasRef = useRef(null);
  const rafRef = useRef(null);
  const streamRef = useRef(null);
  const [streamReady, setStreamReady] = useState(false);

  useEffect(() => {
    let cancelled = false;
    setStreamReady(false);

    const tick = () => {
      const video = videoRef.current;
      const canvas = canvasRef.current;
      if (!video || !canvas || video.readyState !== video.HAVE_ENOUGH_DATA) {
        rafRef.current = requestAnimationFrame(tick);
        return;
      }
      canvas.width = video.videoWidth;
      canvas.height = video.videoHeight;
      const ctx = canvas.getContext("2d");
      ctx.drawImage(video, 0, 0, canvas.width, canvas.height);
      const frame = ctx.getImageData(0, 0, canvas.width, canvas.height);
      const code = jsQR(frame.data, frame.width, frame.height);
      if (code?.data) {
        onDecode(code.data);
        return;
      }
      rafRef.current = requestAnimationFrame(tick);
    };

    navigator.mediaDevices
      ?.getUserMedia({ video: { facingMode: { ideal: "environment" } } })
      .then((stream) => {
        if (cancelled) {
          stream.getTracks().forEach((tr) => tr.stop());
          return;
        }
        streamRef.current = stream;
        setStreamReady(true);
        if (videoRef.current) {
          videoRef.current.srcObject = stream;
          videoRef.current.play().catch(() => {});
        }
        rafRef.current = requestAnimationFrame(tick);
      })
      .catch((e) => onCameraError(String(e?.message || e)));

    return () => {
      cancelled = true;
      if (rafRef.current) cancelAnimationFrame(rafRef.current);
      streamRef.current?.getTracks().forEach((tr) => tr.stop());
      streamRef.current = null;
      setStreamReady(false);
    };
  }, [onDecode, onCameraError]);

  useEffect(() => {
    if (!streamReady) return;
    const track = streamRef.current?.getVideoTracks?.()[0];
    if (!track) return;
    track.applyConstraints({ advanced: [{ torch: torchOn }] }).catch(() => {});
  }, [torchOn, streamReady]);

  return (
    <div
      style={
        fill
          ? { position: "absolute", inset: 0, background: "#000", overflow: "hidden" }
          : { position: "relative", borderRadius: 16, overflow: "hidden", background: "#000" }
      }
    >
      <video
        ref={videoRef}
        muted
        playsInline
        style={
          fill
            ? { width: "100%", height: "100%", objectFit: "cover", display: "block" }
            : { width: "100%", display: "block" }
        }
      />
      <canvas ref={canvasRef} style={{ display: "none" }} />
    </div>
  );
}

// ————— Pagar (alias o address, sin mic; + escaneo QR) —————
// ————— Enviar (alias / address → USDC) —————
function Send({ address, balance, fxRate, contacts, onPay, onDone }) {
  const { t, locale } = useLanguage();
  const [recipient, setRecipient] = useState("");
  const [amount, setAmount] = useState("");
  const [phase, setPhase] = useState("form");
  const [errMsg, setErrMsg] = useState("");

  const n = Number(String(amount).replace(',','.'));
  const contact=useMemo(()=>resolveRecipient(contacts,recipient),[recipient,contacts]);

  const suggestions = useMemo(() => {
    const q = recipient.trim();
    if (!q || contact) return [];
    return searchContacts(contacts, q).filter(c=>isAddress(c.addr || '')).slice(0, 5);
  }, [recipient, contacts, contact]);

  const usdc = Number.isFinite(n) && n > 0 ? n : null;
  const canSubmit = Boolean(contact && usdc != null && usdc > 0 && address);

  const submit = async () => {
    setErrMsg("");
    setPhase("working");
    try {
      if (!contact) throw new Error(t("pay.recipientInvalid"));
      if (usdc == null || usdc <= 0) throw new Error(t("pay.amountTooLow"));
      if (balance !== null && usdc > balance) {
        throw new Error(t("voice.insufficientBalance", fmt(usdc, 2, locale), fmt(balance, 2, locale)));
      }
      const parsed = {
        amount: n,
        currency: "USDC",
        usdcText:exactUsdc(amount),
        usdc,
        fxRate,
        contact,
        factura: nuevaFactura(),
        kind: "pay",
      };
      const result = await onPay(parsed);
      onDone({
        ...result,
        parsed,
        ts: new Date().toLocaleTimeString(locale, { hour: "2-digit", minute: "2-digit" }),
      });
    } catch (e) {
      setErrMsg(String(e?.message || e));
      setPhase("error");
    }
  };

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 16 }}>
      <h2 style={{ fontSize: 26, fontWeight: 700, color: C.ink, margin: 0, letterSpacing: -0.4 }}>{t("send.title")}</h2>

      <Card style={{ display: "flex", flexDirection: "column", gap: 16 }}>
        <label style={{ display: "block" }}>
          <div style={{ fontSize: 13, fontWeight: 600, color: C.mut, marginBottom: 8 }}>{t("pay.recipientLabel")}</div>
          <input
            value={recipient}
            onChange={(e) => setRecipient(e.target.value)}
            placeholder={t("pay.recipientPlaceholder")}
            autoComplete="off"
            style={{
              width: "100%",
              boxSizing: "border-box",
              background: C.card,
              border: `1px solid ${C.line}`,
              borderRadius: 14,
              padding: "14px 16px",
              fontSize: 16,
              fontWeight: 600,
              color: C.ink,
              outline: "none",
              fontFamily: "inherit",
            }}
          />
        </label>

        {contact && (
          <div
            style={{
              display: "flex",
              alignItems: "center",
              gap: 12,
              background: C.card,
              border: `1px solid ${C.line}`,
              borderRadius: 14,
              padding: "12px 14px",
            }}
          >
            <div
              style={{
                width: 40,
                height: 40,
                borderRadius: "50%",
                background: C.orangeSoft,
                display: "grid",
                placeItems: "center",
                color: "#fe6c1c",
                fontWeight: 700,
                flexShrink: 0,
              }}
            >
              {(contact.name || "?").slice(0, 1).toUpperCase()}
            </div>
            <div style={{ minWidth: 0, flex: 1 }}>
              <div style={{ fontSize: 15, fontWeight: 700, color: C.ink }}>{contact.name}</div>
              <div style={{ fontSize: 12.5, color: C.mut, fontFamily: "ui-monospace, monospace" }}>{short(contact.addr)}</div>
            </div>
            {contact.alias && contact.alias !== "addr" && (
              <span style={{ fontSize: 12, fontWeight: 700, color: "#fe6c1c" }}>@{contact.alias}</span>
            )}
          </div>
        )}

        {!contact && suggestions.length > 0 && (
          <div style={{ display: "grid", gap: 6 }}>
            {suggestions.map((c) => (
              <button
                key={c.id || c.alias}
                type="button"
                onClick={() => setRecipient(c.alias)}
                style={{
                  display: "flex",
                  alignItems: "center",
                  gap: 10,
                  textAlign: "left",
                  background: C.card,
                  border: `1px solid ${C.line}`,
                  borderRadius: 12,
                  padding: "10px 12px",
                  cursor: "pointer",
                  fontFamily: "inherit",
                }}
              >
                <div style={{ flex: 1, minWidth: 0 }}>
                  <div style={{ fontSize: 14, fontWeight: 700, color: C.ink }}>{c.name}</div>
                  <div style={{ fontSize: 12, color: C.mut }}>@{c.alias}</div>
                </div>
              </button>
            ))}
          </div>
        )}

        <AmountField
          label={t("pay.amountUsdc")}
          value={amount}
          onChange={setAmount}
          placeholder="1"
          suffix="USDC"
          logo="/monedas/usdc.png"
        />

        <button type="button" disabled={balance===null || balance<=0 || phase==='working'} onClick={()=>setAmount(Number(balance).toFixed(6))}>Enviar todo</button>
        <small>Hasta 6 decimales. MidatoPay cubre el costo en SOL. Máximo 2 envíos por día.</small>
        <div style={{ display: "flex", justifyContent: "space-between", fontSize: 14.5 }}>
          <span style={{ color: C.mut }}>{t("pay.youSend")}</span>
          <span style={{ fontWeight: 700, color: C.ink }}>
            {usdc != null ? `${fmt(usdc, 6, locale)} USDC` : "—"}
          </span>
        </div>
      </Card>

      {(phase === "error" || errMsg) && phase !== "working" && (
        <Card style={{ background: "#FDECEA", color: C.red, fontSize: 14, lineHeight: 1.5 }}>{errMsg}</Card>
      )}

      <button
        onClick={submit}
        disabled={phase === "working" || !canSubmit}
        style={{
          ...btnOrange,
          background: C.orange,
          boxShadow: "none",
          opacity: phase === "working" || !canSubmit ? 0.5 : 1,
        }}
      >
        {phase === "working" ? t("pay.working") : t("send.cta")}
      </button>

      <p style={{fontSize:13,color:C.mut}}>La confirmación mostrará el destinatario completo y el importe exacto. El costo de red lo cubre MidatoPay.</p>
    </div>
  );
}

// ————— Pagar (escaneo QR P2P, UI tipo guest en naranja) —————
function PayScan({
  address, balance, fxRate, contacts, onPay, onDone, onSaveContact,
  scanRequest, onScanRequestConsumed, onBack, onFullscreenChange,
}) {
  const { t, locale } = useLanguage();
  const [view, setView] = useState(scanRequest ? "confirm" : "scan"); // scan | link | invalid | confirm
  const [qr, setQr] = useState(scanRequest);
  const [scanErr, setScanErr] = useState("");
  const [manualLink, setManualLink] = useState("");
  const [phase, setPhase] = useState("form");
  const [errMsg, setErrMsg] = useState("");
  const [torchOn, setTorchOn] = useState(false);
  const [savePrompt, setSavePrompt] = useState(false);

  const fullscreen = view === "scan" || view === "link" || view === "invalid";

  useEffect(() => {
    onFullscreenChange?.(fullscreen);
  }, [fullscreen, onFullscreenChange]);

  useEffect(() => {
    if (!scanRequest) return;
    setQr(scanRequest);
    setView("confirm");
    onScanRequestConsumed();
  }, [scanRequest, onScanRequestConsumed]);

  const openScan = () => {
    setView("scan");
    setQr(null);
    setScanErr("");
    setErrMsg("");
    setPhase("form");
    setManualLink("");
    setTorchOn(false);
    setSavePrompt(false);
  };

  const applyDecoded = (raw) => {
    const parsed = parsePayUrl(raw);
    if (!parsed) {
      setScanErr("invalid");
      setView("invalid");
      setQr(null);
      return;
    }
    if (parsed.addr === address) {
      setScanErr(t("pay.selfPay"));
      setView("invalid");
      setQr(null);
      return;
    }
    setScanErr("");
    setQr(parsed);
    setPhase("form");
    setErrMsg("");
    setView("confirm");
  };

  const qrUsdc = qr ? Math.floor(qr.ars / fxRate * 1000000) / 1000000 : null;
  const merchantName = guestMerchantName(qr?.who);
  const qrContact = qr ? { name: merchantName || qr.who || short(qr.addr), alias: "qr", addr: qr.addr } : null;
  const knownContact = qr ? contacts.find((c) => c.addr === qr.addr) : null;

  const submitQr = async () => {
    setErrMsg("");
    setPhase("working");
    try {
      if (qrUsdc == null || qrUsdc <= 0) throw new Error(t("pay.amountTooLow"));
      if (balance !== null && qrUsdc > balance) {
        throw new Error(t("voice.insufficientBalance", fmt(qrUsdc, 2, locale), fmt(balance, 2, locale)));
      }
      const parsed = {
        amount: qr.ars,
        currency: "ARS",
        usdc: qrUsdc,
        fxRate,
        contact: qrContact,
        factura: qr.factura || nuevaFactura(),
        kind: "charge_p2p",
      };
      const result = await onPay(parsed);
      onDone({
        ...result,
        direction: "out",
        parsed,
        ts: new Date().toLocaleTimeString(locale, { hour: "2-digit", minute: "2-digit" }),
      });
      if (!knownContact) setSavePrompt(true);
    } catch (e) {
      setErrMsg(String(e?.message || e));
      setPhase("error");
    }
  };

  const saveContact = async () => {
    setSavePrompt(false);
    try {
      await onSaveContact({
        name: qr.who || short(qr.addr),
        alias: slugifyAlias(qr.who) || qr.addr.slice(2, 8).toLowerCase(),
        addr: qr.addr,
        note: "",
      });
    } catch {
      /* ignore */
    }
  };

  if (view === "invalid") {
    return (
      <div style={{ display: "flex", flexDirection: "column", minHeight: "100%", padding: "28px 22px 28px", boxSizing: "border-box", background: C.card }}>
        <div style={{ flex: 1, display: "flex", flexDirection: "column", alignItems: "center", justifyContent: "center", textAlign: "center", gap: 12 }}>
          <div style={{ width: 88, height: 88, borderRadius: 22, background: "#FDECEA", display: "grid", placeItems: "center", color: C.red }}>
            <IconQrCode size={44} />
          </div>
          <div style={{ fontSize: 22, fontWeight: 700, color: C.ink, marginTop: 8 }}>
            {scanErr && scanErr !== "invalid" ? scanErr : t("guest.invalidTitle")}
          </div>
          <div style={{ fontSize: 15, color: C.mut, lineHeight: 1.45, maxWidth: 280 }}>{t("guest.invalidBody")}</div>
        </div>
        <div style={{ display: "flex", flexDirection: "column", gap: 10 }}>
          <button type="button" onClick={openScan} style={{ ...btnOrange, background: C.ink, boxShadow: "none" }}>
            {t("guest.scanAgain")}
          </button>
          <button type="button" onClick={onBack} style={{ ...btnOutline, borderColor: C.line, color: C.ink, background: C.bg }}>
            {t("guest.goHome")}
          </button>
        </div>
      </div>
    );
  }

  if (view === "link") {
    return (
      <div style={{ display: "flex", flexDirection: "column", minHeight: "100%", padding: "22px 22px 28px", boxSizing: "border-box", background: C.card }}>
        <button type="button" onClick={openScan} aria-label={t("guest.backHome")} style={{ alignSelf: "flex-start", width: 40, height: 40, borderRadius: "50%", border: "none", background: C.bg, color: C.ink, fontSize: 26, lineHeight: 1, cursor: "pointer", fontFamily: "inherit", marginBottom: 18 }}>
          ‹
        </button>
        <h2 style={{ fontSize: 26, fontWeight: 700, color: C.ink, margin: "0 0 8px", letterSpacing: -0.4 }}>{t("guest.useLinkTitle")}</h2>
        <p style={{ fontSize: 15, color: C.mut, lineHeight: 1.45, margin: "0 0 20px" }}>{t("guest.useLinkBody")}</p>
        <textarea
          value={manualLink}
          onChange={(e) => setManualLink(e.target.value)}
          placeholder={t("pay.scanLinkPlaceholder")}
          rows={4}
          style={{ width: "100%", boxSizing: "border-box", border: `1px solid ${C.line}`, borderRadius: 16, padding: "14px 16px", fontSize: 15, fontFamily: "inherit", outline: "none", resize: "vertical", color: C.ink, background: C.bg }}
        />
        <div style={{ marginTop: "auto", paddingTop: 24, display: "flex", flexDirection: "column", gap: 10 }}>
          <button
            type="button"
            onClick={() => applyDecoded(manualLink)}
            disabled={!manualLink.trim()}
            style={{ ...btnOrange, background: C.orange, boxShadow: "none", opacity: manualLink.trim() ? 1 : 0.5 }}
          >
            {t("guest.useLinkCta")}
          </button>
          <button type="button" onClick={openScan} style={{ ...btnOutline, border: "none", color: C.mut }}>
            {t("guest.scanAgain")}
          </button>
        </div>
      </div>
    );
  }

  if (view === "scan") {
    return (
      <div className="mp-guest-scan mp-pay-scan">
        <div className="mp-guest-scan-top">
          <button type="button" onClick={onBack} className="mp-guest-scan-iconbtn" aria-label={t("guest.backHome")}>‹</button>
        </div>
        {!scanErr.startsWith("CAMERA:") ? (
          <div className="mp-guest-scan-stage">
            <QrScanner
              fill
              torchOn={torchOn}
              onDecode={applyDecoded}
              onCameraError={() => setScanErr("CAMERA:" + t("pay.scanCameraError"))}
            />
            <div className="mp-guest-scan-frame" aria-hidden />
            <div className="mp-guest-scan-laser" aria-hidden />
          </div>
        ) : (
          <div style={{ position: "absolute", inset: 0, display: "grid", placeItems: "center", padding: 24, color: "#fff", textAlign: "center", background: "#0b0b0d" }}>
            {scanErr.replace(/^CAMERA:/, "")}
          </div>
        )}
        <div className="mp-guest-scan-bottom">
          <button
            type="button"
            onClick={() => setTorchOn((v) => !v)}
            className={`mp-guest-scan-flash${torchOn ? " is-on" : ""}`}
            aria-label={t("guest.flash")}
            aria-pressed={torchOn}
          >
            <IconFlash size={24} />
          </button>
          <button type="button" onClick={() => { setView("link"); setManualLink(""); }} style={{ ...btnOrange, background: "#fff", color: C.ink, boxShadow: "none" }}>
            {t("guest.useLink")}
          </button>
        </div>
      </div>
    );
  }

  // confirm
  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 16 }}>
      <h2 style={{ fontSize: 26, fontWeight: 700, color: C.ink, margin: 0, letterSpacing: -0.4 }}>{t("pay.title")}</h2>
      <Card style={{ display: "flex", flexDirection: "column", gap: 14 }}>
        <div style={{ fontSize: 13, color: C.mut }}>{t("guest.payToLabel")}</div>
        <div>
          <div style={{ fontSize: 15, fontWeight: 600, color: C.ink }}>{t("guest.merchant")}</div>
          {merchantName ? (
            <div style={{ fontSize: 20, fontWeight: 700, color: "#fe6c1c", marginTop: 2, letterSpacing: -0.3 }}>{merchantName}</div>
          ) : null}
        </div>
        <div style={{ display: "flex", justifyContent: "space-between", fontSize: 14.5, marginTop: 6 }}>
          <span style={{ color: C.mut }}>{t("guest.youPay")}</span>
          <span style={{ fontWeight: 700, color: C.ink }}>$ {fmtArs(qr.ars)}</span>
        </div>
        <div style={{ display: "flex", justifyContent: "space-between", fontSize: 14, color: C.mut }}>
          <span>{t("pay.youSend")}</span>
          <span>{qrUsdc != null ? `≈ ${fmt(qrUsdc, 2, locale)} USDC` : "—"}</span>
        </div>
        {(phase === "error" || errMsg) && phase !== "working" && (
          <div style={{ padding: "12px 14px", background: "#FDECEA", color: C.red, borderRadius: 12, fontSize: 13.5, lineHeight: 1.5 }}>{errMsg}</div>
        )}
        <button
          onClick={submitQr}
          disabled={phase === "working"}
          style={{ ...btnOrange, background: C.orange, boxShadow: "none", opacity: phase === "working" ? 0.5 : 1 }}
        >
          {phase === "working" ? t("pay.working") : t("pay.confirmPayCta")}
        </button>
        <button onClick={openScan} style={{ ...btnOutline, border: "none", color: C.mut }}>{t("guest.scanAgain")}</button>
      </Card>

      {savePrompt && qr && (
        <Card style={{ display: "flex", flexDirection: "column", gap: 12 }}>
          <div style={{ fontSize: 15, fontWeight: 700, color: C.ink }}>{t("qr.saveContactTitle")}</div>
          <div style={{ fontSize: 13.5, color: C.mut }}>{t("qr.saveContactBody", qr.who || short(qr.addr))}</div>
          <div style={{ display: "flex", gap: 8 }}>
            <button onClick={saveContact} style={{ ...btnOrange, background: C.orange, boxShadow: "none" }}>{t("qr.saveContactYes")}</button>
            <button onClick={() => setSavePrompt(false)} style={btnOutline}>{t("qr.saveContactNo")}</button>
          </div>
        </Card>
      )}
    </div>
  );
}

// ————— Convertir (ARS ↔ USDC) —————
function Convert({ address, balance, arsBalance, fxRate, onConvertArsUsdc, onConvertUsdcArs, onDone }) {
  const { t, locale } = useLanguage();
  const [direction, setDirection] = useState("ars_usdc"); // ars_usdc | usdc_ars
  const [amount, setAmount] = useState("");
  const [phase, setPhase] = useState("form");
  const [errMsg, setErrMsg] = useState("");
  const [feeOpen, setFeeOpen] = useState(false);
  const n = Number(amount);
  const sellIsArs = direction === "ars_usdc";
  const needsUserSignature = direction === "usdc_ars";

  const estimateConvertFn = useCallback(() => {
    if (!needsUserSignature || !Number.isFinite(n) || n <= 0) {
      return Promise.reject(new Error("Sin monto"));
    }
    return estimateConvertUsdcToArs({ from: address, usdcAmount: n, fxRate });
  }, [needsUserSignature, n, address, fxRate]);

  const gas = useGasEstimate({
    enabled: needsUserSignature && Number.isFinite(n) && n > 0 && phase === "form",
    from: address,
    to: "treasury",
    usdc: n,
    memo: `convert_usdc_ars:${n}:${fxRate}`,
    estimateFn: estimateConvertFn,
  });

  const feeSol =
    needsUserSignature && Number.isFinite(gas.estimate?.feeNative)
      ? Number(gas.estimate.feeNative)
      : 0;
  const feeReady = !needsUserSignature || (!gas.loading && !!gas.estimate && !gas.error);
  // En Solana el fee es SOL (no USDC): el monto USDC a convertir es el ingresado completo.
  const transferUsdc = Number.isFinite(n) && n > 0 ? n : null;

  const quote =
    sellIsArs
      ? Number.isFinite(n) && n > 0
        ? quoteArsToUsdc(n, fxRate)
        : null
      : transferUsdc != null && transferUsdc > 0
        ? quoteUsdcToArs(transferUsdc, fxRate)
        : null;

  const sellLogo = sellIsArs ? "/monedas/ars.png" : "/monedas/usdc.png";
  const buyLogo = sellIsArs ? "/monedas/usdc.png" : "/monedas/ars.png";
  const sellToken = sellIsArs ? "ARS" : "USDC";
  const buyToken = sellIsArs ? "USDC" : "ARS";
  const sellBalLabel = sellIsArs
    ? `$ ${fmtArs(arsBalance || 0)}`
    : balance === null
      ? "—"
      : `${fmt(balance, 2, locale)}`;

  const buyPrimary = quote
    ? sellIsArs
      ? fmt(quote.usdc, 2, locale)
      : fmtArs(quote.ars)
    : needsUserSignature && gas.loading
      ? "…"
      : "0";

  const sellSecondary =
    Number.isFinite(n) && n > 0
      ? sellIsArs
        ? quote
          ? `≈ ${fmt(quote.usdc, 2, locale)} USDC`
          : "—"
        : `$ ${fmtArs(n * fxRate)}`
      : "$ 0";

  const buySecondary = quote
    ? sellIsArs
      ? `$ ${fmtArs(n)}`
      : `≈ ${fmt(transferUsdc, 4, locale)} USDC`
    : "$ 0";

  const canSubmit =
    !!quote &&
    phase !== "working" &&
    !(needsUserSignature && !address) &&
    !(needsUserSignature && !feeReady) &&
    !(needsUserSignature && transferUsdc != null && transferUsdc <= 0);

  const flip = () => {
    const next = direction === "ars_usdc" ? "usdc_ars" : "ars_usdc";
    if (quote) {
      setAmount(direction === "ars_usdc" ? String(quote.usdc) : String(Number(quote.ars.toFixed(2))));
    } else {
      setAmount("");
    }
    setDirection(next);
    setErrMsg("");
    setPhase("form");
  };

  const setMax = () => {
    if (sellIsArs) {
      setAmount(String(Number((arsBalance || 0).toFixed(2))));
    } else if (balance != null) {
      // Monto bruto = saldo completo (incluye reserva para fee de red).
      setAmount(String(Number(Number(balance).toFixed(6))));
    }
  };

  const onAmountChange = (raw) => {
    setAmount(raw.replace(/[^\d.,]/g, "").replace(",", "."));
  };

  const submit = async () => {
    setErrMsg("");
    setPhase("working");
    try {
      await refreshTreasuryStatus();
      if (!isTreasuryConfigured()) throw new Error(t("convert.treasuryMissing"));
      if (direction === "ars_usdc") {
        const result = await onConvertArsUsdc(n);
        onDone({
          kind: result.kind,
          ...result,
          parsed: {
            usdc: result.usdc,
            amount: result.ars,
            currency: "ARS",
            fxRate: result.fxRate,
            contact: { name: t("convert.treasuryLabel"), alias: "treasury" },
          },
          ts: new Date().toLocaleTimeString(locale, { hour: "2-digit", minute: "2-digit" }),
        });
        return;
      }

      if (!feeReady || transferUsdc == null || transferUsdc <= 0) {
        throw new Error(t("convert.feePending"));
      }
      if (balance !== null && n > balance) {
        throw new Error(t("voice.insufficientBalance", fmt(n, 2, locale), fmt(balance, 2, locale)));
      }

      const result = await onConvertUsdcArs(transferUsdc);
      onDone({
        kind: result.kind,
        ...result,
        fee: feeSol,
        parsed: {
          usdc: result.usdc,
          amount: result.usdc,
          currency: "USDC",
          fxRate: result.fxRate,
          contact: { name: t("convert.treasuryLabel"), alias: "treasury" },
        },
        ts: new Date().toLocaleTimeString(locale, { hour: "2-digit", minute: "2-digit" }),
      });
    } catch (e) {
      setErrMsg(String(e?.message || e));
      setPhase("error");
    }
  };

  const tokenPill = (logo, symbol) => (
    <div
      style={{
        display: "inline-flex",
        alignItems: "center",
        gap: 8,
        background: C.card,
        border: `1px solid ${C.line}`,
        borderRadius: 999,
        padding: "8px 12px 8px 8px",
      }}
    >
      <img src={logo} alt="" width={24} height={24} style={{ width: 24, height: 24, borderRadius: "50%", objectFit: "cover" }} />
      <span style={{ fontSize: 16, fontWeight: 700, color: C.ink }}>{symbol}</span>
    </div>
  );

  const panel = (side) => {
    const isSell = side === "sell";
    return (
      <div
        style={{
          background: C.bg,
          borderRadius: isSell ? "22px 22px 18px 18px" : "18px 18px 22px 22px",
          padding: "16px 18px 18px",
        }}
      >
        <div style={{ fontSize: 13.5, fontWeight: 600, color: C.mut, marginBottom: 10 }}>
          {isSell ? t("convert.sell") : t("convert.buy")}
        </div>
        <div style={{ display: "flex", alignItems: "flex-start", justifyContent: "space-between", gap: 12 }}>
          <div style={{ flex: 1, minWidth: 0 }}>
            {isSell ? (
              <input
                value={amount}
                onChange={(e) => onAmountChange(e.target.value)}
                inputMode="decimal"
                placeholder="0"
                style={{
                  width: "100%",
                  border: "none",
                  background: "transparent",
                  fontSize: 36,
                  fontWeight: 600,
                  color: C.ink,
                  padding: 0,
                  fontFamily: "inherit",
                  outline: "none",
                  letterSpacing: -0.8,
                  lineHeight: 1.1,
                }}
              />
            ) : (
              <div
                style={{
                  fontSize: 36,
                  fontWeight: 600,
                  color: quote ? C.ink : C.mut,
                  letterSpacing: -0.8,
                  lineHeight: 1.1,
                  wordBreak: "break-all",
                }}
              >
                {buyPrimary}
              </div>
            )}
            <div style={{ fontSize: 14, color: C.mut, marginTop: 6 }}>
              {isSell ? sellSecondary : buySecondary}
            </div>
          </div>
          <div style={{ display: "flex", flexDirection: "column", alignItems: "flex-end", gap: 10, flexShrink: 0 }}>
            {tokenPill(isSell ? sellLogo : buyLogo, isSell ? sellToken : buyToken)}
            {isSell && (
              <div style={{ display: "flex", alignItems: "center", gap: 8, fontSize: 13, color: C.mut }}>
                <span>{sellBalLabel}</span>
                <button
                  type="button"
                  onClick={setMax}
                  disabled={sellIsArs ? !(arsBalance > 0) : !(balance > 0)}
                  style={{
                    border: "none",
                    cursor: "pointer",
                    fontFamily: "inherit",
                    background: C.orangeSoft,
                    color: "#fe6c1c",
                    fontWeight: 700,
                    fontSize: 12,
                    borderRadius: 8,
                    padding: "4px 8px",
                    opacity: (sellIsArs ? arsBalance > 0 : balance > 0) ? 1 : 0.45,
                  }}
                >
                  {t("convert.max")}
                </button>
              </div>
            )}
          </div>
        </div>
      </div>
    );
  };

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 16 }}>
      <h2 style={{ fontSize: 26, fontWeight: 700, color: C.ink, margin: 0, letterSpacing: -0.4 }}>{t("convert.title")}</h2>

      <div style={{ position: "relative", display: "flex", flexDirection: "column", gap: 6 }}>
        {panel("sell")}

        <div style={{ position: "absolute", left: "50%", top: "50%", transform: "translate(-50%, -50%)", zIndex: 2 }}>
          <button
            type="button"
            aria-label={t("convert.flip")}
            onClick={flip}
            style={{
              width: 40,
              height: 40,
              borderRadius: 12,
              border: `4px solid #fff`,
              background: C.bg,
              color: C.ink,
              cursor: "pointer",
              display: "grid",
              placeItems: "center",
              padding: 0,
            }}
          >
            <IconArrowDown size={18} />
          </button>
        </div>

        {panel("buy")}
      </div>

      {phase === "working" && (
        <Card style={{ textAlign: "center", padding: 28 }}>
          <div style={{ display: "flex", justifyContent: "center", gap: 10, marginBottom: 14 }}>
            <img src={sellLogo} alt="" width={36} height={36} style={{ width: 36, height: 36, borderRadius: "50%" }} />
            <span style={{ color: C.mut, fontSize: 22, lineHeight: "36px" }}>→</span>
            <img src={buyLogo} alt="" width={36} height={36} style={{ width: 36, height: 36, borderRadius: "50%" }} />
          </div>
          <div style={{ fontSize: 17, fontWeight: 700, color: C.ink }}>{t("convert.working")}</div>
          <div style={{ fontSize: 13.5, color: C.mut, marginTop: 8 }}>{t("convert.workingHint")}</div>
        </Card>
      )}

      {(phase === "error" || errMsg) && phase !== "working" && (
        <Card style={{ background: "#FDECEA", color: C.red, fontSize: 14, lineHeight: 1.5 }}>{errMsg}</Card>
      )}

      <button
        onClick={submit}
        disabled={!canSubmit}
        style={{
          ...btnOrange,
          borderRadius: 18,
          background: C.orange,
          boxShadow: "none",
          opacity: canSubmit ? 1 : 0.5,
        }}
      >
        {phase === "working" ? t("convert.working") : needsUserSignature ? t("convert.ctaSign") : t("convert.cta")}
      </button>

      <div style={{ textAlign: "center", fontSize: 13, color: C.mut, fontWeight: 500 }}>
        1 USDC = ${fmtArs(fxRate)} ARS
      </div>

      {needsUserSignature && Number.isFinite(n) && n > 0 && phase === "form" && (
        <div style={{ padding: "4px 2px 0" }}>
          <button
            type="button"
            onClick={() => setFeeOpen((v) => !v)}
            style={{
              background: "none",
              border: "none",
              color: "#fe6c1c",
              fontWeight: 700,
              cursor: "pointer",
              padding: 0,
              fontFamily: "inherit",
              fontSize: 13,
              display: "inline-flex",
              alignItems: "center",
              gap: 6,
            }}
          >
            {feeOpen ? t("send.hideFeeDetails") : t("send.viewFeeDetails")}
            <IconChevronDown size={16} up={feeOpen} />
          </button>

          {feeOpen && (
            <div
              style={{
                background: C.bg,
                borderRadius: 16,
                padding: "14px 16px",
                marginTop: 10,
              }}
            >
              <div style={{ fontSize: 14, fontWeight: 700, color: C.ink }}>{t("convert.feeTitle")}</div>
              <div style={{ fontSize: 12.5, color: C.mut, marginTop: 4, lineHeight: 1.4 }}>{t("convert.feeDeducted")}</div>

              {gas.loading && (
                <div style={{ fontSize: 14, color: C.mut, marginTop: 14 }}>{t("convert.feePending")}</div>
              )}
              {!gas.loading && gas.error && (
                <button
                  type="button"
                  onClick={gas.retry}
                  style={{ display: "block", marginTop: 14, background: "none", border: "none", color: C.orange, fontWeight: 700, cursor: "pointer", padding: 0, fontFamily: "inherit", fontSize: 13 }}
                >
                  {t("gas.retry")}
                </button>
              )}
              {!gas.loading && !gas.error && feeReady && (
                <div style={{ display: "flex", justifyContent: "space-between", alignItems: "baseline", gap: 16, marginTop: 14 }}>
                  <span style={{ fontSize: 14, color: C.mut, flexShrink: 0 }}>{t("gas.totalNative")}</span>
                  <span style={{ fontSize: 15, fontWeight: 700, color: C.ink, textAlign: "right", whiteSpace: "nowrap" }}>
                    − {fmt(feeSol, 6, locale)} {gas.estimate?.nativeSymbol || "SOL"}
                  </span>
                </div>
              )}
            </div>
          )}
        </div>
      )}
    </div>
  );
}

// ————— Voz —————
function Voice({
  sendPayment,
  balance,
  onDone,
  onCharge,
  fxRate,
  address,
  contacts,
  getAccessToken,
  voiceKick = 0,
  onListeningChange,
  voiceApiRef,
  overlay = false,
  onClose,
}) {
  const { t, lang, locale } = useLanguage();
  const [phase, setPhase] = useState("idle");
  const [transcript, setTranscript] = useState("");
  const [parsed, setParsed] = useState(null);
  const [errMsg, setErrMsg] = useState("");
  const [manual, setManual] = useState("");
  const [claudeConfigured, setClaudeConfigured] = useState(null);
  const recRef = useRef(null);
  const supported = typeof window !== "undefined" && (window.SpeechRecognition || window.webkitSpeechRecognition);

  useEffect(() => {
    let cancelled = false;
    fetch("/parse-intent")
      .then((r) => r.json())
      .then((body) => {
        if (!cancelled) setClaudeConfigured(Boolean(body.configured));
      })
      .catch(() => {
        if (!cancelled) setClaudeConfigured(false);
      });
    return () => {
      cancelled = true;
    };
  }, []);

  const analyze = useCallback(
    async (text) => {
      setTranscript(text);
      setPhase("parsing");
      let result;
      try {
        const token = getAccessToken ? await getAccessToken() : null;
        result = await claudeParse(text, lang, contacts.filter(c=>isAddress(c.addr || '')).map((c) => c.alias), token);
      } catch {
        result = localParse(text, lang);
      }

      if (result?.intent === "charge") {
        if (!(result.amount > 0)) {
          setErrMsg(t("voice.noPaymentUnderstood"));
          setPhase("error");
          return;
        }
        const ars = result.currency === "USDC" ? result.amount * fxRate : result.amount;
        onCharge(ars);
        return;
      }

      if (contacts.length === 0) {
        setErrMsg(t("voice.noContactsYet"));
        setPhase("error");
        return;
      }
      if (!result || result.intent !== "send" || !result.amount || !result.recipient) {
        setErrMsg(t("voice.noPaymentUnderstood"));
        setPhase("error");
        return;
      }
      const candidates=recipientCandidates(contacts,result.recipient);
      if (!candidates.length) {
        setErrMsg(t("voice.aliasNotFound", result.recipient));
        setPhase("error");
        return;
      }
      const usdc = result.currency === "ARS" ? Math.floor(result.amount / fxRate * 1000000) / 1000000 : result.amount;
      if (usdc <= 0) {
        setErrMsg(t("voice.amountTooLow", result.amount, result.currency));
        setPhase("error");
        return;
      }
      if (balance !== null && usdc > balance) {
        setErrMsg(t("voice.insufficientBalance", fmt(usdc, 2, locale), fmt(balance, 2, locale)));
        setPhase("error");
        return;
      }
      setParsed({ ...result, contact:candidates.length===1?candidates[0]:null, recipients:candidates, usdc, fxRate, factura: nuevaFactura() });
      setPhase(candidates.length===1?'confirm':'choose_recipient');
    },
    [balance, fxRate, lang, locale, t, contacts, onCharge, getAccessToken]
  );

  const stopListen = useCallback(() => {
    try {
      recRef.current?.stop();
    } catch {}
    setPhase((p) => (p === "listening" ? "idle" : p));
  }, []);

  const listen = useCallback(() => {
    setErrMsg("");
    setTranscript("");
    if (!supported) {
      setErrMsg(t("voice.micUnsupported"));
      setPhase("error");
      return;
    }
    try {
      try {
        recRef.current?.stop();
      } catch {}
      const SR = window.SpeechRecognition || window.webkitSpeechRecognition;
      const rec = new SR();
      recRef.current = rec;
      const isSafari = /^((?!chrome|android|crios|edg).)*safari/i.test(navigator.userAgent);
      rec.lang = lang === "en" ? "en-US" : "es-AR";
      rec.interimResults = !isSafari;
      rec.continuous = false;
      rec.maxAlternatives = 1;
      rec.onresult = (e) => {
        const txt = Array.from(e.results).map((r) => r[0].transcript).join(" ");
        setTranscript(txt);
        if (e.results[e.results.length - 1].isFinal) {
          rec.stop();
          analyze(txt);
        }
      };
      rec.onnomatch = () => {
        setErrMsg(t("voice.noSpeechMatch"));
        setPhase("error");
      };
      rec.onerror = (e) => {
        const msgs = t("voice.micErrors");
        setErrMsg(msgs[e.error] || t("voice.micErrGeneric", e.error));
        setPhase("error");
      };
      rec.onend = () => setPhase((p) => (p === "listening" ? "idle" : p));
      rec.start();
      setPhase("listening");
    } catch {
      setErrMsg(t("voice.micUnavailable"));
      setPhase("error");
    }
  }, [analyze, lang, supported, t]);

  useEffect(() => {
    onListeningChange?.(phase === "listening");
    return () => onListeningChange?.(false);
  }, [phase, onListeningChange]);

  useEffect(() => {
    if (!voiceApiRef) return undefined;
    voiceApiRef.current = {
      listen,
      stop: stopListen,
      toggle: () => {
        if (phase === "listening") stopListen();
        else listen();
      },
    };
    return () => {
      voiceApiRef.current = null;
    };
  }, [voiceApiRef, listen, stopListen, phase]);

  useEffect(() => {
    if (!voiceKick) return undefined;
    // Arrancar ya: no usar autoListen boolean (al limpiarlo cancelaba el timer).
    const timer = setTimeout(() => listen(), 50);
    return () => clearTimeout(timer);
  }, [voiceKick]); // eslint-disable-line react-hooks/exhaustive-deps

  const execute = async () => {
    setPhase("sending");
    try {
      const r = await sendPayment(parsed);
      onDone({ ...r, parsed });
    } catch (err) {
      const m = String(err?.message || err);
      if (m.includes("limit reached") || m.includes("-32011") || m.includes("429")) {
        setErrMsg(t("voice.rpcLimited"));
      } else if (m.includes("insufficient funds")) {
        setErrMsg(t("voice.insufficientFundsOnchain"));
      } else if (m.includes("rejected") || m.includes("denied")) {
        setErrMsg(t("voice.signatureCancelled"));
      } else {
        setErrMsg(t("voice.txFailed", m.slice(0, 130)));
      }
      setPhase("error");
    }
  };

  const reset = () => {
    setPhase("idle");
    setParsed(null);
    setTranscript("");
    setErrMsg("");
  };

  const active = phase === "listening";

  // Overlay FAB: solo estado de escucha + transcript (sin segunda pantalla / segundo mic).
  if (overlay && (phase === "idle" || phase === "listening" || phase === "parsing")) {
    return (
      <div style={{ display: "flex", flexDirection: "column", gap: 14, flex: 1, justifyContent: "flex-end" }}>
        <div style={{ display: "flex", justifyContent: "flex-end" }}>
          {onClose && (
            <button
              type="button"
              onClick={() => {
                stopListen();
                onClose();
              }}
              aria-label={t("voice.cancel")}
              style={{
                width: 36,
                height: 36,
                borderRadius: 12,
                border: `1px solid ${C.line}`,
                background: C.bg,
                color: C.ink,
                cursor: "pointer",
                fontSize: 20,
                lineHeight: 1,
                fontFamily: "inherit",
              }}
            >
              ×
            </button>
          )}
        </div>
        <Card style={{ padding: "28px 22px 32px", textAlign: "center" }}>
          <div style={{ position: "relative", height: 28, marginBottom: 8 }}>
            {active && [0, 1, 2].map((i) => (
              <div
                key={i}
                style={{
                  position: "absolute",
                  left: "50%",
                  top: "50%",
                  width: 18,
                  height: 18,
                  marginLeft: -9,
                  marginTop: -9,
                  borderRadius: "50%",
                  border: "1.5px solid rgba(254, 108, 28, 0.45)",
                  animation: `mp-voice-ring 2.2s ${i * 0.65}s ease-out infinite`,
                }}
              />
            ))}
          </div>
          <div style={{ fontSize: 22, fontWeight: 700, color: phase === "parsing" ? "#fe6c1c" : C.ink }}>
            {phase === "parsing" ? t("voice.parsing", transcript) : t("voice.listening")}
          </div>
          <div
            style={{
              marginTop: 16,
              minHeight: 72,
              fontSize: 20,
              fontWeight: 600,
              color: transcript ? C.ink : C.mut,
              lineHeight: 1.4,
              wordBreak: "break-word",
            }}
          >
            {phase === "parsing" ? null : (transcript || t("voice.listeningPlaceholder"))}
          </div>
          <div style={{ fontSize: 13, color: C.mut, marginTop: 12 }}>
            {active ? t("voice.fabListeningHint") : t("voice.listeningHint")}
          </div>
        </Card>
      </div>
    );
  }

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 18, flex: 1 }}>
      <div style={{ display: "flex", alignItems: "flex-start", justifyContent: "space-between", gap: 12 }}>
        <div style={{ minWidth: 0 }}>
          <h2 style={{ fontSize: 26, fontWeight: 700, color: C.ink, margin: 0, letterSpacing: -0.4 }}>{t("voice.title")}</h2>
          <p style={{ fontSize: 15, color: C.mut, marginTop: 6 }}>{t("voice.subtitle")}</p>
        </div>
        {overlay && onClose && (
          <button
            type="button"
            onClick={() => {
              stopListen();
              onClose();
            }}
            aria-label={t("voice.cancel")}
            style={{
              width: 36,
              height: 36,
              borderRadius: 12,
              border: `1px solid ${C.line}`,
              background: C.bg,
              color: C.ink,
              cursor: "pointer",
              fontSize: 20,
              lineHeight: 1,
              fontFamily: "inherit",
              flexShrink: 0,
            }}
          >
            ×
          </button>
        )}
      </div>

      {(phase === "idle" || phase === "listening" || phase === "parsing") && (
        <>
          <Card style={{ display: "grid", placeItems: "center", padding: "36px 20px 28px" }}>
            <div style={{ position: "relative", width: 176, height: 176, display: "grid", placeItems: "center" }}>
              {active && [0, 1, 2].map((i) => (
                <div
                  key={i}
                  style={{
                    position: "absolute",
                    inset: 18,
                    borderRadius: "50%",
                    border: "1.5px solid rgba(254, 108, 28, 0.45)",
                    animation: `mp-voice-ring 2.2s ${i * 0.65}s ease-out infinite`,
                  }}
                />
              ))}
              <button
                onClick={active ? stopListen : listen}
                className={`mp-chrome-orb${active ? " is-listening" : ""}`}
                disabled={phase === "parsing"}
                aria-label={active ? t("voice.listening") : t("nav.voiceAria")}
              >
                {phase === "parsing" ? (
                  <span style={{ fontSize: 28, fontWeight: 700, letterSpacing: 2 }}>···</span>
                ) : (
                  <IconMic size={42} />
                )}
              </button>
            </div>
            <div style={{ marginTop: 18, textAlign: "center", width: "100%", maxWidth: 320 }}>
              {phase === "idle" && <span style={{ fontSize: 14.5, color: C.mut }}>{t("voice.idleHint")}</span>}
              {active && (
                <>
                  <div style={{ fontSize: 13, fontWeight: 700, color: "#fe6c1c", letterSpacing: 0.2 }}>{t("voice.listening")}</div>
                  <div
                    style={{
                      marginTop: 10,
                      minHeight: 52,
                      fontSize: 18,
                      fontWeight: 600,
                      color: C.ink,
                      lineHeight: 1.35,
                      wordBreak: "break-word",
                    }}
                  >
                    {transcript || t("voice.listeningPlaceholder")}
                  </div>
                  <div style={{ fontSize: 12.5, color: C.mut, marginTop: 8 }}>{t("voice.listeningHint")}</div>
                </>
              )}
              {phase === "parsing" && (
                <span style={{ fontSize: 14.5, color: "#fe6c1c", fontWeight: 600 }}>{t("voice.parsing", transcript)}</span>
              )}
            </div>
          </Card>

          <Card>
            <div style={{ fontSize: 13, fontWeight: 700, color: C.mut, marginBottom: 10 }}>{t("voice.orType")}</div>
            <div style={{ display: "flex", gap: 8 }}>
              <input
                value={manual}
                onChange={(e) => setManual(e.target.value)}
                onKeyDown={(e) => e.key === "Enter" && manual.trim() && analyze(manual.trim())}
                placeholder={t("voice.inputPlaceholder")}
                style={{
                  flex: 1,
                  background: C.card,
                  border: `1px solid ${C.line}`,
                  borderRadius: 12,
                  padding: "13px 14px",
                  fontSize: 15,
                  color: C.ink,
                  outline: "none",
                  fontFamily: "inherit",
                }}
              />
              <button
                onClick={() => manual.trim() && analyze(manual.trim())}
                style={{
                  ...btnOrange,
                  width: 52,
                  padding: 0,
                  background: C.orange,
                  boxShadow: "none",
                }}
              >
                →
              </button>
            </div>
            <button
              onClick={() => analyze(t("voice.exampleCommand"))}
              style={{ background: "none", border: "none", color: "#fe6c1c", fontSize: 13, fontWeight: 600, cursor: "pointer", padding: 0, marginTop: 12, fontFamily: "inherit" }}
            >
              {t("voice.tryExample")}
            </button>
            {claudeConfigured === false && (
              <div style={{ fontSize: 12, color: C.mut, marginTop: 10 }}>{t("voice.noApiKeyHint")}</div>
            )}
          </Card>
        </>
      )}

      {phase==='choose_recipient' && parsed && <Card>
        <h3>{lang==='en'?'Choose the recipient':'Elegí el destinatario'}</h3>
        <p>{lang==='en'?'Several contacts have that name. No transfer has been sent.':'Hay varios contactos con ese nombre. Todavía no se envió la transferencia.'}</p>
        {parsed.recipients.map(contact=><button key={contact.id || contact.alias} onClick={()=>{setParsed(previous=>({...previous,contact}));setPhase('confirm');}}
          style={{display:'block',width:'100%',textAlign:'left',padding:14,marginBottom:8,font:'inherit',overflowWrap:'anywhere'}}>
          {contact.name} · @{contact.alias}<br/>{contact.addr}
        </button>)}
        <button onClick={reset}>Cancelar</button>
      </Card>}
      {phase === "confirm" && parsed && (
        <>
          <Card>
            <div style={{ fontSize: 13.5, color: C.mut }}>«{transcript}»</div>
            <div style={{ display: "flex", alignItems: "center", gap: 13, margin: "18px 0" }}>
              <div
                style={{
                  width: 46,
                  height: 46,
                  borderRadius: "50%",
                  background: C.orangeSoft,
                  display: "grid",
                  placeItems: "center",
                  color: "#fe6c1c",
                  fontWeight: 700,
                  fontSize: 15,
                }}
              >
                {parsed.contact.name.slice(0, 1).toUpperCase()}
              </div>
              <div style={{ flex: 1 }}>
                <div style={{ fontSize: 16.5, fontWeight: 700, color: C.ink }}>{parsed.contact.name}</div>
                <div style={{ fontSize: 13, color: C.mut, fontFamily: "ui-monospace, monospace" }}>{short(parsed.contact.addr)}</div>
              </div>
            </div>
            <div style={{ borderTop: `1px solid ${C.line}`, paddingTop: 16, display: "grid", gap: 10 }}>
              {[
                [t("voice.amount"), `${fmt(parsed.usdc, 2, locale)} USDC`],
                parsed.currency === "ARS" ? [t("voice.equals"), `$${fmtArs(parsed.amount)} ARS`] : [t("voice.equals"), `$${fmtArs(parsed.usdc * parsed.fxRate)} ARS`],
                [t("voice.exchangeRate"), `1 USDC = $${fmtArs(parsed.fxRate)} ARS`],
                [t("voice.invoice"), parsed.factura],
                [t("voice.network"), `Solana ${SOLANA.cluster}`],
              ].map(([k, v]) => (
                <div key={k} style={{ display: "flex", justifyContent: "space-between", fontSize: 14.5 }}>
                  <span style={{ color: C.mut }}>{k}:</span>
                  <span style={{ color: C.ink, fontWeight: 600 }}>{v}</span>
                </div>
              ))}
            </div>
            <p style={{fontSize:13,color:C.mut}}>Costo para vos: 0 SOL. MidatoPay cubre la red. Máximo 2 envíos diarios.</p>
          </Card>
          <div style={{ display: "flex", flexDirection: "column", gap: 10 }}>
            <button
              onClick={execute}
              disabled={!address}
              style={{
                ...btnOrange,
                opacity: !address ? 0.5 : 1,
                background: "linear-gradient(180deg, #ffb58d, #fe6c1c)",
                boxShadow: "0 10px 22px rgba(254,108,28,.28)",
              }}
            >
              {t("voice.confirmSend")}
            </button>
            <button onClick={reset} style={{ ...btnOutline, border: "none", color: C.mut }}>{t("voice.cancel")}</button>
          </div>
        </>
      )}

      {phase === "sending" && (
        <Card style={{ textAlign: "center", padding: 40 }}>
          <div className="mp-chrome-orb" style={{ width: 72, height: 72, margin: "0 auto 18px", pointerEvents: "none" }}>
            <IconMic size={28} />
          </div>
          <div style={{ fontSize: 16, fontWeight: 700, color: C.ink }}>{t("voice.sending")}</div>
          <div style={{ fontSize: 14, color: C.mut, marginTop: 8 }}>{t("voice.sendingHint")}</div>
        </Card>
      )}

      {phase === "error" && (
        <>
          <Card style={{ borderLeft: `4px solid ${C.red}`, background: "#FFF6F4" }}>
            <div style={{ fontSize: 15, color: C.ink, lineHeight: 1.5 }}>{errMsg}</div>
          </Card>
          <button
            onClick={reset}
            style={{
              ...btnOrange,
              background: "linear-gradient(180deg, #ffb58d, #fe6c1c)",
              boxShadow: "0 10px 22px rgba(254,108,28,.28)",
            }}
          >
            {t("voice.retry")}
          </button>
        </>
      )}
    </div>
  );
}

// ————— Detalle de transacción (compartido: Success + TxCard) —————
function TxDetail({ usdc, ars, fx, fee, block, factura, hash, time, hideFx = false }) {
  const { t, locale } = useLanguage();
  return (
    <div style={{ marginTop: 18 }}>
      <div style={{ fontSize: 17, fontWeight: 700, color: C.ink, marginBottom: 14 }}>{t("success.operation")}</div>
      <div style={{ display: "grid", gap: 10, fontSize: 14.5 }}>
        {[
          hideFx ? null : [t("success.amountSent"), `${fmt(usdc, 2, locale)} USDC`],
          [hideFx ? t("guest.youPay") : t("success.equals"), `$${fmtArs(ars)} ARS`],
          hideFx ? null : [t("success.exchangeRate"), `1 USDC = $${fmtArs(fx)} ARS`],
          hideFx ? null : [t("success.networkFee"), fee ? `${Number(fee).toFixed(6)} USDC` : "—"],
          block ? [t("success.block"), String(block)] : null,
          [t("success.time"), time],
        ].filter(Boolean).map(([k, v]) => (
          <div key={k} style={{ display: "flex", justifyContent: "space-between" }}>
            <span style={{ color: C.mut }}>{k}:</span>
            <span style={{ color: C.ink, fontWeight: 600 }}>{v}</span>
          </div>
        ))}
      </div>
      <div style={{ borderTop: `1px solid ${C.line}`, marginTop: 16, paddingTop: 14 }}>
        <div style={{ display: "flex", justifyContent: "space-between", fontSize: 14.5 }}>
          <span style={{ color: C.mut }}>{t("success.invoiceLabel")}</span>
          <span style={{ color: C.green, fontWeight: 700 }}>{factura} · {t("success.onchainCheck")}</span>
        </div>
        <a href={explorerTxUrl(hash)} target="_blank" rel="noreferrer" style={{ display: "block", marginTop: 12, fontSize: 13.5, color: "#fe6c1c", fontWeight: 600, textDecoration: "none", wordBreak: "break-all" }}>
          {t("success.viewOnExplorer", short(hash))}
        </a>
      </div>
    </div>
  );
}

// ————— Éxito a pantalla completa —————
function Success({ receipt, onClose, hideFx = false }) {
  const { t, locale } = useLanguage();
  const [detalle, setDetalle] = useState(false);
  const [splash, setSplash] = useState(true);
  const kind = receipt.kind || "voice";

  useEffect(() => {
    const timer = setTimeout(() => setSplash(false), 1800);
    return () => clearTimeout(timer);
  }, []);

  const isChargeIn = kind === "charge" || kind === "charge_mercadopago" || (kind === "charge_p2p" && receipt.direction === "in");

  const splashTitle =
    hideFx ? t("guest.successSplash")
      : isChargeIn ? t("success.splashCharge")
        : kind === "convert_ars_usdc" || kind === "convert_usdc_ars" ? t("success.splashConvert")
          : t("success.splashTitle");

  const summary = () => {
    if (hideFx) {
      const p = receipt.parsed || {};
      const who = p.contact?.name || t("guest.merchant");
      return t("guest.paidSummary", who, fmtArs(p.amount ?? receipt.ars));
    }
    if (isChargeIn) return t("success.chargeSummary", fmtArs(receipt.ars), fmt(receipt.usdc, 2, locale));
    if (kind === "convert_ars_usdc") return t("success.convertArsUsdcSummary", fmtArs(receipt.ars), fmt(receipt.usdc, 2, locale));
    if (kind === "convert_usdc_ars") return t("success.convertUsdcArsSummary", fmt(receipt.usdc, 2, locale), fmtArs(receipt.ars));
    const p = receipt.parsed;
    return t("success.sentSummary", fmt(p.usdc, 2, locale), p.contact.name);
  };

  const nextTab = isChargeIn ? "charge" : kind?.startsWith("convert") ? "convert" : kind === "pay" ? "send" : kind === "charge_p2p" ? "pay" : "voice";
  const nextLabel = isChargeIn ? t("success.anotherCharge") : kind?.startsWith("convert") ? t("success.anotherConvert") : t("success.anotherPayment");

  if (splash) {
    return (
      <div className="mp-overlay" style={{ background: C.green, flexDirection: "column", gap: 24 }}>
        <div style={{ fontSize: 30, fontWeight: 700, color: "#fff", textAlign: "center", padding: "0 24px" }}>{splashTitle}</div>
        <div style={{ width: 74, height: 74, borderRadius: "50%", background: "#fff", display: "grid", placeItems: "center", color: C.green, fontSize: 38 }}>✓</div>
      </div>
    );
  }

  const p = receipt.parsed || {};
  const fx = receipt.fxRate || p.fxRate || FALLBACK_FX_ARS_USD;
  const usdc = receipt.usdc ?? p.usdc;
  const ars = receipt.ars ?? (usdc * fx);

  if (hideFx) {
    return (
      <div
        style={{
          display: "flex",
          flexDirection: "column",
          alignItems: "center",
          justifyContent: "center",
          textAlign: "center",
          minHeight: "70%",
          padding: "32px 18px 24px",
          boxSizing: "border-box",
          gap: 16,
        }}
      >
        <div style={{ width: 72, height: 72, borderRadius: "50%", background: C.green, display: "grid", placeItems: "center", color: "#fff", fontSize: 34 }}>✓</div>
        <div style={{ fontSize: 26, fontWeight: 700, color: C.ink, letterSpacing: -0.3 }}>{t("guest.successTitle")}</div>
        <div style={{ fontSize: 17, fontWeight: 600, color: C.ink, lineHeight: 1.45, maxWidth: 280 }}>{summary()}</div>
      </div>
    );
  }

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 16 }}>
      <div style={{ display: "flex", alignItems: "center", gap: 12, marginTop: 8 }}>
        <div style={{ width: 44, height: 44, borderRadius: "50%", background: C.green, display: "grid", placeItems: "center", color: "#fff", fontSize: 22 }}>✓</div>
        <div style={{ fontSize: 26, fontWeight: 700, color: C.ink }}>{t("success.doneTitle")}</div>
      </div>

      <Card>
        <div style={{ fontSize: 18, fontWeight: 700, color: C.ink, lineHeight: 1.35 }}>{summary()}</div>
        {kind === "charge_mercadopago" && <div style={{marginTop:12,fontSize:13,overflowWrap:"anywhere"}}>
          Orden Mercado Pago: {receipt.orderId}<br/>Comisión de conversión: $ {receipt.feeArs} ARS (0,5%)
        </div>}
        {kind === "convert_usdc_ars" && (
          <div style={{ marginTop: 12, padding: "12px 14px", background: C.orangeSoft, borderRadius: 12, fontSize: 14, color: "#fe6c1c", lineHeight: 1.45, display: "flex", alignItems: "center", gap: 8 }}>
            <img src="/monedas/ars.png" alt="" width={20} height={20} style={{ width: 20, height: 20, borderRadius: "50%" }} />
            {t("success.arsCredited", fmtArs(ars))}
          </div>
        )}
        <button
          onClick={() => setDetalle(!detalle)}
          style={{ background: C.orangeSoft, color: "#fe6c1c", border: "none", borderRadius: 20, padding: "6px 14px", fontSize: 13, fontWeight: 600, cursor: "pointer", marginTop: 12, fontFamily: "inherit" }}
        >
          {t("success.viewDetail")} {detalle ? "⌃" : "⌄"}
        </button>

        {detalle && (
          <TxDetail
            usdc={usdc}
            ars={ars}
            fx={fx}
            fee={receipt.fee}
            block={receipt.block}
            factura={receipt.factura}
            hash={receipt.hash}
            time={receipt.ts}
          />
        )}
      </Card>

      <div style={{ display: "flex", flexDirection: "column", gap: 10 }}>
        <button
          onClick={() => onClose(nextTab)}
          style={{
            ...btnOrange,
            background: C.orange,
            boxShadow: "none",
          }}
        >
          {nextLabel}
        </button>
        <button onClick={() => onClose("home")} style={btnOutline}>{t("success.backHome")}</button>
      </div>
    </div>
  );
}

// ————— Movimientos —————
/** Card de movimiento — home (compact) y pantalla Movimientos. */
function TxCard({ tx, compact = false, onOpenTransfer }) {
  const { t, locale } = useLanguage();
  const [expanded, setExpanded] = useState(false);
  const inbound = tx.direction === "in";
  const isConvert = tx.kind === "convert_ars_usdc" || tx.kind === "convert_usdc_ars";
  const arsEq = tx.ars;
  const pendingCharge=tx.source==="mercadopago" && tx.settled===false;
  const receivedCharge=tx.source==="mercadopago" && paymentReceived(tx);
  const noticeKey=tx.source==="mercadopago"?deliveryNoticeKey(tx):null;
  const statusKey=activityStatusKey(tx);
  const signature=tx.signature || (!tx.hash?.startsWith("charge:") ? tx.hash : null);

  const title = tx.source==="mercadopago" ? tx.who : isConvert
    ? tx.kind === "convert_ars_usdc"
      ? "ARS → USDC"
      : "USDC → ARS"
    : tx.kind === "charge" || tx.kind === "charge_mercadopago" || (tx.kind === "charge_p2p" && inbound)
      ? t("movs.charge")
      : tx.who;

  const primary = receivedCharge
    ? `+${fmtArs(arsEq)} ARS`
    : pendingCharge
    ? `${t("movs.toReceive")}: ${fmt(tx.amt, 6, locale)} USDC`
    : isConvert && tx.kind === "convert_ars_usdc"
      ? `+${fmt(tx.amt, 2, locale)} USDC`
      : isConvert && tx.kind === "convert_usdc_ars"
        ? `−${fmt(tx.amt, 2, locale)} USDC`
        : `${inbound ? "+" : "−"}${fmt(tx.amt, tx.source==='transfer'?6:2, locale)} USDC`;

  const secondary = receivedCharge
    ? `${t(pendingCharge?"movs.pendingUsdc":"movs.creditedUsdc")}: ${fmt(tx.amt,6,locale)} USDC`
    : pendingCharge
    ? `${fmtArs(arsEq)} ARS`
    : isConvert && tx.kind === "convert_ars_usdc"
      ? `−${fmtArs(arsEq)} ARS`
      : isConvert && tx.kind === "convert_usdc_ars"
        ? `+${fmtArs(arsEq)} ARS`
        : `${inbound ? "+" : "−"}${fmtArs(arsEq)} ARS`;

  const iconBg = isConvert ? C.orangeSoft : inbound ? C.orangeSoft : C.violetSoft;
  const iconColor = isConvert ? "#fe6c1c" : inbound ? C.orange : C.violet;

  const time = tx.createdAt
    ? new Date(tx.createdAt).toLocaleString(locale, { dateStyle: "medium", timeStyle: "short" })
    : "—";

  return (
    <Card style={{ padding: compact ? 16 : 18 }}>
      <div
        onClick={compact ? undefined : () => setExpanded((v) => !v)}
        style={{ display: "flex", alignItems: "center", gap: 13, flexWrap:tx.source==="mercadopago"?"wrap":undefined, cursor: compact ? "default" : "pointer" }}
      >
        <div
          style={{
            width: 42,
            height: 42,
            borderRadius: "50%",
            background: iconBg,
            display: "grid",
            placeItems: "center",
            color: iconColor,
            flexShrink: 0,
          }}
        >
          {isConvert ? <IconSwap size={18} /> : inbound ? <IconArrowDown size={18} /> : <IconArrowUp size={18} />}
        </div>
        <div style={{ flex: 1, minWidth: 0 }}>
          <div style={{ fontSize: 15.5, fontWeight: 700, color: C.ink, whiteSpace:tx.source==="mercadopago"?"normal":"nowrap" }}>{title}</div>
          {tx.transferId && onOpenTransfer && <button onClick={event=>{event.stopPropagation();onOpenTransfer(tx.transferId);}} style={{font:'inherit',fontSize:12,marginTop:6}}>Ver estado del envío</button>}
          {statusKey && <div style={{fontSize:12,color:C.mut,marginTop:4}}>{t(`movs.${statusKey}`)}</div>}
          {noticeKey && <div style={{fontSize:12,color:C.mut,marginTop:6,lineHeight:1.5}}>{t(`movs.${noticeKey}`)}</div>}
        </div>
        <div style={{ textAlign: "right", flexShrink: 0, ...(tx.source==="mercadopago"?{flexBasis:"100%"}:{}) }}>
          <div style={{ fontSize: 15.5, fontWeight: 700, color: C.ink }}>{primary}</div>
          <div style={{ fontSize: 13, color: C.mut, marginTop: 2 }}>{secondary}</div>
          {!compact && signature && (
            <a
              href={explorerTxUrl(signature)}
              target="_blank"
              rel="noreferrer"
              onClick={(e) => e.stopPropagation()}
              style={{
                display: "inline-block",
                marginTop: 8,
                textDecoration: "none",
                fontFamily: "inherit",
                fontSize: 12,
                fontWeight: 700,
                color: C.ink,
                background: C.card,
                border: `1.5px solid ${C.line}`,
                borderRadius: 8,
                padding: "5px 10px",
              }}
            >
              Solana Explorer ↗
            </a>
          )}
        </div>
      </div>

      {!compact && expanded && (
        pendingCharge ? <div style={{marginTop:12,fontSize:13,color:C.mut,overflowWrap:"anywhere"}}>
          {tx.factura}<br/>{tx.orderId}<br/>{time}
        </div> : <TxDetail
          usdc={tx.amt}
          ars={tx.ars}
          fx={tx.fxRate}
          fee={tx.fee}
          block={tx.block}
          factura={tx.factura}
          hash={tx.hash}
          time={time}
        />
      )}
    </Card>
  );
}

function Movimientos({ txs, address, onOpenTransfer }) {
  const { t } = useLanguage();
  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 12 }}>
      <div>
        <h2 style={{ fontSize: 26, fontWeight: 700, color: C.ink, margin: 0, letterSpacing: -0.4 }}>{t("movs.title")}</h2>
        <p style={{ fontSize: 14.5, color: C.mut, marginTop: 6 }}>
          {txs.length === 0 ? t("movs.countEmpty") : t("movs.countN", txs.length)}
        </p>
      </div>

      {txs.length === 0 ? (
        <Card style={{ fontSize: 14, color: C.mut, lineHeight: 1.55 }}>{t("movs.emptyBody")}</Card>
      ) : (
        txs.map((tx) => <TxCard key={tx.hash} tx={tx} onOpenTransfer={onOpenTransfer} />)
      )}

      <a
        href={explorerAddressUrl(address)}
        target="_blank"
        rel="noreferrer"
        style={{
          ...btnOutline,
          textDecoration: "none",
          textAlign: "center",
          display: "block",
          border: `1.5px solid ${C.line}`,
          color: C.ink,
          background: C.card,
        }}
      >
        {t("movs.viewFullHistory")}
      </a>
    </div>
  );
}

// ————— Más (menú) —————
function Mas({ email, address, nombre, onLogout, goStack, goReports, privyId, treasuryAddress, merchantProfile, treasuryExportAccess }) {
  const { t, lang, setLang } = useLanguage();
  const [confirmar, setConfirmar] = useState(false);
  const [copied, setCopied] = useState(false);

  const copyAddress = async () => {
    try {
      await navigator.clipboard.writeText(address);
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    } catch {}
  };

  const Fila = ({ icon, titulo, sub, onClick, href, danger }) => {
    const inner = (
      <>
        <div
          style={{
            width: 40,
            height: 40,
            borderRadius: 12,
            background: danger ? "#FDECEA" : C.orangeSoft,
            display: "grid",
            placeItems: "center",
            color: danger ? C.red : "#fe6c1c",
            flexShrink: 0,
          }}
        >
          {icon}
        </div>
        <div style={{ flex: 1, minWidth: 0 }}>
          <div style={{ fontSize: 15.5, fontWeight: 600, color: danger ? C.red : C.ink }}>{titulo}</div>
          {sub && <div style={{ fontSize: 12.5, color: C.mut, marginTop: 1 }}>{sub}</div>}
        </div>
        <span style={{ color: C.mut, display: "grid", placeItems: "center" }}><IconChevron /></span>
      </>
    );
    const style = { display: "flex", alignItems: "center", gap: 13, padding: "14px 0", background: "none", border: "none", width: "100%", cursor: "pointer", textAlign: "left", fontFamily: "inherit", textDecoration: "none" };
    return href ? (
      <a href={href} target="_blank" rel="noreferrer" style={style}>{inner}</a>
    ) : (
      <button onClick={onClick} style={style}>{inner}</button>
    );
  };

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 16 }}>
      <h2 style={{ fontSize: 26, fontWeight: 700, color: C.ink, margin: 0, letterSpacing: -0.4 }}>{t("mas.title")}</h2>

      <Card style={{ display: "flex", alignItems: "center", gap: 14 }}>
        <div style={{ width: 52, height: 52, borderRadius: "50%", background: C.orangeSoft, display: "grid", placeItems: "center", color: "#fe6c1c", fontSize: 20, fontWeight: 700 }}>
          {(nombre || "?").slice(0, 1).toUpperCase()}
        </div>
        <div style={{ minWidth: 0, flex: 1 }}>
          <div style={{ fontSize: 17, fontWeight: 700, color: C.ink }}>{nombre}</div>
          <div style={{ fontSize: 13, color: C.mut, overflow: "hidden", textOverflow: "ellipsis" }}>{email || t("mas.noEmailAccount")}</div>
          <div style={{ display: "flex", alignItems: "center", gap: 8, marginTop: 6 }}>
            <span style={{ fontSize: 12, color: C.mut, fontFamily: "ui-monospace, monospace" }}>{short(address)}</span>
            <button
              onClick={copyAddress}
              style={{
                background: C.card,
                border: "none",
                borderRadius: 20,
                padding: "4px 12px",
                fontSize: 12,
                fontWeight: 600,
                color: "#fe6c1c",
                cursor: "pointer",
                fontFamily: "inherit",
                flexShrink: 0,
              }}
            >
              {copied ? t("home.copied") : t("home.copy")}
            </button>
          </div>
        </div>
      </Card>

      <Card><BusinessProfile profile={merchantProfile.profile} error={merchantProfile.error}
        onSave={merchantProfile.save} onRetry={merchantProfile.retry} /></Card>

      <InstallApp />

      <TreasuryWalletExport key={privyId} treasuryAddress={treasuryExportAccess?.address} authorized={treasuryExportAccess?.authorized===true} />

      <Card style={{ padding: "4px 20px" }}>
        {goReports && <Fila icon={<IconSearch />} titulo="Operaciones y comisiones" sub="Historial de todos los comercios" onClick={goReports} />}
        <Fila icon={<IconStack size={20} />} titulo={t("mas.stackTitle")} sub={t("mas.stackSub")} onClick={goStack} />
        <div style={{ height: 1, background: C.line }} />
        {SOLANA.cluster === "devnet" && <Fila icon={<IconFaucet />} titulo={t("mas.faucetTitle")} sub={t("mas.faucetSub")} href={SOLANA.faucet} />}
        <div style={{ height: 1, background: C.line }} />
        <Fila icon={<IconSearch />} titulo={t("mas.explorerTitle")} sub={t("mas.explorerSub")} href={explorerAddressUrl(address)} />
      </Card>

      <Card style={{ padding: "4px 20px" }}>
        <div style={{ display: "flex", alignItems: "center", gap: 13, padding: "14px 0" }}>
          <div style={{ width: 40, height: 40, borderRadius: 12, background: C.orangeSoft, display: "grid", placeItems: "center", color: "#fe6c1c" }}>
            <IconGlobe />
          </div>
          <div style={{ flex: 1, minWidth: 0 }}>
            <div style={{ fontSize: 15.5, fontWeight: 600, color: C.ink }}>{t("mas.languageTitle")}</div>
            <div style={{ fontSize: 12.5, color: C.mut, marginTop: 1 }}>{lang === "en" ? "English" : "Español"}</div>
          </div>
          <LangToggle />
        </div>
      </Card>

      <Card style={{ padding: "4px 20px" }}>
        <Fila icon={<IconLogout />} titulo={t("mas.logoutTitle")} danger onClick={() => setConfirmar(true)} />
      </Card>

      {privyId && <div style={{fontSize:12,color:C.mut,overflowWrap:"anywhere"}}>ID de usuario: {privyId}</div>}
      <p style={{ fontSize: 11.5, color: C.mut, textAlign: "center", lineHeight: 1.6 }}>
        {t("mas.footerLine1")}
        <br />
        {t("mas.footerLine2")}
      </p>

      {confirmar && (
        <div className="mp-overlay" style={{ background: "rgba(16,16,22,.45)", alignItems: "flex-end" }} onClick={() => setConfirmar(false)}>
          <div
            onClick={(e) => e.stopPropagation()}
            style={{ background: C.card, borderRadius: "24px 24px 0 0", padding: "26px 22px 30px", width: "100%" }}
          >
            <div style={{ width: 42, height: 4, borderRadius: 4, background: C.line, margin: "0 auto 20px" }} />
            <div style={{ fontSize: 19, fontWeight: 700, color: C.ink }}>{t("mas.logoutConfirmTitle")}</div>
            <div style={{ fontSize: 14.5, color: C.mut, marginTop: 8, lineHeight: 1.5 }}>{t("mas.logoutConfirmBody")}</div>
            <div style={{ display: "flex", flexDirection: "column", gap: 10, marginTop: 22 }}>
              <button onClick={onLogout} style={{ ...btnOrange, background: C.red }}>{t("mas.logoutConfirmBtn")}</button>
              <button onClick={() => setConfirmar(false)} style={{ ...btnOutline, border: `1.5px solid ${C.line}`, color: C.ink }}>{t("mas.cancel")}</button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

// ————— Stack —————
function Stack() {
  const { t, lang } = useLanguage();
  const STACK = lang === "en" ? STACK_EN : STACK_ES;
  const activos = STACK.filter((s) => s.on);
  const road = STACK.filter((s) => !s.on);

  const Item = ({ s }) => (
    <Card style={{ padding: 16 }}>
      <div style={{ display: "flex", alignItems: "center", gap: 9, marginBottom: 6 }}>
        <span style={{ width: 8, height: 8, borderRadius: "50%", background: s.on ? C.green : C.line, flexShrink: 0 }} />
        <span style={{ fontSize: 15.5, fontWeight: 700, color: C.ink }}>{s.name}</span>
        <span style={{ marginLeft: "auto", fontSize: 11.5, color: C.mut }}>{s.by}</span>
      </div>
      <div style={{ fontSize: 13.5, color: C.mut, lineHeight: 1.5 }}>{s.role}</div>
    </Card>
  );

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 12 }}>
      <div>
        <h2 style={{ fontSize: 26, fontWeight: 700, color: C.ink, margin: 0, letterSpacing: -0.4 }}>{t("stackScreen.title")}</h2>
        <p style={{ fontSize: 14.5, color: C.mut, marginTop: 6, lineHeight: 1.5 }}>{t("stackScreen.subtitle")}</p>
      </div>

      <div style={{ fontSize: 13, fontWeight: 700, color: C.green, marginTop: 4 }}>{t("stackScreen.implemented")}</div>
      {activos.map((s) => <Item key={s.name} s={s} />)}

      <div style={{ fontSize: 13, fontWeight: 700, color: C.mut, marginTop: 10 }}>{t("stackScreen.roadmap")}</div>
      {road.map((s) => <Item key={s.name} s={s} />)}
    </div>
  );
}

function errorMessage(t, field, reason) {
  if (field === "alias" && reason === "duplicate") return t("agenda.errors.aliasDuplicate");
  return t(`agenda.errors.${field}`);
}

// ————— Agenda —————
function ContactsScreen({ contacts, onAdd, onUpdate, onRemove, loadError, onRetry }) {
  const { t } = useLanguage();
  const [query, setQuery] = useState("");
  const [form, setForm] = useState(null); // null = cerrado; { } = nuevo o edición
  const [errors, setErrors] = useState({});
  const [copiedId, setCopiedId] = useState(null);
  const [saving, setSaving] = useState(false);

  const visible = searchContacts(contacts, query);
  const editingId = form?.id || null;

  const openNew = () => { setForm({ name: "", alias: "", addr: "", note: "" }); setErrors({}); };
  const openEdit = (c) => { setForm({ ...c }); setErrors({}); };
  const close = () => { setForm(null); setErrors({}); };

  const save = async () => {
    const check = validateContact(form, contacts, editingId);
    if (!check.valid) {
      setErrors(check.errors);
      return;
    }
    setSaving(true);
    try {
      if (editingId) await onUpdate(editingId, form);
      else await onAdd(form);
      close();
    } catch (err) {
      setErrors(err?.code === "alias_duplicate" ? { alias: "duplicate" } : { server: true });
    } finally {
      setSaving(false);
    }
  };

  const del = async () => {
    if (!editingId) return;
    setSaving(true);
    try {
      await onRemove(editingId);
      close();
    } catch {
      setErrors({ server: true });
    } finally {
      setSaving(false);
    }
  };

  const copy = async (c) => {
    try {
      await navigator.clipboard.writeText(c.addr);
      setCopiedId(c.id);
      setTimeout(() => setCopiedId(null), 1500);
    } catch {}
  };

  const field = (key, label, placeholder) => (
    <label style={{ display: "block" }}>
      <div style={{ fontSize: 13, fontWeight: 600, color: C.mut, marginBottom: 8 }}>{label}</div>
      <input
        value={form[key]}
        onChange={(e) => setForm({ ...form, [key]: e.target.value })}
        placeholder={placeholder}
        style={{
          width: "100%",
          background: errors[key] ? "#FDECEA" : C.card,
          border: errors[key] ? `1.5px solid ${C.red}` : `1px solid ${C.line}`,
          borderRadius: 14,
          padding: "14px 16px",
          fontSize: 15,
          color: C.ink,
          outline: "none",
          fontFamily: "inherit",
          boxSizing: "border-box",
        }}
      />
      {errors[key] && <div style={{ fontSize: 12.5, color: C.red, marginTop: 6 }}>{errorMessage(t, key, errors[key])}</div>}
    </label>
  );

  const primaryBtn = {
    ...btnOrange,
    background: "linear-gradient(180deg, #ffb58d, #fe6c1c)",
    boxShadow: "0 10px 22px rgba(254,108,28,.28)",
  };

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 16 }}>
      <div>
        <h2 style={{ fontSize: 26, fontWeight: 700, color: C.ink, margin: 0, letterSpacing: -0.4 }}>{t("agenda.title")}</h2>
        <p style={{ fontSize: 14.5, color: C.mut, marginTop: 6, lineHeight: 1.5 }}>{t("agenda.subtitle")}</p>
      </div>

      {loadError && <Card><div role="alert">{loadError}</div><button onClick={onRetry}>Volver a cargar</button></Card>}
      {!form && (
        <>
          <input
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder={t("agenda.searchPlaceholder")}
            style={{
              background: C.bg,
              border: `1px solid ${C.line}`,
              borderRadius: 14,
              padding: "13px 16px",
              fontSize: 15,
              color: C.ink,
              outline: "none",
              fontFamily: "inherit",
            }}
          />

          <button onClick={openNew} style={primaryBtn}>{t("agenda.addButton")}</button>

          {visible.length === 0 ? (
            <Card style={{ fontSize: 14, color: C.mut, lineHeight: 1.55 }}>
              <div style={{ fontWeight: 700, color: C.ink, marginBottom: 6 }}>{t("agenda.emptyTitle")}</div>
              {t("agenda.emptyBody")}
            </Card>
          ) : (
            visible.map((c) => (
              <Card key={c.id} style={{ padding: 16, display: "flex", alignItems: "center", gap: 13 }}>
                <button
                  onClick={() => openEdit(c)}
                  style={{ background: "none", border: "none", cursor: "pointer", display: "flex", alignItems: "center", gap: 13, flex: 1, minWidth: 0, textAlign: "left", fontFamily: "inherit", padding: 0 }}
                >
                  <span
                    style={{
                      width: 42,
                      height: 42,
                      borderRadius: "50%",
                      background: C.orangeSoft,
                      display: "grid",
                      placeItems: "center",
                      color: "#fe6c1c",
                      fontWeight: 700,
                      fontSize: 15,
                      flexShrink: 0,
                    }}
                  >
                    {c.name.slice(0, 1).toUpperCase()}
                  </span>
                  <span style={{ minWidth: 0 }}>
                    <div style={{ fontSize: 15.5, fontWeight: 600, color: C.ink }}>{c.name}</div>
                    <div style={{ fontSize: 13, color: C.mut }}>@{c.alias} · {short(c.addr)}</div>
                  </span>
                </button>
                <button
                  onClick={() => copy(c)}
                  style={{
                    background: C.card,
                    border: "none",
                    borderRadius: 20,
                    padding: "6px 12px",
                    fontSize: 12,
                    fontWeight: 600,
                    color: "#fe6c1c",
                    cursor: "pointer",
                    fontFamily: "inherit",
                    flexShrink: 0,
                  }}
                >
                  {copiedId === c.id ? t("agenda.copied") : t("agenda.copy")}
                </button>
              </Card>
            ))
          )}
        </>
      )}

      {form && (
        <Card style={{ display: "flex", flexDirection: "column", gap: 16 }}>
          {errors.server && (
            <div style={{ background: "#FDECEA", borderRadius: 12, padding: "12px 14px", fontSize: 13.5, color: C.red }}>
              {t("agenda.errors.server")}
            </div>
          )}
          {field("name", t("agenda.form.nameLabel"), t("agenda.form.namePlaceholder"))}
          {field("alias", t("agenda.form.aliasLabel"), t("agenda.form.aliasPlaceholder"))}
          {field("addr", t("agenda.form.addressLabel"), t("agenda.form.addressPlaceholder"))}
          {field("note", t("agenda.form.noteLabel"), t("agenda.form.notePlaceholder"))}

          <div style={{ display: "flex", flexDirection: "column", gap: 10, marginTop: 4 }}>
            <button onClick={save} disabled={saving} style={{ ...primaryBtn, opacity: saving ? 0.6 : 1 }}>
              {editingId ? t("agenda.form.save") : t("agenda.form.saveNew")}
            </button>
            <button onClick={close} disabled={saving} style={{ ...btnOutline, border: "none", color: C.mut }}>
              {t("agenda.form.cancel")}
            </button>
            {editingId && (
              <button
                onClick={del}
                disabled={saving}
                style={{ ...btnOutline, border: `1.5px solid ${C.red}`, color: C.red }}
              >
                {t("agenda.form.delete")}
              </button>
            )}
          </div>
        </Card>
      )}
    </div>
  );
}

// ————— App —————
function AppInner() {
  const { t, locale } = useLanguage();
  const { ready, authenticated, user, login, logout, getAccessToken } = usePrivy();
  const merchantProfile = useMerchantProfile(authenticated ? user?.id : null,getAccessToken);
  const { ready: walletInfrastructureReady } = useEvmWallets();
  const { ready: solanaWalletsReady, wallets } = useWallets();
  const { signAndSendTransaction } = useSignAndSendTransaction();
  const [tab, setTab] = useState("home");
  const [balance, setBalance] = useState(null);
  const [arsBalance, setArsBalance] = useState(0);
  const [treasuryBalance, setTreasuryBalance] = useState(null);
  const [txs, setTxs] = useState([]);
  const txsRef = useRef(txs);
  txsRef.current = txs;
  const [receipt, setReceipt] = useState(null);
  const [walletError, setWalletError] = useState("");
  const [fxRate, setFxRate] = useState(FALLBACK_FX_ARS_USD);
  const [voiceKick, setVoiceKick] = useState(0);
  const [voiceListening, setVoiceListening] = useState(false);
  const [voiceOpen, setVoiceOpen] = useState(false);
  const voiceApiRef = useRef(null);
  const [pendingScan, setPendingScan] = useState(null);
  const [guestMode, setGuestMode] = useState(false);
  const [guestInitialScan, setGuestInitialScan] = useState(null);
  const [pendingCharge, setPendingCharge] = useState(null);
  const [paymentAdmin,setPaymentAdmin]=useState(false);
  const [treasuryExportAccess,setTreasuryExportAccess]=useState(null);
  useEffect(()=>{
    let canceled=false;setTreasuryExportAccess(null);
    if(authenticated && user?.id)transferApi('/treasury/export-access',getAccessToken)
      .then(access=>{if(!canceled)setTreasuryExportAccess({userId:user.id,...access});}).catch(()=>{});
    return()=>{canceled=true;};
  },[authenticated,user?.id,getAccessToken]);
  useEffect(()=>{
    if (!ready || !authenticated || !user?.id) return;
    getAccessToken().then(token=>chargeApi("/merchant-pos",token,{method:"POST"}))
      .catch(error=>console.warn("[MidatoPay] Alta de caja pendiente",error.code || "service_unavailable"));
  },[ready,authenticated,user?.id,getAccessToken]);
  useEffect(()=>{
    let canceled=false;setPaymentAdmin(false);
    if(authenticated && user?.id) reportsApi("/payment-reports/access",getAccessToken)
      .then((result)=>{if(!canceled)setPaymentAdmin(result.authorized);}).catch(()=>{});
    return()=>{canceled=true;};
  },[authenticated,user?.id,getAccessToken]);
  const [payFullscreen, setPayFullscreen] = useState(false);

  useEffect(() => {
    const url = new URL(window.location.href);
    const wantsGuest = url.searchParams.get("guest") === "1" || url.searchParams.get("cliente") === "1";
    if (wantsGuest && SOLANA.cluster === "devnet") {
      setGuestMode(true);
      url.searchParams.delete("guest");
      url.searchParams.delete("cliente");
      window.history.replaceState({}, "", url.toString());
    }
  }, []);

  useEffect(() => {
    const parsed = parsePayUrl(window.location.href);
    if (!parsed) return;
    setPendingScan(parsed);
    setGuestInitialScan(parsed);
    if (ready && authenticated) {
      setTab("pay");
      const url = new URL(window.location.href);
      url.searchParams.delete("pay");
      window.history.replaceState({}, "", url.toString());
    }
  }, [ready, authenticated]);

  useEffect(() => {
    if (!guestMode || !guestInitialScan) return;
    const url = new URL(window.location.href);
    if (!url.searchParams.has("pay")) return;
    url.searchParams.delete("pay");
    window.history.replaceState({}, "", url.toString());
  }, [guestMode, guestInitialScan]);

  const [primaryRecord,setPrimaryRecord]=useState(null);
  const [primaryRevision,setPrimaryRevision]=useState(0);
  const linkedSolanaAddress=primarySolanaWallet(user)?.address || '';
  useEffect(()=>{
    let canceled=false;setPrimaryRecord(null);setWalletError('');
    if(authenticated && user?.id)transferApi('/wallet',getAccessToken)
      .then(({wallet:record})=>{if(!canceled)setPrimaryRecord({userId:user.id,...record});})
      .catch(()=>{if(!canceled)setWalletError('No se pudo verificar la wallet principal. Sincronizá tu sesión.');});
    return()=>{canceled=true;};
  },[authenticated,user?.id,getAccessToken,primaryRevision,linkedSolanaAddress]);
  const address=authenticated && user?.id && primaryRecord &&
    primaryRecord.userId===user.id && primaryRecord.address===linkedSolanaAddress ? primaryRecord.address : '';
  const wallet=useMemo(()=>wallets?.find(w=>w.address===address) || null,[wallets,address]);
  const {signTransaction}=useSignTransaction();
  const transferEngine=useSponsoredTransfers({userId:authenticated?user?.id:null,wallet,getAccessToken,signTransaction});
  const walletDebug = {
    privyReady: ready,
    authenticated,
    walletInfrastructureReady,
    solanaWalletsReady,
    linkedSolanaAddress: short(linkedSolanaAddress),
    selectedAddress: short(wallet?.address),
    addressMatch: Boolean(wallet && wallet.address === address),
    signerAvailable: typeof signAndSendTransaction === "function",
    connectedWallets: (wallets || []).map((w) => ({
      address: short(w.address),
      name: w.standardWallet?.name || "",
      clientType: w.walletClientType || "",
    })),
    linkedWallets: (user?.linkedAccounts || [])
      .filter((account) => account.type === "wallet")
      .map((account) => ({
        address: short(account.address),
        chainType: account.chainType || account.chain_type || "",
        clientType: account.walletClientType || "",
      })),
  };
  const walletDebugSignature = JSON.stringify(walletDebug);
  const lastWalletDebugSignature = useRef("");
  useEffect(() => {
    if (lastWalletDebugSignature.current === walletDebugSignature) return;
    lastWalletDebugSignature.current = walletDebugSignature;
    console.info("[MidatoPay wallet] Estado de Privy", walletDebug);
  }, [walletDebugSignature]);
  const [treasuryAddress, setTreasuryAddress] = useState(() => getTreasuryAddress());
  useEffect(() => {
    refreshTreasuryStatus().then((st) => setTreasuryAddress(st.address));
  }, []);
  const email = user?.email?.address || user?.phone?.number || "";
  const nombre = merchantProfile.profile?.userName || userDisplayName(user);
  const merchantName = merchantDisplayName(merchantProfile.profile?.businessName,nombre);
  const openTransfer=async id=>{try{const {transfer}=await transferApi(`/transfers/${id}`,getAccessToken);setReceipt({transfer});}catch(error){setWalletError(error.message);}};
  const activityTxs = txs.map(tx => tx.source === "mercadopago" ? {...tx,who:merchantName} : tx);

  useEffect(() => {
    setArsBalance(loadArsBalance(address));
  }, [address]);

  const [contacts, setContacts] = useState([]);
  const [contactsError,setContactsError]=useState('');
  const [contactsRevision,setContactsRevision]=useState(0);
  const currentContactOwner=useRef(user?.id);currentContactOwner.current=user?.id;
  const contactsRef = useRef(contacts);
  contactsRef.current = contacts;

  useEffect(() => {
    if (!user?.id) {
      setContacts([]);
      return;
    }
    let cancelled = false;setContacts([]);setContactsError('');
    getAccessToken()
      .then((token) =>
        loadContacts(user.id, token, (cached) => {
          if (!cancelled) setContacts(cached);
        })
      )
      .then((fresh) => {
        if (!cancelled) setContacts(fresh);
      })
      .catch(() => {if(!cancelled)setContactsError('No se pudo actualizar la agenda. Los contactos visibles pueden estar desactualizados.');});
    return () => {
      cancelled = true;
    };
  }, [user?.id, getAccessToken, tab, contactsRevision]);

  useEffect(() => {
    if (!user?.id || !["home","movs"].includes(tab)) return;
    let cancelled = false;
    getAccessToken()
      .then((token) =>
        loadTransactions(user.id, token, address, (cached) => {
          if (!cancelled) setTxs((prev) => mergeByHash(cached, prev));
        })
      )
      .then((fresh) => {
        if (!cancelled) setTxs((prev) => mergeByHash(fresh, prev));
      })
      .catch(() => {});
    return () => {
      cancelled = true;
    };
  }, [user?.id, address, getAccessToken, tab]);

  const activityPollMs=activityRefreshInterval(txs);
  useEffect(()=>{
    if(!user?.id || !["home","movs"].includes(tab) || !activityPollMs)return;
    let cancelled=false,timer;
    const poll=async()=>{
      try {
        const token=await getAccessToken();
        // Read persisted Activity only: do not run a wallet RPC scan each tick.
        const fresh=await loadTransactions(user.id,token);
        if(!cancelled)setTxs(prev=>mergeByHash(fresh,prev));
      } catch { /* Keep the last persisted Activity when authentication is temporarily unavailable. */ }
      finally {if(!cancelled)timer=setTimeout(poll,activityPollMs);}
    };
    timer=setTimeout(poll,activityPollMs);
    return ()=>{cancelled=true;clearTimeout(timer);};
  },[user?.id,getAccessToken,tab,activityPollMs]);

  const handleAddContact = useCallback(
    async (data) => {
      const token = await getAccessToken();
      if(currentContactOwner.current!==user.id)throw new Error('La sesión cambió.');
      const next = await addContact(user.id, token, contactsRef.current, data);
      if(currentContactOwner.current===user.id)setContacts(next);
    },
    [user?.id, getAccessToken]
  );

  const handleUpdateContact = useCallback(
    async (id, data) => {
      const token = await getAccessToken();
      if(currentContactOwner.current!==user.id)throw new Error('La sesión cambió.');
      const next = await updateContact(user.id, token, contactsRef.current, id, data);
      if(currentContactOwner.current===user.id)setContacts(next);
    },
    [user?.id, getAccessToken]
  );

  const handleRemoveContact = useCallback(
    async (id) => {
      const token = await getAccessToken();
      if(currentContactOwner.current!==user.id)throw new Error('La sesión cambió.');
      const next = await removeContact(user.id, token, contactsRef.current, id);
      if(currentContactOwner.current===user.id)setContacts(next);
    },
    [user?.id, getAccessToken]
  );

  // Tipo de cambio ARS/USD desde Chainlink (Ethereum Mainnet) vía latestAnswer().
  useEffect(() => {
    let alive = true;
    const loadFx = async () => {
      const rate = await getArsPerUsdc();
      if (alive) setFxRate(rate);
    };
    loadFx();
    const id = setInterval(loadFx, 60_000);
    return () => {
      alive = false;
      clearInterval(id);
    };
  }, []);

  const refreshBalances = useCallback(async () => {
    if (!address) return;
    try {
      const [{ userUsdc, treasuryUsdc }, rate] = await Promise.all([
        refreshPairBalances(address),
        getArsPerUsdc(),
      ]);
      setBalance(userUsdc);
      setTreasuryBalance(treasuryUsdc);
      setFxRate(rate);
    } catch {
      /* el RPC puede limitar consultas */
    }
  }, [address]);

  useEffect(() => {
    if (!address) return;
    refreshBalances();
    const id = setInterval(refreshBalances, 45000);
    return () => clearInterval(id);
  }, [address, refreshBalances]);

  const pendingBalanceUpdates=useRef({userId:null,ids:new Set()});
  useEffect(()=>{
    const previous=pendingBalanceUpdates.current;
    const finalized=previous.userId===user?.id && txs.some(tx=>tx.source==="mercadopago" && tx.settled===true && previous.ids.has(tx.chargeId));
    pendingBalanceUpdates.current={userId:user?.id,ids:new Set(txs.filter(tx=>tx.source==="mercadopago" && tx.settled===false).map(tx=>tx.chargeId))};
    if(finalized)refreshBalances();
  },[txs,user?.id,refreshBalances]);

  const applyArsDelta = useCallback(
    (delta) => { 
      setArsBalance((prev) => {
        const next = Math.max(0, (prev || 0) +  delta);
        persistArsBalance(address, next);
        return next;
      });
    },
    [address]
  );

  const pushTx = useCallback(
    (entry) => {
      const withTimestamp = { ...entry, createdAt: new Date().toISOString() };
      setTxs((t) => [withTimestamp, ...t]);
      if (!user?.id) return;
      getAccessToken()
        .then((token) => addTransaction(user.id, token, txsRef.current, withTimestamp))
        .catch(() => {});
    },
    [user?.id, getAccessToken]
  );

  const sendPayment=useCallback(async parsed=>{
    if(!wallet || wallet.address!==address)throw new Error(t('home.walletUnavailable'));
    const transfer=await transferEngine.send(parsed);
    getAccessToken().then(token=>loadTransactions(user.id,token)).then(fresh=>{
      if(currentContactOwner.current===user.id)setTxs(previous=>mergeByHash(fresh,previous));
    }).catch(()=>{});
    return {transfer,transferId:transfer.id,hash:transfer.signature,usdc:Number(transfer.usdc),ars:Number(transfer.ars),fxRate:Number(transfer.fxRate)};
  },[wallet,address,transferEngine.send,getAccessToken,user?.id,t]);

  const handleChargePaymentReceived = useCallback(async () => {
    const token = await getAccessToken();
    const fresh = await loadTransactions(user.id, token);
    setTxs(previous=>mergeByHash(fresh,previous));
  }, [getAccessToken, user?.id]);

  const handleChargeDelivered = useCallback(async () => {
    await handleChargePaymentReceived();
    await refreshBalances();
  }, [handleChargePaymentReceived, refreshBalances]);

  const handleConvertArsUsdc = useCallback(
    async (arsAmount) => {
      if (SOLANA.cluster !== "devnet") throw new Error("Conversión de prueba deshabilitada");
      const token = await getAccessToken();
      const result = await runConvertArsToUsdc({
        token,
        userAddress: address,
        arsAmount,
        arsBalance,
      });
      applyArsDelta(result.arsDelta);
      pushTx({
        hash: result.hash,
        who: t("convert.treasuryLabel"),
        amt: result.usdc,
        fxRate: result.fxRate,
        ars: result.ars,
        factura: result.factura,
        block: result.block,
        fee: result.fee,
        memo: result.memo,
        kind: "convert_ars_usdc",
        direction: "in",
      });
      await refreshBalances();
      return result;
    },
    [address, arsBalance, applyArsDelta, pushTx, refreshBalances, t, getAccessToken]
  );

  const handleConvertUsdcArs = useCallback(
    async (usdcAmount) => {
      if (SOLANA.cluster !== "devnet") throw new Error("Conversión de prueba deshabilitada");
      if (!wallet || wallet.address !== address) {
        console.error("[MidatoPay wallet] Conversión bloqueada: falta wallet conectada con la dirección vinculada", walletDebug);
        throw new Error(t("home.walletUnavailable"));
      }
      let result;
      try {
        result = await runConvertUsdcToArs({
          wallet,
          signAndSendTransaction,
          usdcAmount,
          userUsdcBalance: balance,
        });
      } catch (err) {
        console.error("[MidatoPay wallet] Falló la conversión USDC a ARS", {
          name: err?.name,
          code: err?.code,
          message: String(err?.message || err),
          walletAddress: short(wallet.address),
        });
        throw err;
      }
      applyArsDelta(result.arsDelta);
      pushTx({
        hash: result.hash,
        who: t("convert.treasuryLabel"),
        amt: result.usdc,
        fxRate: result.fxRate,
        ars: result.ars,
        factura: result.factura,
        block: result.block,
        fee: result.fee,
        memo: result.memo,
        kind: "convert_usdc_ars",
        direction: "out",
      });
      await refreshBalances();
      return result;
    },
    [wallet, address, signAndSendTransaction, balance, applyArsDelta, pushTx, refreshBalances, t, walletDebugSignature]
  );

  const navTabs = [
    { id: "home", label: t("nav.home"), icon: <IconHome /> },
    { id: "movs", label: t("nav.movements"), icon: <IconActivity /> },
    { id: "agenda", label: t("nav.agenda"), icon: <IconContacts /> },
    { id: "mas", label: t("nav.profile"), icon: <IconProfile /> },
  ];
  const navMid = Math.ceil(navTabs.length / 2);
  const goTab = (id) => {
    setReceipt(null);
    setPayFullscreen(false);
    setTab(id);
  };
  const closeVoice = () => {
    voiceApiRef.current?.stop?.();
    setVoiceOpen(false);
    setVoiceListening(false);
  };
  const handleVoiceCharge = (ars) => {
    closeVoice();
    setPendingCharge({ ars });
    goTab("charge");
  };
  const openVoiceListen = () => {
    setReceipt(null);
    if (voiceOpen && voiceListening) {
      closeVoice();
      return;
    }
    if (voiceOpen && voiceApiRef.current) {
      voiceApiRef.current.listen();
      return;
    }
    setVoiceOpen(true);
    setVoiceKick((n) => n + 1);
  };

  const shell = (children, { pad = true, nav = true } = {}) => (
    <div className="mp-stage">
      <div className={`mp-device${nav ? "" : " mp-no-nav"}`}>
        <div className="mp-scroll" style={{ padding: pad ? "22px 18px 24px" : 0 }}>
          {ready && authenticated && address && solanaWalletsReady && !wallet && (
            <Card style={{ marginBottom: 16, padding: 16, border: `1px solid ${C.red}` }}>
              <div style={{ fontSize: 14, fontWeight: 700, color: C.red }}>{t("home.walletUnavailableTitle")}</div>
              <div style={{ fontSize: 13, color: C.mut, marginTop: 6, lineHeight: 1.5 }}>{t("home.walletUnavailableBody")}</div>
              <button onClick={() => window.location.reload()} style={{ ...btnOutline, marginTop: 12 }}>
                {t("home.retryWallet")}
              </button>
            </Card>
          )}
          {transferEngine.recovery && <Card style={{marginBottom:12}}>
            <p>Hay una operación pendiente de recuperar.</p>
            <button onClick={async()=>{try{const transfer=await transferEngine.recover();if(transfer && !transfer.unsigned)setReceipt({transfer});else await transferEngine.discardUnsigned();}catch(e){setWalletError(e.message);}}}>Recuperar o descartar preparación sin enviar</button>
          </Card>}
          {children}
          <TransferApproval engine={{...transferEngine,network:SOLANA.cluster}} />
        </div>

        {voiceOpen && (
          <div className="mp-voice-sheet">
            <Voice
              sendPayment={sendPayment}
              balance={balance}
              onDone={(r) => {
                closeVoice();
                setReceipt(r);
              }}
              onCharge={handleVoiceCharge}
              fxRate={fxRate}
              address={address}
              contacts={contacts}
              getAccessToken={getAccessToken}
              voiceKick={voiceKick}
              onListeningChange={setVoiceListening}
              voiceApiRef={voiceApiRef}
              overlay
              onClose={closeVoice}
            />
          </div>
        )}

        {nav && (
          <nav className="mp-nav">
            {navTabs.slice(0, navMid).map((tItem) => (
              <NavButton key={tItem.id} active={tab === tItem.id && !voiceOpen} icon={tItem.icon} label={tItem.label} onClick={() => { closeVoice(); goTab(tItem.id); }} />
            ))}
            <div style={{ width: 64, flexShrink: 0 }} aria-hidden="true" />
            {navTabs.slice(navMid).map((tItem) => (
              <NavButton key={tItem.id} active={tab === tItem.id && !voiceOpen} icon={tItem.icon} label={tItem.label} onClick={() => { closeVoice(); goTab(tItem.id); }} />
            ))}
            <button
              onClick={openVoiceListen}
              className={`mp-fab${voiceListening ? " is-listening" : ""}`}
              aria-label={voiceListening ? t("voice.listening") : t("nav.voiceAria")}
            >
              <span className="mp-fab-shine" aria-hidden />
              <IconMic />
            </button>
          </nav>
        )}
      </div>
    </div>
  );

  if (guestMode && !authenticated && SOLANA.cluster === "devnet") {
    return (
      <GuestApp
        onExit={() => {
          setGuestMode(false);
          setGuestInitialScan(null);
        }}
        initialScan={guestInitialScan}
      />
    );
  }

  if (!ready || !authenticated || !user?.id) {
    return <AuthEntry onLogin={login} ready={ready} />;
  }

  // Con address en linkedAccounts ya entramos; no exigir wallet?.address
  // (useWallets a veces tarda y dejaba esta pantalla trabada para siempre).
  if (!address) {
    return shell(
      <Card style={{ textAlign: "center", padding: 40, marginTop: 40 }}>
        <div style={{ fontSize: 17, fontWeight: 700 }}>{t("home.creatingTitle")}</div>
        <div style={{ fontSize: 14, color: C.mut, marginTop: 8 }}>{t("home.creatingBody")}</div>
        <button onClick={()=>setPrimaryRevision(value=>value+1)} style={{...btnOutline,marginTop:16}}>Sincronizar wallet principal</button>
        {walletError && (
          <div style={{ fontSize: 13, color: C.red, marginTop: 16, lineHeight: 1.5, wordBreak: "break-word" }}>
            {walletError}
          </div>
        )}
      </Card>
    );
  }

  if (receipt?.transfer) return shell(<TransferReceipt key={receipt.transfer.id} transfer={receipt.transfer} getAccessToken={getAccessToken}
    onUpdate={transfer=>{if(['completed','failed'].includes(transfer.status)){
      refreshBalances();getAccessToken().then(token=>loadTransactions(user.id,token)).then(fresh=>{
        if(currentContactOwner.current===user.id)setTxs(previous=>mergeByHash(fresh,previous));
      }).catch(()=>{});
    }}}
    onClose={dest=>{setReceipt(null);setPayFullscreen(false);setTab(dest);}} />);
  if (receipt) {
    return shell(
      <Success
        receipt={receipt}
        onClose={(dest) => {
          setReceipt(null);
          setPayFullscreen(false);
          if (dest === "voice") openVoiceListen();
          else setTab(dest);
        }}
      />
    );
  }

  return shell(
    <>
      {walletError && <Card><div role="alert">{walletError}</div></Card>}
      {tab === "home" && (
        <Home
          nombre={nombre}
          address={address}
          balance={balance}
          arsBalance={arsBalance}
          txs={activityTxs}
          onOpenTransfer={openTransfer}
          goCharge={() => setTab("charge")}
          goConvert={() => setTab("convert")}
          goPay={() => { setPayFullscreen(true); setTab("pay"); }}
          goSend={() => setTab("send")}
          fxRate={fxRate}
        />
      )}
      {tab === "pay" && (
        <PayScan
          address={address}
          balance={balance}
          fxRate={fxRate}
          contacts={contacts}
          onPay={sendPayment}
          onDone={setReceipt}
          onSaveContact={handleAddContact}
          scanRequest={pendingScan}
          onScanRequestConsumed={() => setPendingScan(null)}
          onBack={() => { setPayFullscreen(false); setTab("home"); }}
          onFullscreenChange={setPayFullscreen}
        />
      )}
      {tab === "send" && (
        <Send
          address={address}
          balance={balance}
          fxRate={fxRate}
          contacts={contacts}
          onPay={sendPayment}
          onDone={setReceipt}
        />
      )}
      {tab === "charge" && (
        <MercadoPagoCharge
          key={`${user.id}:${address}`}
          merchantName={merchantName}
          address={address}
          userId={user.id}
          getAccessToken={getAccessToken}
          onDelivered={handleChargeDelivered}
          onPaymentReceived={handleChargePaymentReceived}
          chargeRequest={pendingCharge}
          onChargeRequestConsumed={() => setPendingCharge(null)}
        />
      )}
      {tab === "convert" && SOLANA.cluster !== "devnet" && <Card>Las conversiones independientes todavía no están disponibles. Cobrá con MIDATOPAY para recibir USDC.</Card>}
      {tab === "convert" && SOLANA.cluster === "devnet" && (
        <Convert
          address={address}
          balance={balance}
          arsBalance={arsBalance}
          fxRate={fxRate}
          onConvertArsUsdc={handleConvertArsUsdc}
          onConvertUsdcArs={handleConvertUsdcArs}
          onDone={setReceipt}
        />
      )}
      {tab === "movs" && <Movimientos txs={activityTxs} address={address} onOpenTransfer={openTransfer} />}
      {tab === "reports" && paymentAdmin && <PaymentReports getAccessToken={getAccessToken} onBack={()=>setTab("mas")} />}
      {tab === "stack" && <Stack />}
      {tab === "agenda" && (
        <ContactsScreen
          contacts={contacts}
          loadError={contactsError}
          onRetry={()=>setContactsRevision(value=>value+1)}
          onAdd={handleAddContact}
          onUpdate={handleUpdateContact}
          onRemove={handleRemoveContact}
        />
      )}
      {tab === "mas" && (
        <Mas
          key={user.id}
          merchantProfile={merchantProfile}
          treasuryExportAccess={treasuryExportAccess?.userId===user.id?treasuryExportAccess:null}
          email={email}
          address={address}
          nombre={nombre}
          onLogout={async () => { await logout(); setTab("home"); setTxs([]); setBalance(null); setTreasuryBalance(null); }}
          goStack={() => setTab("stack")}
          goReports={paymentAdmin?()=>setTab("reports"):undefined}
          privyId={user.id}
          treasuryAddress={treasuryAddress}
        />
      )}
    </>,
    { pad: !(tab === "pay" && payFullscreen), nav: !(tab === "pay" && payFullscreen) }
  );
}

export default function App() {
  return (
    <LanguageProvider>
      <AppInner />
    </LanguageProvider>
  );
}
