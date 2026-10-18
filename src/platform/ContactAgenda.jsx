import React, { useState } from "react";
import { maskAccount } from "./contacts.js";

const emptyContact = () => ({
  name: "",
  alias: "",
  address: "",
  bankAccounts: [],
});
export default function ContactAgenda({
  config,
  contacts = [],
  busy,
  disabled,
  run,
  request,
  refresh,
}) {
  const [draft, setDraft] = useState(emptyContact);
  const bankEnabled = config.features?.bankContacts === true;
  const schema = config.country.bankAccountSchema;
  const set = (key, value) =>
    setDraft((current) => ({ ...current, [key]: value }));
  const setBank = (index, key, value) =>
    setDraft((current) => ({
      ...current,
      bankAccounts: current.bankAccounts.map((account, i) =>
        i === index ? { ...account, [key]: value } : account,
      ),
    }));
  const edit = (contact) =>
    setDraft({
      ...emptyContact(),
      ...contact,
      address: contact.address || "",
      bankAccounts: (contact.bankAccounts || []).map((account) => ({
        ...account,
      })),
    });
  return (
    <section className="co-panel co-form-panel co-agenda">
      <h2>Tu agenda</h2>
      <p>
        {bankEnabled
          ? "Guarda una wallet USDC, cuentas bancarias o ambas en cada contacto."
          : "Guarda las wallets USDC de tus contactos."}
      </p>
      <div className="co-contact-list">
        {contacts.map((contact) => (
          <article className="co-contact" key={contact.id}>
            <div className="co-panel-heading">
              <span>
                <strong>{contact.name}</strong>
                <small className="co-address"> · {contact.alias}</small>
              </span>
              <div className="co-contact-actions">
                <button
                  type="button"
                  className="co-text-button"
                  disabled={busy || disabled}
                  onClick={() => edit(contact)}
                  aria-label={`Editar ${contact.name}`}
                >
                  Editar
                </button>
                <button
                  type="button"
                  className="co-text-button"
                  disabled={busy || disabled}
                  onClick={() =>
                    run("Actualizando agenda", async () => {
                      await request("/contacts/remove", {
                        method: "POST",
                        body: { id: contact.id },
                      });
                      if (draft.id === contact.id) setDraft(emptyContact());
                      await refresh();
                    })
                  }
                  aria-label={`Quitar ${contact.name}`}
                >
                  Quitar
                </button>
              </div>
            </div>
            {contact.address && (
              <p className="co-address">
                USDC · {contact.address.slice(0, 5)}…{contact.address.slice(-5)}
              </p>
            )}
            {bankEnabled &&
              (contact.bankAccounts || []).map((account, index) => (
                <p className="co-bank-summary" key={index}>
                  <strong>{account.bankName}</strong> ·{" "}
                  {schema.accountTypes[account.accountType]} ·{" "}
                  {maskAccount(account.accountNumber)}
                  <br />
                  <small>
                    {account.holderName} · {account.currency}
                  </small>
                </p>
              ))}
          </article>
        ))}
      </div>
      <form
        onSubmit={(event) => {
          event.preventDefault();
          run("Guardando contacto", async () => {
            const { bankAccounts, ...contact } = draft;
            await request("/contacts", {
              method: "POST",
              body: { ...contact, ...(bankEnabled ? { bankAccounts } : {}) },
            });
            setDraft(emptyContact());
            await refresh();
          });
        }}
      >
        <fieldset className="co-contact-fields" disabled={busy || disabled}>
          <legend>{draft.id ? "Editar contacto" : "Nuevo contacto"}</legend>
          <label className="co-field">
            <span>Nombre</span>
            <input
              required
              maxLength={100}
              value={draft.name}
              onChange={(event) => set("name", event.target.value)}
            />
          </label>
          <label className="co-field">
            <span>Alias para voz</span>
            <input
              required
              maxLength={100}
              value={draft.alias}
              onChange={(event) => set("alias", event.target.value)}
            />
          </label>
          <label className="co-field">
            <span>
              Dirección Solana para USDC{bankEnabled ? " (opcional)" : ""}
            </span>
            <input
              required={!bankEnabled}
              autoCapitalize="none"
              autoCorrect="off"
              spellCheck={false}
              maxLength={44}
              value={draft.address}
              onChange={(event) => set("address", event.target.value)}
            />
          </label>
          {bankEnabled && (
            <>
              <h3>Cuentas bancarias (opcional)</h3>
              <p className="co-muted">
                Estas cuentas se guardan en tu agenda. Los retiros requieren
                registrar y validar un destino propio.
              </p>
              {draft.bankAccounts.map((account, index) => (
                <fieldset className="co-contact-bank" key={index}>
                  <legend>
                    Cuenta {index + 1} · {config.country.name} ·{" "}
                    {config.country.currency}
                  </legend>
                  <label className="co-field">
                    <span>Banco</span>
                    <input
                      required
                      maxLength={100}
                      value={account.bankName}
                      onChange={(event) =>
                        setBank(index, "bankName", event.target.value)
                      }
                    />
                  </label>
                  <label className="co-field">
                    <span>Titular de la cuenta</span>
                    <input
                      required
                      maxLength={100}
                      value={account.holderName}
                      onChange={(event) =>
                        setBank(index, "holderName", event.target.value)
                      }
                    />
                  </label>
                  <label className="co-field">
                    <span>Tipo de cuenta</span>
                    <select
                      value={account.accountType}
                      onChange={(event) =>
                        setBank(index, "accountType", event.target.value)
                      }
                    >
                      {Object.entries(schema.accountTypes).map(
                        ([value, label]) => (
                          <option key={value} value={value}>
                            {label}
                          </option>
                        ),
                      )}
                    </select>
                  </label>
                  <label className="co-field">
                    <span>Número de cuenta</span>
                    <input
                      required
                      inputMode="numeric"
                      autoComplete="off"
                      pattern={schema.numberPattern}
                      maxLength={30}
                      value={account.accountNumber}
                      onChange={(event) =>
                        setBank(index, "accountNumber", event.target.value)
                      }
                    />
                  </label>
                  <button
                    type="button"
                    className="co-text-button"
                    onClick={() =>
                      set(
                        "bankAccounts",
                        draft.bankAccounts.filter((_, i) => i !== index),
                      )
                    }
                  >
                    Quitar cuenta {index + 1}
                  </button>
                </fieldset>
              ))}
              <button
                type="button"
                className="co-text-button"
                disabled={draft.bankAccounts.length >= schema.maxAccounts}
                onClick={() =>
                  set("bankAccounts", [
                    ...draft.bankAccounts,
                    {
                      country: config.country.code,
                      currency: config.country.currency,
                      bankName: "",
                      holderName: "",
                      accountType: Object.keys(schema.accountTypes)[0],
                      accountNumber: "",
                    },
                  ])
                }
              >
                + Agregar cuenta bancaria
              </button>
              <small className="co-muted">
                Hasta {schema.maxAccounts} cuentas por contacto.
              </small>
            </>
          )}
          <div className="co-contact-actions">
            <button type="submit" className="co-secondary">
              {draft.id ? "Guardar cambios" : "Guardar contacto"}
            </button>
            {draft.id && (
              <button
                type="button"
                className="co-text-button"
                onClick={() => setDraft(emptyContact())}
              >
                Cancelar edición
              </button>
            )}
          </div>
        </fieldset>
      </form>
    </section>
  );
}
