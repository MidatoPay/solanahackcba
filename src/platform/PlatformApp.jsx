import React, {
  createContext,
  useContext,
  useCallback,
  useEffect,
  useRef,
  useState,
} from "react";
import { usePrivy } from "@privy-io/react-auth";
import { useWallets, useSignTransaction } from "@privy-io/react-auth/solana";
import { Buffer } from "buffer";
import QRCode from "qrcode";
import { SOLANA } from "../chain.js";
import { getUsdcBalance } from "../solana.js";
import { formatMoney, units, splitQuote } from "./money.js";
import {
  OPERATION_LABELS,
  STATUS_LABELS,
  TERMINAL_STATUSES,
} from "./countries.js";
import {
  platformRequest,
  intentStore,
  parseLocalCommand,
  csvReport,
  errorMessage,
} from "./client.js";
import "./platform.css";
import ContactAgenda from "./ContactAgenda.jsx";
import { walletContacts } from "./contacts.js";

const CountryContext = createContext({
  currency: "COP",
  locale: "es-CO",
  timeZone: "America/Bogota",
});
function useMoney() {
  const country = useContext(CountryContext);
  return (value) => formatMoney(value, country.currency, country.locale);
}
const short = (value) =>
  value ? `${value.slice(0, 5)}…${value.slice(-5)}` : "Preparando wallet";
function Field({ label, children }) {
  return (
    <label className="co-field">
      <span>{label}</span>
      {children}
    </label>
  );
}
function Amount({ value, onChange, label, minimum = "0.01", step = "0.01" }) {
  const country = useContext(CountryContext);
  return (
    <Field label={label || `Importe en ${country.currency}`}>
      <input
        required
        inputMode="decimal"
        type="number"
        min={minimum}
        step={step}
        placeholder="0"
        value={value}
        onChange={(e) => onChange(e.target.value)}
      />
    </Field>
  );
}
function Status({ operation }) {
  return (
    <span className={`co-status co-status-${operation.status}`}>
      {STATUS_LABELS[operation.status] || "En seguimiento"}
    </span>
  );
}
function LegalDocuments({ documents }) {
  return (
    <div className="co-documents">
      {documents.map((doc) => (
        <details key={doc.id}>
          <summary>
            {doc.title} <small>· Borrador</small>
          </summary>
          <p className="co-legal-body">{doc.body}</p>
          <small>Versión {doc.version}</small>
        </details>
      ))}
    </div>
  );
}
function OperationCard({ operation, onOpen }) {
  const money = useMoney();
  const country = useContext(CountryContext);
  return (
    <button className="co-operation" onClick={() => onOpen(operation)}>
      <span className="co-operation-icon" aria-hidden="true">
        {operation.kind === "collection"
          ? "↙"
          : operation.kind === "withdrawal" || operation.kind === "transfer"
            ? "↗"
            : "⇄"}
      </span>
      <span>
        <strong>{OPERATION_LABELS[operation.kind]}</strong>
        <small>
          {new Date(operation.createdAt).toLocaleString(country.locale, {
            timeZone: country.timeZone,
            dateStyle: "medium",
            timeStyle: "short",
          })}
        </small>
        <Status operation={operation} />
      </span>
      <span className="co-operation-value">
        {["transfer", "receive"].includes(operation.kind)
          ? `${operation.usdcAmount} USDC`
          : money(operation.fiatAmount)}
        <small>
          {operation.currency} ·{" "}
          {{ onepay: "OnePay", treasury: "MidatoPay", solana: "Solana" }[
            operation.provider
          ] || operation.provider}
        </small>
      </span>
    </button>
  );
}
export function OperationDetail({
  operation: op,
  config,
  onClose,
  onSign,
  onCancel,
  busy,
}) {
  const money = useMoney();
  const [qr, setQr] = useState("");
  useEffect(() => {
    let canceled = false;
    setQr("");
    if (
      op.qrData &&
      op.status === "awaiting_payment" &&
      new Date(op.expiresAt) > new Date()
    )
      QRCode.toDataURL(op.qrData, {
        width: 300,
        margin: 3,
        errorCorrectionLevel: "M",
      })
        .then((value) => {
          if (!canceled) setQr(value);
        })
        .catch(() => {});
    return () => {
      canceled = true;
    };
  }, [op.id, op.qrData, op.status, op.expiresAt]);
  const child = op.children?.find((value) => value.kind === "buy");
  return (
    <section className="co-detail co-panel" aria-label="Detalle de operación">
      <div className="co-panel-heading">
        <div>
          <span className="co-eyebrow">COMPROBANTE DE PRUEBA</span>
          <h2>{OPERATION_LABELS[op.kind]}</h2>
        </div>
        <button
          className="co-icon-button"
          onClick={onClose}
          aria-label="Cerrar detalle"
        >
          ×
        </button>
      </div>
      <Status operation={op} />
      {qr && (
        <div className="co-qr">
          <img
            src={qr}
            width="280"
            height="280"
            alt={`${config.services.qrCollection?.label || "QR"} por ${money(op.fiatAmount)}`}
          />
          <p>
            Escanea desde una aplicación bancaria compatible.
            <br />
            <small>
              QR de sandbox · Vence{" "}
              {new Date(op.expiresAt).toLocaleTimeString(
                config.country.locale,
                {
                  timeZone: config.country.timeZone,
                },
              )}
            </small>
          </p>
        </div>
      )}
      <dl className="co-breakdown">
        <dt>Importe</dt>
        <dd>
          {["transfer", "receive"].includes(op.kind)
            ? `${op.usdcAmount} USDC`
            : money(op.fiatAmount)}
        </dd>
        {!["transfer", "receive"].includes(op.kind) && (
          <>
            <dt>
              {op.kind === "withdrawal"
                ? "Comisión de retiro"
                : "Comisión de conversión"}
            </dt>
            <dd>
              {money(op.feeFiat)}
              {op.kind !== "withdrawal" && " · 0,5%"}
            </dd>
          </>
        )}
        {op.kind === "collection" && (
          <>
            <dt>Conservas en {config.country.currency}</dt>
            <dd>{money(op.retainedFiat)}</dd>
            <dt>USDC a recibir</dt>
            <dd>{op.usdcAmount} USDC</dd>
          </>
        )}
        {["buy", "sell"].includes(op.kind) && (
          <>
            <dt>USDC</dt>
            <dd>{op.usdcAmount}</dd>
          </>
        )}
        {op.quote && (
          <>
            <dt>Cotización fijada</dt>
            <dd>
              {money(op.quote[op.kind === "sell" ? "sell" : "buy"])} / USDC
            </dd>
          </>
        )}
        {op.wallet && (
          <>
            <dt>Tu wallet</dt>
            <dd className="co-address">{op.wallet}</dd>
          </>
        )}
        {op.to && ["sell", "transfer"].includes(op.kind) && (
          <>
            <dt>Destino USDC</dt>
            <dd className="co-address">{op.to}</dd>
          </>
        )}
        {op.kind === "withdrawal" && op.destinationId && (
          <>
            <dt>Destino del retiro</dt>
            <dd>{op.destinationLabel || op.destinationId}</dd>
          </>
        )}
        <dt>Red</dt>
        <dd>Solana Devnet · USDC de prueba</dd>
        {op.status === "awaiting_signature" && (
          <>
            <dt>Mint USDC</dt>
            <dd className="co-address">{config.mint}</dd>
            <dt>Pagador de red</dt>
            <dd>MidatoPay · 0 SOL a tu cargo</dd>
            <dt>Dirección del pagador</dt>
            <dd className="co-address">{op.feePayer}</dd>
          </>
        )}
        <dt>Referencia</dt>
        <dd className="co-address">{op.id}</dd>
        {op.providerId && (
          <>
            <dt>Referencia del proveedor</dt>
            <dd className="co-address">{op.providerId}</dd>
          </>
        )}
      </dl>
      {op.kind === "collection" && op.paidAt && (
        <p className="co-notice">
          Pago recibido.{" "}
          {Number(op.retainedFiat) > 0
            ? `${money(op.retainedFiat)} disponibles en ${config.country.currency}. `
            : ""}
          {child
            ? child.status === "completed"
              ? "Los USDC ya fueron entregados."
              : child.status === "failed"
                ? `La conversión falló; los ${config.country.currency} regresaron a tu saldo.`
                : "La entrega de USDC continúa en seguimiento."
            : ""}
        </p>
      )}
      {op.splitSkipped && (
        <p className="co-notice">
          La parte a convertir no alcanzó el mínimo de 0,01 USDC. Conservaste el
          importe en {config.country.currency} sin comisión.
        </p>
      )}
      {op.lastError && (
        <p className="co-notice">{errorMessage(op.lastError)}</p>
      )}
      {op.kind === "sell" && op.status === "completed" && (
        <p className="co-notice">
          Los {config.country.currency} ya están en tu saldo. Puedes
          conservarlos o retirarlos.
        </p>
      )}
      {[op, ...(op.children || [])]
        .filter((value) => value.signature)
        .map((value) => (
          <a
            className="co-link"
            key={value.id}
            href={`https://explorer.solana.com/tx/${encodeURIComponent(value.signature)}?cluster=devnet`}
            target="_blank"
            rel="noreferrer"
          >
            Ver transferencia en Solana Explorer ↗
          </a>
        ))}
      {op.status === "awaiting_signature" && (
        <>
          <p className="co-muted">
            Revisa el importe, destinatario y red antes de firmar. La
            autorización es válida hasta{" "}
            {new Date(op.expiresAt).toLocaleTimeString(config.country.locale, {
              timeZone: config.country.timeZone,
            })}
            .
          </p>
          <button
            className="co-primary"
            disabled={busy}
            onClick={() => onSign(op)}
          >
            Revisado: firmar con mi wallet
          </button>
        </>
      )}
      {(op.status === "awaiting_signature" ||
        (op.kind === "collection" &&
          ["creating", "awaiting_payment"].includes(op.status))) && (
        <button
          className="co-secondary"
          disabled={busy}
          onClick={() => onCancel(op)}
        >
          Cancelar operación
        </button>
      )}
    </section>
  );
}

export default function PlatformApp({ config }) {
  return (
    <CountryContext.Provider value={config.country}>
      <PlatformWallet config={config} />
    </CountryContext.Provider>
  );
}
function PlatformWallet({ config }) {
  const money = useMoney();
  const { ready, authenticated, user, login, logout, getAccessToken } =
    usePrivy();
  const { wallets = [] } = useWallets();
  const { signTransaction } = useSignTransaction();
  const userId = ready && authenticated && user?.id ? user.id : null;
  const [tab, setTab] = useState("home"),
    [model, setModel] = useState(null),
    [operations, setOperations] = useState([]),
    [nextCursor, setNextCursor] = useState(null);
  const [rate, setRate] = useState(null),
    [usdc, setUsdc] = useState(null),
    [selected, setSelected] = useState(null);
  const [error, setError] = useState(""),
    [notice, setNotice] = useState(""),
    [busy, setBusy] = useState("");
  const [checked, setChecked] = useState({}),
    [pending, setPending] = useState(null),
    [showDocs, setShowDocs] = useState(false);
  const [chargeAmount, setChargeAmount] = useState(""),
    [direction, setDirection] = useState("buy"),
    [convertAmount, setConvertAmount] = useState(""),
    [quote, setQuote] = useState(null);
  const [withdrawAmount, setWithdrawAmount] = useState(""),
    [destinationId, setDestinationId] = useState("");
  const [sendAmount, setSendAmount] = useState(""),
    [sendTo, setSendTo] = useState(""),
    [voiceText, setVoiceText] = useState("");
  const [name, setName] = useState(""),
    [policyMode, setPolicyMode] = useState("percentage"),
    [policyValue, setPolicyValue] = useState("100");
  const [customer, setCustomer] = useState({
    firstName: "",
    lastName: "",
    email: "",
    phone: "+57",
    documentType: "CC",
    documentNumber: "",
    birthdate: "",
  });
  const [destination, setDestination] = useState({
      kind: config.services.bankWithdrawal?.available ? "bank" : "breb",
      bankId: "",
      subtype: "SAVINGS",
      accountNumber: "",
      key: "",
    }),
    [banks, setBanks] = useState([]);
  const [reports, setReports] = useState(null),
    [listening, setListening] = useState(false);
  const currentUser = useRef(userId),
    running = useRef(false),
    recognition = useRef(null),
    listRef = useRef([]);
  currentUser.current = userId;
  listRef.current = operations;
  const request = useCallback(
    (path, options = {}) =>
      platformRequest(path, getAccessToken, {
        ...options,
        headers: { ...options.headers, "X-Platform-Context": config.contextId },
      }),
    [getAccessToken, config.contextId],
  );
  const store = useCallback(
    () => intentStore(window.localStorage, config.contextId, userId),
    [config.contextId, userId],
  );
  const refresh = useCallback(async () => {
    if (!userId) return;
    const owner = userId,
      results = await Promise.allSettled([
        request("/me"),
        request("/operations"),
        request("/rates"),
      ]);
    if (currentUser.current !== owner) return;
    if (results[0].status === "fulfilled") setModel(results[0].value);
    else setError(results[0].reason.message);
    if (results[1].status === "fulfilled") {
      setOperations((previous) => {
        const fresh = results[1].value.operations;
        const ids = new Set(fresh.map((op) => op.id));
        return [...fresh, ...previous.filter((op) => !ids.has(op.id))];
      });
      if (listRef.current.length <= 50)
        setNextCursor(results[1].value.nextCursor);
    }
    if (results[2].status === "fulfilled") setRate(results[2].value.quote);
  }, [request, userId]);
  useEffect(() => {
    setModel(null);
    setSelected(null);
    setOperations([]);
    setUsdc(null);
    setError("");
    setNotice("");
    setPending(null);
    setBusy("");
    if (!userId) return;
    setPending(store().read());
    let canceled = false,
      timer;
    const tick = async () => {
      await refresh();
      if (!canceled)
        timer = setTimeout(
          tick,
          listRef.current.some((op) => !TERMINAL_STATUSES.has(op.status))
            ? 5000
            : 20000,
        );
    };
    tick();
    return () => {
      canceled = true;
      clearTimeout(timer);
      recognition.current?.stop();
    };
  }, [userId, refresh, store]);
  useEffect(() => {
    if (!model?.wallet || !userId) return;
    let canceled = false;
    getUsdcBalance(model.wallet)
      .then((value) => {
        if (!canceled) setUsdc(value);
      })
      .catch(() => {
        if (!canceled) setUsdc(null);
      });
    return () => {
      canceled = true;
    };
  }, [model?.wallet, operations, userId]);
  useEffect(() => {
    if (!model?.merchant) return;
    setName(model.merchant.businessName);
    setPolicyMode(model.merchant.policy.mode);
    setPolicyValue(model.merchant.policy.value);
  }, [
    model?.merchant?.businessName,
    model?.merchant?.policy?.mode,
    model?.merchant?.policy?.value,
  ]);
  useEffect(() => {
    if (!selected?.id || !userId || TERMINAL_STATUSES.has(selected.status))
      return;
    let canceled = false,
      timer;
    const tick = async () => {
      try {
        const result = await request(`/operations/${selected.id}`);
        if (!canceled) setSelected(result.operation);
      } catch {
        /* The receipt remains available during reconnection. */
      }
      if (!canceled) timer = setTimeout(tick, 4000);
    };
    timer = setTimeout(tick, 2000);
    return () => {
      canceled = true;
      clearTimeout(timer);
    };
  }, [selected?.id, selected?.status, userId, request]);
  const run = async (label, fn) => {
    if (running.current) return;
    running.current = true;
    const owner = userId;
    setBusy(label);
    setError("");
    setNotice("");
    try {
      await fn();
    } catch (e) {
      if (currentUser.current === owner) setError(e.message);
    } finally {
      running.current = false;
      if (currentUser.current === owner) setBusy("");
    }
  };
  const performIntent = async (path, body) => {
    const saved = store().read();
    if (
      saved &&
      (saved.path !== path ||
        JSON.stringify(saved.body) !== JSON.stringify(body))
    )
      throw new Error(
        "Recupera o cierra de forma segura la solicitud pendiente antes de iniciar otra.",
      );
    const intent = saved || { key: crypto.randomUUID(), path, body };
    store().save(intent);
    setPending(intent);
    const value = await request(path, {
      method: "POST",
      body,
      headers: { "Idempotency-Key": intent.key },
    });
    if (currentUser.current !== userId)
      throw new Error(
        "La sesión cambió. La operación se conserva para su propietario.",
      );
    if (value.operation) {
      setSelected(value.operation);
      if (value.operation.status === "awaiting_signature") {
        const next = { ...intent, id: value.operation.id };
        store().save(next);
        setPending(next);
      } else {
        store().clear();
        setPending(null);
      }
    } else {
      store().clear();
      setPending(null);
      setNotice("Destino de retiro guardado.");
    }
    await refresh();
    return value;
  };
  const sign = (op) =>
    run("Firmando", async () => {
      if (
        !userId ||
        !model?.wallet ||
        op.wallet !== model.wallet ||
        op.network !== config.network
      )
        throw new Error(
          "La wallet o la red cambió. Actualiza la operación antes de firmar.",
        );
      const wallet = wallets.find((value) => value.address === model.wallet);
      if (!wallet)
        throw new Error(
          "Tu wallet principal todavía no está lista para firmar.",
        );
      const result = await signTransaction({
        transaction: new Uint8Array(Buffer.from(op.transaction, "base64")),
        wallet,
        chain: SOLANA.chain,
      });
      if (currentUser.current !== userId) throw new Error("La sesión cambió.");
      const intent = {
        key: crypto.randomUUID(),
        path: `/operations/${op.id}/submit`,
        id: op.id,
        body: {
          signedTransaction: Buffer.from(result.signedTransaction).toString(
            "base64",
          ),
        },
      };
      store().save(intent);
      setPending(intent);
      const value = await request(intent.path, {
        method: "POST",
        body: intent.body,
      });
      if (currentUser.current !== userId)
        throw new Error(
          "La sesión cambió. La operación se conserva para su propietario.",
        );
      store().clear();
      setPending(null);
      setSelected(value.operation);
      await refresh();
    });
  const cancel = (op) =>
    run("Cancelando", async () => {
      const result = await request(`/operations/${op.id}/cancel`, {
        method: "POST",
        body: {},
      });
      if (store().read()?.id === op.id) {
        store().clear();
        setPending(null);
      }
      setSelected(result.operation);
      await refresh();
    });
  const recover = () =>
    run("Recuperando", async () => {
      const saved = store().read();
      if (!saved) return;
      if (saved.id && !saved.path.endsWith("/submit")) {
        const result = await request(`/operations/${saved.id}`);
        setSelected(result.operation);
        if (result.operation.status !== "awaiting_signature") {
          store().clear();
          setPending(null);
        }
      } else await performIntent(saved.path, saved.body);
    });
  const prepareVoice = () =>
    run("Interpretando", async () => {
      let parsed = parseLocalCommand(
        voiceText,
        config.country.currency,
        model?.contacts || [],
      );
      if (!parsed) {
        const token = await getAccessToken();
        const response = await fetch("/parse-intent", {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            Authorization: `Bearer ${token}`,
          },
          body: JSON.stringify({
            text: voiceText,
            lang: "es",
            aliases: walletContacts(model?.contacts).map((c) => c.alias),
          }),
        });
        const body = await response.json();
        if (response.ok && body.intent?.confidence >= 0.8) parsed = body.intent;
      }
      if (
        parsed?.intent === "charge" &&
        parsed.currency === config.country.currency
      ) {
        setChargeAmount(String(parsed.amount));
        setTab("charge");
      } else if (
        parsed?.intent === "send" &&
        parsed.currency === "USDC" &&
        parsed.recipient
      ) {
        const exact = walletContacts(model?.contacts).filter(
          (c) =>
            c.alias.toLowerCase() === parsed.recipient.toLowerCase() ||
            c.name.toLowerCase() === parsed.recipient.toLowerCase(),
        );
        const destination =
          voiceText.includes(parsed.recipient) &&
          /^[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(parsed.recipient)
            ? parsed.recipient
            : exact.length === 1
              ? exact[0].address
              : null;
        if (!destination)
          throw new Error(
            "El destinatario no coincide de forma única con un contacto o una dirección del comando.",
          );
        setSendAmount(String(parsed.amount));
        setSendTo(destination);
        setTab("send");
      } else
        throw new Error(
          "Indica “cobrar 5000 pesos” o “enviar 1 USDC a dirección Solana”. Revisarás los datos antes de confirmar.",
        );
      setNotice("Revisa los datos del comando antes de continuar.");
    });
  const listen = () => {
    const Speech = window.SpeechRecognition || window.webkitSpeechRecognition;
    if (!Speech) {
      setError("Tu navegador no permite dictado. Puedes escribir el comando.");
      return;
    }
    const instance = new Speech();
    recognition.current = instance;
    instance.lang = config.country.locale;
    instance.interimResults = false;
    instance.onresult = (event) => setVoiceText(event.results[0][0].transcript);
    instance.onerror = () => {
      setListening(false);
      setError("No se pudo captar la voz. Puedes escribir el comando.");
    };
    instance.onend = () => setListening(false);
    instance.start();
    setListening(true);
  };
  const usable = (id) => !!config.services[id]?.enabled && !!model?.accepted;
  const has = (id) => !!config.services[id]?.available;
  const hasWithdrawals = has("bankWithdrawal") || has("brebWithdrawal");
  const button = (label, onClick, serviceId) => (
    <button
      className="co-primary"
      disabled={!!busy || !usable(serviceId)}
      onClick={onClick}
    >
      {busy || label}
    </button>
  );
  const dates = (model?.destinations || []).filter((d) => d.status === "ready");
  let chargePreview = null;
  try {
    if (chargeAmount && model?.merchant?.policy)
      chargePreview = splitQuote(
        units(chargeAmount),
        model.merchant.policy,
        rate?.buy,
      );
  } catch {
    /* Invalid or incomplete amount has no preview. */
  }
  const nav = [
    ["home", "Inicio"],
    ["charge", "Cobrar"],
    ["activity", "Actividad"],
    ["settings", "Ajustes"],
  ].filter(([id]) => id !== "charge" || has("qrCollection"));
  const authenticatedUser = ready && authenticated && !!userId;
  return (
    <div className="co-app">
      <header className="co-header">
        <a className="co-brand" href="/" aria-label="MidatoPay inicio">
          <span className="co-brand-mark">m</span>midatopay
          <span className="co-brand-dot">.</span>
        </a>
        <div className="co-header-right">
          <span className="co-country">
            {config.country.flag} {config.country.name}
          </span>
          <span className="co-sandbox">Sandbox</span>
          {authenticatedUser && (
            <button className="co-text-button" onClick={logout}>
              Salir
            </button>
          )}
        </div>
      </header>
      {!authenticatedUser ? (
        <main className="co-welcome">
          <div className="co-welcome-copy">
            <span className="co-eyebrow">TU DINERO, A TU MANERA</span>
            <h1>
              Cobra en pesos.
              <br />
              <span>Elige qué sigue.</span>
            </h1>
            <p>
              Conserva {config.country.currency}, convierte una parte en USDC y
              retira cuando lo necesites. Todo desde una sola billetera.
            </p>
            <button className="co-primary" disabled={!ready} onClick={login}>
              {ready ? "Ingresar a mi billetera" : "Preparando ingreso…"}
            </button>
            <div className="co-disclaimer">
              Entorno de pruebas · Solana Devnet.
              <br />
              Usa exclusivamente datos y fondos de prueba.
            </div>
            <button
              className="co-text-button"
              onClick={() => setShowDocs(!showDocs)}
            >
              Ver términos, privacidad y servicios
            </button>
          </div>
          <div className="co-welcome-preview" aria-hidden="true">
            <div className="co-preview-top">UN COBRO. TÚ DECIDES.</div>
            <div className="co-preview-amount">
              {money("100000")} <small>{config.country.currency}</small>
            </div>
            <div className="co-preview-split">
              <div>
                <span>Conservar en {config.country.currency}</span>
                <strong>70%</strong>
              </div>
              <div>
                <span>Convertir a USDC</span>
                <strong>30%</strong>
              </div>
            </div>
            <p>Distribución ilustrativa configurable</p>
          </div>
          {showDocs && (
            <section className="co-panel co-welcome-legal">
              <LegalDocuments documents={config.documents} />
            </section>
          )}
        </main>
      ) : (
        <>
          <nav className="co-nav" aria-label="Navegación principal">
            {nav.map(([id, label]) => (
              <button
                key={id}
                aria-current={tab === id ? "page" : undefined}
                onClick={() => {
                  setTab(id);
                  setSelected(null);
                }}
              >
                {label}
              </button>
            ))}
          </nav>
          <main className="co-main">
            <div className="co-page-heading">
              <div>
                <span className="co-eyebrow">
                  {config.environment === "sandbox"
                    ? "TU BILLETERA DE PRUEBA"
                    : "TU BILLETERA"}
                </span>
                <h1>
                  {tab === "home"
                    ? model?.merchant?.businessName || "Hola, bienvenido"
                    : {
                        charge: "Cobrar",
                        activity: "Tu actividad",
                        settings: "Ajustes",
                        convert: "Convertir",
                        withdraw: `Retirar ${config.country.currency}`,
                        send: "Enviar USDC",
                        reports: "Operaciones",
                      }[tab]}
                </h1>
              </div>
              <button
                className="co-text-button"
                onClick={() => run("Actualizando", refresh)}
              >
                ↻ Actualizar
              </button>
            </div>
            {error && (
              <div className="co-alert" role="alert">
                {error}
              </div>
            )}
            {notice && (
              <div className="co-notice" role="status">
                {notice}
              </div>
            )}
            {!Object.values(config.services).some(
              (service) => service.enabled,
            ) && (
              <div className="co-notice">
                El sandbox está en preparación. Los servicios financieros se
                habilitarán cuando termine la configuración.
              </div>
            )}
            {pending && (
              <div className="co-recovery">
                <div>
                  <strong>Hay una solicitud guardada</strong>
                  <p>Recupérala para comprobar su estado antes de repetirla.</p>
                </div>
                <button
                  className="co-secondary"
                  disabled={!!busy}
                  onClick={recover}
                >
                  Recuperar solicitud
                </button>
                <button
                  className="co-text-button"
                  disabled={!!busy}
                  onClick={() =>
                    run("Cerrando solicitud", async () => {
                      const result = await request("/attempts/close", {
                        method: "POST",
                        body: {
                          key: pending.key,
                          ...(pending.id ? { id: pending.id } : {}),
                        },
                      });
                      if (result.operation) setSelected(result.operation);
                      store().clear();
                      setPending(null);
                      await refresh();
                    })
                  }
                >
                  Cerrar de forma segura
                </button>
              </div>
            )}
            {model && !model.accepted && (
              <section className="co-panel">
                <span className="co-eyebrow">ANTES DE EMPEZAR</span>
                <h2>Condiciones para {config.country.name}</h2>
                <p>
                  Este entorno usa documentos y fondos de prueba. Revisa cada
                  documento para habilitar nuevas operaciones.
                </p>
                <LegalDocuments documents={config.documents} />
                {config.documents.map((doc) => (
                  <label className="co-checkbox" key={doc.id}>
                    <input
                      type="checkbox"
                      checked={!!checked[doc.id]}
                      onChange={(e) =>
                        setChecked({ ...checked, [doc.id]: e.target.checked })
                      }
                    />
                    He leído y acepto {doc.title.toLowerCase()}.
                  </label>
                ))}
                <button
                  className="co-primary"
                  disabled={
                    !!busy || !config.documents.every((doc) => checked[doc.id])
                  }
                  onClick={() =>
                    run("Guardando aceptación", async () => {
                      await request("/acceptances", {
                        method: "POST",
                        body: {
                          documents: config.documents.map(
                            ({ id, version, hash }) => ({ id, version, hash }),
                          ),
                        },
                      });
                      await refresh();
                    })
                  }
                >
                  Aceptar y continuar
                </button>
              </section>
            )}
            {selected && (
              <OperationDetail
                operation={selected}
                config={config}
                onClose={() => setSelected(null)}
                onSign={sign}
                onCancel={cancel}
                busy={!!busy}
              />
            )}
            {!selected && tab === "home" && (
              <>
                <section className="co-balance-grid">
                  <div className="co-balance co-balance-cop">
                    <span>SALDO DISPONIBLE</span>
                    <h2>{model ? money(model.balances.available) : "—"}</h2>
                    <p>
                      {config.country.currency}{" "}
                      <span>
                        · {model ? money(model.balances.reserved) : "—"} en
                        proceso
                      </span>
                    </p>
                    {hasWithdrawals && (
                      <button onClick={() => setTab("withdraw")}>
                        Retirar pesos ↗
                      </button>
                    )}
                  </div>
                  <div className="co-balance co-balance-usdc">
                    <span>TU WALLET SOLANA</span>
                    <h2>
                      {usdc == null
                        ? "—"
                        : usdc.toLocaleString(config.country.locale, {
                            maximumFractionDigits: 6,
                          })}
                      <small> USDC</small>
                    </h2>
                    <p>Devnet · {short(model?.wallet)}</p>
                    {has("cryptoTransfer") && (
                      <button onClick={() => setTab("send")}>
                        Enviar USDC ↗
                      </button>
                    )}
                  </div>
                </section>
                <div className="co-actions">
                  {has("qrCollection") && (
                    <button onClick={() => setTab("charge")}>
                      <b>↙</b>Cobrar con QR
                    </button>
                  )}
                  {(has("onRamp") || has("offRamp")) && (
                    <button
                      onClick={() => {
                        setDirection(has("onRamp") ? "buy" : "sell");
                        setQuote(null);
                        setTab("convert");
                      }}
                    >
                      <b>⇄</b>Convertir
                    </button>
                  )}
                  {hasWithdrawals && (
                    <button onClick={() => setTab("withdraw")}>
                      <b>↗</b>Retirar {config.country.currency}
                    </button>
                  )}
                  <button onClick={() => setTab("settings")}>
                    <b>◴</b>Mi distribución
                  </button>
                </div>
                <div className="co-two-columns">
                  <section className="co-panel">
                    <span className="co-eyebrow">
                      CADA COBRO, COMO TÚ QUIERAS
                    </span>
                    <h2>Tu distribución automática</h2>
                    <p className="co-large-policy">
                      {model?.merchant?.policy?.mode === "fixed"
                        ? money(model.merchant.policy.value)
                        : `${model?.merchant?.policy?.value || "100"}%`}{" "}
                      <span>a USDC</span>
                    </p>
                    <p className="co-muted">
                      El resto se conserva en {config.country.currency}.
                      Comisión del 0,5% únicamente sobre el importe que
                      conviertes.
                    </p>
                    <button
                      className="co-secondary"
                      onClick={() => setTab("settings")}
                    >
                      Personalizar distribución
                    </button>
                  </section>
                  <section className="co-panel">
                    <span className="co-eyebrow">DILO O ESCRÍBELO</span>
                    <h2>Un comando para empezar</h2>
                    <Field label="Tu comando">
                      <input
                        value={voiceText}
                        onChange={(e) => setVoiceText(e.target.value)}
                        placeholder="Cobrar 5000 pesos"
                      />
                    </Field>
                    <div className="co-inline">
                      <button
                        className="co-secondary"
                        disabled={listening}
                        onClick={listen}
                      >
                        {listening ? "Escuchando…" : "🎙 Dictar"}
                      </button>
                      <button
                        className="co-primary"
                        disabled={!!busy || !voiceText}
                        onClick={prepareVoice}
                      >
                        Revisar comando
                      </button>
                    </div>
                    <small>
                      Siempre revisas la operación antes de confirmar.
                    </small>
                  </section>
                </div>
                <section className="co-panel">
                  <div className="co-panel-heading">
                    <h2>Últimos movimientos</h2>
                    <button
                      className="co-text-button"
                      onClick={() => setTab("activity")}
                    >
                      Ver todos →
                    </button>
                  </div>
                  {operations.slice(0, 4).map((op) => (
                    <OperationCard
                      key={op.id}
                      operation={op}
                      onOpen={setSelected}
                    />
                  ))}
                  {!operations.length && (
                    <p className="co-empty">
                      Tus cobros, conversiones y retiros aparecerán aquí.
                    </p>
                  )}
                </section>
              </>
            )}
            {!selected && tab === "charge" && has("qrCollection") && (
              <section className="co-panel co-form-panel">
                <span className="co-eyebrow">
                  {config.services.qrCollection?.label || "QR"} ·{" "}
                  {config.services.qrCollection?.provider}
                </span>
                <h2>Recibe un pago en pesos</h2>
                <p>Tu distribución y cotización se fijan al crear el cobro.</p>
                <Amount
                  value={chargeAmount}
                  onChange={setChargeAmount}
                  minimum="1000"
                />
                {chargePreview && (
                  <dl className="co-breakdown">
                    <dt>Conservar en {config.country.currency}</dt>
                    <dd>{money(Number(chargePreview.retainedMinor) / 100)}</dd>
                    <dt>Comisión estimada</dt>
                    <dd>{money(Number(chargePreview.feeMinor) / 100)}</dd>
                    <dt>USDC estimados</dt>
                    <dd>
                      {(Number(chargePreview.usdcRaw) / 1000000).toFixed(6)}{" "}
                      USDC
                    </dd>
                  </dl>
                )}
                <p className="co-muted">
                  De {money("1000")} a {money("1000000")}{" "}
                  {config.country.currency}.{" "}
                  {model?.merchant?.policy.mode === "fixed"
                    ? `Hasta ${money(model.merchant.policy.value)}`
                    : `${model?.merchant?.policy.value || "100"}%`}{" "}
                  de cada cobro se destina a conversión USDC.
                </p>
                {button(
                  "Crear QR de cobro",
                  () =>
                    run("Creando cobro", () =>
                      performIntent("/charges", {
                        amount: chargeAmount,
                        wallet: model?.wallet,
                      }),
                    ),
                  "qrCollection",
                )}
              </section>
            )}
            {!selected &&
              tab === "convert" &&
              (has("onRamp") || has("offRamp")) && (
                <section className="co-panel co-form-panel">
                  <h2>Entre pesos y USDC</h2>
                  <div className="co-segmented">
                    <button
                      aria-pressed={direction === "buy"}
                      disabled={!has("onRamp")}
                      onClick={() => {
                        setDirection("buy");
                        setQuote(null);
                        setConvertAmount("");
                      }}
                    >
                      {config.country.currency} → USDC
                    </button>
                    <button
                      aria-pressed={direction === "sell"}
                      disabled={!has("offRamp")}
                      onClick={() => {
                        setDirection("sell");
                        setQuote(null);
                        setConvertAmount("");
                      }}
                    >
                      USDC → {config.country.currency}
                    </button>
                  </div>
                  <Amount
                    value={convertAmount}
                    onChange={(value) => {
                      setConvertAmount(value);
                      setQuote(null);
                    }}
                    label={
                      direction === "buy"
                        ? `${config.country.currency} a convertir`
                        : "USDC a vender"
                    }
                    step={direction === "buy" ? "0.01" : "0.000001"}
                    minimum={direction === "buy" ? "1" : "0.01"}
                  />
                  {quote ? (
                    <>
                      <dl className="co-breakdown">
                        <dt>Recibirás</dt>
                        <dd>
                          {direction === "buy"
                            ? `${quote.usdcAmount} USDC`
                            : money(quote.fiatAmount)}
                        </dd>
                        <dt>Comisión 0,5%</dt>
                        <dd>{money(quote.feeFiat)}</dd>
                        <dt>Cotización</dt>
                        <dd>{money(quote.quote[direction])} / USDC</dd>
                        <dt>Válida hasta</dt>
                        <dd>
                          {new Date(quote.expiresAt).toLocaleTimeString(
                            config.country.locale,
                            {
                              timeZone: config.country.timeZone,
                            },
                          )}
                        </dd>
                      </dl>
                      {button(
                        direction === "buy"
                          ? "Confirmar compra"
                          : "Preparar venta para firmar",
                        () =>
                          run("Preparando conversión", () =>
                            performIntent(`/conversions/${direction}`, {
                              quoteId: quote.id,
                              wallet: model?.wallet,
                            }),
                          ),
                        direction === "buy" ? "onRamp" : "offRamp",
                      )}
                    </>
                  ) : (
                    button(
                      "Consultar cotización",
                      () =>
                        run("Cotizando", async () =>
                          setQuote(
                            await request("/quotes", {
                              method: "POST",
                              body: { direction, amount: convertAmount },
                            }),
                          ),
                        ),
                      direction === "buy" ? "onRamp" : "offRamp",
                    )
                  )}
                  <p className="co-muted">
                    {direction === "buy"
                      ? `Usas tu saldo ${config.country.currency} disponible.`
                      : `Los ${config.country.currency} se acreditan cuando finaliza la recepción de USDC. Puedes retirarlos después.`}{" "}
                    Precio indicativo de CriptoYa; no es una oferta de un
                    exchange.
                  </p>
                </section>
              )}
            {!selected && tab === "withdraw" && hasWithdrawals && (
              <section className="co-panel co-form-panel">
                <h2>Retira tus pesos</h2>
                <p>
                  Disponible:{" "}
                  <strong>{money(model?.balances.available)}</strong>
                </p>
                <Amount
                  value={withdrawAmount}
                  onChange={setWithdrawAmount}
                  minimum="1000"
                />
                <Field label="Destino propio">
                  <select
                    value={destinationId}
                    onChange={(e) => setDestinationId(e.target.value)}
                  >
                    <option value="">Selecciona un destino</option>
                    {dates.map((d) => (
                      <option key={d.id} value={d.id}>
                        {d.label} · {d.kind === "breb" ? "Bre-B" : "ACH"}
                      </option>
                    ))}
                  </select>
                </Field>
                <p className="co-muted">
                  Sin comisión MidatoPay por retirar {config.country.currency}.
                  Los retiros de este entorno son simulados.
                </p>
                {button(
                  "Confirmar retiro",
                  () =>
                    run("Preparando retiro", () =>
                      performIntent("/withdrawals", {
                        amount: withdrawAmount,
                        destinationId,
                      }),
                    ),
                  dates.find((d) => d.id === destinationId)?.kind === "breb"
                    ? "brebWithdrawal"
                    : "bankWithdrawal",
                )}
                <button
                  className="co-text-button"
                  onClick={() => setTab("settings")}
                >
                  Agregar cuenta bancaria o llave Bre-B →
                </button>
              </section>
            )}
            {!selected && tab === "send" && has("cryptoTransfer") && (
              <section className="co-panel co-form-panel">
                <h2>Envía USDC de prueba</h2>
                <Amount
                  value={sendAmount}
                  onChange={setSendAmount}
                  label="Importe en USDC"
                  step="0.000001"
                  minimum="0.000001"
                />
                {!!walletContacts(model?.contacts).length && (
                  <Field label="O elige un contacto">
                    <select
                      value=""
                      onChange={(e) => setSendTo(e.target.value)}
                    >
                      <option value="">Selecciona un contacto</option>
                      {walletContacts(model?.contacts).map((c) => (
                        <option key={c.id} value={c.address}>
                          {c.name} · {c.alias}
                        </option>
                      ))}
                    </select>
                  </Field>
                )}
                <Field label="Wallet Solana de destino">
                  <input
                    value={sendTo}
                    onChange={(e) => setSendTo(e.target.value.trim())}
                    placeholder="Dirección completa"
                    autoComplete="off"
                  />
                </Field>
                <p className="co-muted">
                  Solana Devnet. MidatoPay cubre la red. Dos envíos patrocinados
                  al día, incluidas ventas de USDC.
                </p>
                {button(
                  "Revisar transferencia",
                  () =>
                    run("Preparando envío", () =>
                      performIntent("/transfers", {
                        wallet: model?.wallet,
                        to: sendTo,
                        amount: sendAmount,
                      }),
                    ),
                  "cryptoTransfer",
                )}
              </section>
            )}
            {!selected && tab === "activity" && (
              <section className="co-panel">
                {operations.map((op) => (
                  <OperationCard
                    key={op.id}
                    operation={op}
                    onOpen={setSelected}
                  />
                ))}
                {!operations.length && (
                  <p className="co-empty">Todavía no tienes movimientos.</p>
                )}
                {nextCursor && (
                  <button
                    className="co-secondary"
                    disabled={!!busy}
                    onClick={() =>
                      run("Cargando actividad", async () => {
                        const result = await request(
                          "/operations?before=" +
                            encodeURIComponent(nextCursor),
                        );
                        setOperations((previous) => [
                          ...previous,
                          ...result.operations.filter(
                            (op) => !previous.some((old) => old.id === op.id),
                          ),
                        ]);
                        setNextCursor(result.nextCursor);
                      })
                    }
                  >
                    Cargar movimientos anteriores
                  </button>
                )}
                <button
                  className="co-text-button"
                  disabled={!!busy}
                  onClick={() =>
                    run("Sincronizando ingresos", async () => {
                      await request("/reconcile", { method: "POST", body: {} });
                      await refresh();
                      setNotice(
                        "Ingresos USDC sincronizados desde Solana Devnet.",
                      );
                    })
                  }
                >
                  Sincronizar USDC recibidos ↻
                </button>
              </section>
            )}
            {!selected && tab === "settings" && (
              <>
                <section className="co-panel co-form-panel">
                  <h2>Tu comercio y distribución</h2>
                  <Field label="Nombre del comercio">
                    <input
                      maxLength={100}
                      value={name}
                      onChange={(e) => setName(e.target.value)}
                    />
                  </Field>
                  <Field label="Cómo convertir cada cobro">
                    <select
                      value={policyMode}
                      onChange={(e) => setPolicyMode(e.target.value)}
                    >
                      <option value="percentage">Porcentaje del cobro</option>
                      <option value="fixed">
                        Monto fijo en {config.country.currency}
                      </option>
                    </select>
                  </Field>
                  <Amount
                    value={policyValue}
                    onChange={setPolicyValue}
                    label={
                      policyMode === "percentage"
                        ? "Porcentaje a convertir (0 a 100)"
                        : `${config.country.currency} a convertir por cobro`
                    }
                    minimum="0"
                  />
                  <p className="co-muted">
                    El monto fijo se limita al total del cobro. Cambiar esta
                    regla afecta únicamente cobros nuevos.
                  </p>
                  <button
                    className="co-primary"
                    disabled={!!busy || !model}
                    onClick={() =>
                      run("Guardando ajustes", async () => {
                        await request("/settings", {
                          method: "PATCH",
                          body: {
                            businessName: name,
                            policy: { mode: policyMode, value: policyValue },
                          },
                        });
                        await refresh();
                        setNotice("Tus ajustes quedaron guardados.");
                      })
                    }
                  >
                    Guardar ajustes
                  </button>
                </section>
                {hasWithdrawals && (
                  <section className="co-panel co-form-panel">
                    <h2>Destinos de retiro</h2>
                    {(model?.destinations || []).map((d) => (
                      <p key={d.id} className="co-saved-destination">
                        {d.status === "ready" ? "✓" : "—"} {d.label} ·{" "}
                        {d.kind === "breb" ? "Bre-B" : "Cuenta bancaria"}
                        {d.last_error && (
                          <small> · {errorMessage(d.last_error)}</small>
                        )}
                      </p>
                    ))}
                    <Field label="Tipo de destino">
                      <select
                        value={destination.kind}
                        onChange={(e) =>
                          setDestination({
                            ...destination,
                            kind: e.target.value,
                          })
                        }
                      >
                        {has("bankWithdrawal") && (
                          <option value="bank">Cuenta bancaria</option>
                        )}
                        {has("brebWithdrawal") && (
                          <option value="breb">Llave Bre-B</option>
                        )}
                      </select>
                    </Field>
                    {!(
                      model?.merchant.customers?.[destination.kind] ??
                      model?.merchant.customerReady
                    ) ? (
                      <>
                        <h3>Beneficiario de prueba</h3>
                        <p className="co-muted">
                          Registra datos ficticios del titular. En este sandbox
                          se admiten personas naturales.
                        </p>
                        <div className="co-form-grid">
                          {[
                            ["firstName", "Nombre"],
                            ["lastName", "Apellido"],
                            ["email", "Correo"],
                            ["phone", "Teléfono +57"],
                            ["documentNumber", "Documento"],
                            ["birthdate", "Fecha de nacimiento"],
                          ].map(([key, label]) => (
                            <Field key={key} label={label}>
                              <input
                                type={
                                  key === "birthdate"
                                    ? "date"
                                    : key === "email"
                                      ? "email"
                                      : "text"
                                }
                                value={customer[key]}
                                onChange={(e) =>
                                  setCustomer({
                                    ...customer,
                                    [key]: e.target.value,
                                  })
                                }
                              />
                            </Field>
                          ))}
                          <Field label="Tipo de documento">
                            <select
                              value={customer.documentType}
                              onChange={(e) =>
                                setCustomer({
                                  ...customer,
                                  documentType: e.target.value,
                                })
                              }
                            >
                              <option>CC</option>
                              <option>CE</option>
                              <option>PP</option>
                            </select>
                          </Field>
                        </div>
                        {button(
                          "Guardar beneficiario de prueba",
                          () =>
                            run("Registrando beneficiario", async () => {
                              await request("/customer", {
                                method: "POST",
                                body: { ...customer, kind: destination.kind },
                              });
                              await refresh();
                            }),
                          destination.kind === "breb"
                            ? "brebWithdrawal"
                            : "bankWithdrawal",
                        )}
                      </>
                    ) : (
                      <>
                        {destination.kind === "bank" ? (
                          <>
                            <button
                              className="co-text-button"
                              disabled={!!busy}
                              onClick={() =>
                                run("Consultando bancos", async () =>
                                  setBanks((await request("/banks")).banks),
                                )
                              }
                            >
                              Consultar bancos disponibles
                            </button>
                            <Field label="Banco">
                              <select
                                value={destination.bankId}
                                onChange={(e) =>
                                  setDestination({
                                    ...destination,
                                    bankId: e.target.value,
                                  })
                                }
                              >
                                <option value="">Selecciona un banco</option>
                                {banks.map((bank) => (
                                  <option key={bank.id} value={bank.id}>
                                    {bank.name}
                                  </option>
                                ))}
                              </select>
                            </Field>
                            <Field label="Tipo de cuenta">
                              <select
                                value={destination.subtype}
                                onChange={(e) =>
                                  setDestination({
                                    ...destination,
                                    subtype: e.target.value,
                                  })
                                }
                              >
                                <option value="SAVINGS">Ahorros</option>
                                <option value="CHECKING">Corriente</option>
                              </select>
                            </Field>
                            <Field label="Número de cuenta">
                              <input
                                autoComplete="off"
                                inputMode="numeric"
                                value={destination.accountNumber}
                                onChange={(e) =>
                                  setDestination({
                                    ...destination,
                                    accountNumber: e.target.value,
                                  })
                                }
                              />
                            </Field>
                          </>
                        ) : (
                          <>
                            <Field label="Tu llave Bre-B">
                              <input
                                autoComplete="off"
                                value={destination.key}
                                onChange={(e) =>
                                  setDestination({
                                    ...destination,
                                    key: e.target.value,
                                  })
                                }
                                placeholder="@llave, teléfono, correo o documento"
                              />
                            </Field>
                            <p className="co-muted">
                              Comprobaremos que la llave esté activa y
                              corresponda al documento del beneficiario.
                            </p>
                          </>
                        )}
                        {button(
                          "Guardar destino",
                          () =>
                            run("Registrando destino", () =>
                              performIntent("/destinations", destination),
                            ),
                          destination.kind === "breb"
                            ? "brebWithdrawal"
                            : "bankWithdrawal",
                        )}
                      </>
                    )}
                  </section>
                )}
                <ContactAgenda
                  key={`${config.contextId}:${userId}`}
                  config={config}
                  contacts={model?.contacts || []}
                  busy={!!busy}
                  disabled={!model}
                  run={run}
                  request={request}
                  refresh={refresh}
                />
                <section className="co-panel">
                  <h2>Servicios de {config.country.name}</h2>
                  <div className="co-service-list">
                    {Object.entries(config.services).map(([id, value]) => (
                      <div key={id}>
                        <span>
                          {
                            {
                              qrCollection: "Cobros QR Bre-B",
                              onRamp: "Compra de USDC",
                              offRamp: "Venta de USDC",
                              bankWithdrawal: "Retiros bancarios",
                              brebWithdrawal: "Retiros Bre-B",
                              cryptoTransfer: "Transferencias USDC",
                              qrPayment: "Pagos QR",
                              bankPayment: "Pagos bancarios",
                              cardIssuing: "Emisión de tarjetas",
                            }[id]
                          }
                        </span>
                        <small>
                          {value.enabled
                            ? "Disponible en sandbox"
                            : value.available
                              ? "En preparación"
                              : "Todavía no disponible"}
                        </small>
                      </div>
                    ))}
                  </div>
                  <button
                    className="co-text-button"
                    onClick={() =>
                      run("Cargando operaciones", async () => {
                        setReports(await request("/reports"));
                        setTab("reports");
                      })
                    }
                  >
                    Operaciones y comisiones · Administración
                  </button>
                </section>
                <section className="co-panel">
                  <h2>Documentos de {config.country.name}</h2>
                  <LegalDocuments documents={config.documents} />
                </section>
              </>
            )}
            {!selected && tab === "reports" && reports && (
              <section className="co-panel">
                <h2>Operaciones y comisiones</h2>
                <p>
                  Últimas {reports.operations.length} operaciones.{" "}
                  {config.country.currency} · Fechas de {config.country.name}.
                  Las comisiones se registran al finalizar la conversión.
                </p>
                <button
                  className="co-secondary"
                  onClick={() => {
                    const url = URL.createObjectURL(
                      new Blob([csvReport(reports.operations)], {
                        type: "text/csv;charset=utf-8",
                      }),
                    );
                    const a = document.createElement("a");
                    a.href = url;
                    a.download = "midatopay-colombia-sandbox.csv";
                    a.click();
                    setTimeout(() => URL.revokeObjectURL(url), 1000);
                  }}
                >
                  Descargar CSV
                </button>
                <div className="co-table-scroll">
                  <table>
                    <thead>
                      <tr>
                        <th>Operación</th>
                        <th>Estado</th>
                        <th>{config.country.currency}</th>
                        <th>Comisión registrada</th>
                        <th>USDC</th>
                      </tr>
                    </thead>
                    <tbody>
                      {reports.operations.map((op) => (
                        <tr key={op.id}>
                          <td>
                            {OPERATION_LABELS[op.kind]}
                            <small>{short(op.merchantId)}</small>
                          </td>
                          <td>
                            <Status operation={op} />
                          </td>
                          <td>{money(op.fiatAmount)}</td>
                          <td>{money(op.earnedFee)}</td>
                          <td>{op.usdcAmount}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              </section>
            )}
            {rate && (
              <p className="co-rate">
                Referencia CriptoYa · Compra {money(rate.buy)} / Venta{" "}
                {money(rate.sell)} por USDC · Actualizada{" "}
                {new Date(rate.updatedAt).toLocaleTimeString(
                  config.country.locale,
                  {
                    timeZone: config.country.timeZone,
                  },
                )}
              </p>
            )}
            <footer className="co-footer">
              MidatoPay {config.country.name} · Sandbox · USDC Devnet sin valor
              monetario.
              <br />
              <button
                className="co-text-button"
                onClick={() => {
                  setTab("settings");
                  setSelected(null);
                }}
              >
                Términos, privacidad y servicios
              </button>
            </footer>
          </main>
        </>
      )}
    </div>
  );
}
