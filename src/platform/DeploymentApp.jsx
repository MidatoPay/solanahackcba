import React, { lazy, Suspense, useEffect, useState } from "react";
import { SOLANA } from "../chain.js";
const LegacyApp = lazy(() => import("../App.jsx"));
const PlatformApp = lazy(() => import("./PlatformApp.jsx"));

export default function DeploymentApp() {
  const [state, setState] = useState({ config: null, error: "" });
  useEffect(() => {
    let canceled = false;
    fetch("/app-config", {
      cache: "no-store",
      signal: AbortSignal.timeout(10000),
    })
      .then(async (response) => {
        const value = await response.json();
        if (!response.ok)
          throw new Error(
            value.error === "colombia_requires_sandbox_devnet"
              ? "Este despliegue de Colombia requiere OnePay sandbox y Solana Devnet."
              : "No pudimos cargar la configuración del país.",
          );
        if (value.network !== SOLANA.cluster)
          throw new Error(
            "La red de la aplicación no coincide con el servidor. Revisa la configuración del despliegue.",
          );
        if (!canceled) setState({ config: value, error: "" });
      })
      .catch((error) => {
        if (!canceled) setState({ config: null, error: error.message });
      });
    return () => {
      canceled = true;
    };
  }, []);
  if (state.error)
    return (
      <main
        style={{
          maxWidth: 600,
          margin: "15vh auto",
          padding: 24,
          fontFamily: "system-ui",
        }}
      >
        <h1>MidatoPay</h1>
        <p role="alert">{state.error}</p>
        <button onClick={() => window.location.reload()}>Reintentar</button>
      </main>
    );
  if (!state.config)
    return (
      <p role="status" style={{ padding: 32, fontFamily: "system-ui" }}>
        Preparando MidatoPay…
      </p>
    );
  return (
    <Suspense fallback={<p role="status">Cargando tu billetera…</p>}>
      {state.config.country.legacy ? (
        <LegacyApp />
      ) : (
        <PlatformApp config={state.config} />
      )}
    </Suspense>
  );
}
