# Contacts Agenda Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the hardcoded `CONTACTS` array in `src/App.jsx` with a persisted, user-editable contacts agenda (add/edit/delete/search, wallet address validation) that the voice payment flow resolves aliases against.

**Architecture:** A new pure-logic module `src/contacts.js` (storage + CRUD + validation, no React — same pattern as `src/fx.js`/`src/treasury.js`/`src/arc.js`) backs a new `ContactsScreen` UI component added to the existing single-file `src/App.jsx`. Contacts persist in `localStorage` keyed by wallet address, mirroring the existing `arsStorageKey`/`loadArsBalance` pattern already in `App.jsx`. The bottom nav grows from 4 to 5 tabs; the FAB-centering hack (per-index margins) is generalized to a spacer element so it doesn't hardcode tab count.

**Tech Stack:** React 18 (no build step changes), `ethers` v6 (already a dependency, used for `ethers.isAddress`), `localStorage`. No test runner exists in this repo (confirmed in `CLAUDE.md`) — verification is manual: `node --input-type=module -e` one-liners for pure logic in `contacts.js` (it has no React/browser dependency), and `npm run dev` + browser for anything UI-facing, per this project's established convention ("start the dev server and use the feature in a browser before reporting complete").

## Global Constraints

- No test framework may be introduced — this repo intentionally has none (`CLAUDE.md`: "There is no lint script, no test runner, and no test files in this repo").
- Follow existing code conventions exactly: inline `style={{...}}` objects, the `C` design-token object, `Card`/`btnOrange`/`btnOutline` primitives, `t()` from `useLanguage()` for all user-facing strings (no hardcoded Spanish/English in JSX).
- The contact's wallet-address field is named `addr` (not `address`) everywhere — this matches the property name already used throughout the existing codebase (`parsed.contact.addr` in `Voice`, `sendPayment`, gas estimation, `Success`). Using `addr` avoids touching those call sites.
- Contacts persist per wallet address (`mp_contacts_<address>` in `localStorage`), matching the existing `mp_ars_balance_<address>` convention.
- Agenda starts empty for every account — no seed/demo contacts (explicit product decision, see spec).
- Spec reference: `docs/superpowers/specs/2026-08-05-contacts-agenda-design.md`.

---

## File Structure

- **Create** `src/contacts.js` — storage + CRUD + validation for contacts. Pure functions, no React.
- **Modify** `src/i18n.jsx` — add `nav.agenda`, `agenda.*`, `voice.noContactsYet` to both the `en` and `es` translation objects.
- **Modify** `src/App.jsx` — generalize the nav layout, add `ContactsScreen` + `NavButton` components, add the 5th "Agenda" tab, wire contacts state into `AppInner`, remove the hardcoded `CONTACTS` array, thread contacts through `claudeParse`/`Voice`.

---

### Task 1: `src/contacts.js` — storage, CRUD, validation

**Files:**
- Create: `src/contacts.js`

**Interfaces:**
- Produces: `loadContacts(address) -> Contact[]`, `saveContacts(address, list) -> void`, `addContact(list, {name, alias, addr, note}) -> Contact[]`, `updateContact(list, id, {name, alias, addr, note}) -> Contact[]`, `removeContact(list, id) -> Contact[]`, `findByAlias(list, alias) -> Contact|null`, `searchContacts(list, query) -> Contact[]`, `validateContact({name, alias, addr}, list, editingId) -> {valid: boolean, errors: {name?, alias?, addr?}}` where `Contact = {id, name, alias, addr, note}` and error values are the string reason codes `"required"` | `"duplicate"` | `"invalid"`.

- [ ] **Step 1: Write `src/contacts.js`**

```js
import { ethers } from "ethers";

const storageKey = (address) => `mp_contacts_${(address || "").toLowerCase()}`;

export function loadContacts(address) {
  if (!address) return [];
  try {
    const raw = localStorage.getItem(storageKey(address));
    const list = JSON.parse(raw);
    return Array.isArray(list) ? list : [];
  } catch {
    return [];
  }
}

export function saveContacts(address, list) {
  if (!address) return;
  try {
    localStorage.setItem(storageKey(address), JSON.stringify(list));
  } catch {
    /* ignore */
  }
}

function makeId() {
  return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
}

function normalize({ name, alias, addr, note }) {
  return {
    name: name.trim(),
    alias: alias.trim().toLowerCase(),
    addr: addr.trim(),
    note: (note || "").trim(),
  };
}

export function addContact(list, data) {
  return [{ id: makeId(), ...normalize(data) }, ...list];
}

export function updateContact(list, id, data) {
  return list.map((c) => (c.id === id ? { ...c, ...normalize(data) } : c));
}

export function removeContact(list, id) {
  return list.filter((c) => c.id !== id);
}

/** Resuelve un alias hablado a un contacto: match exacto primero, luego "contiene". */
export function findByAlias(list, alias) {
  const a = (alias || "").toLowerCase();
  if (!a) return null;
  return list.find((c) => c.alias === a) || list.find((c) => a.includes(c.alias)) || null;
}

export function searchContacts(list, query) {
  const q = (query || "").trim().toLowerCase();
  if (!q) return list;
  return list.filter((c) => c.name.toLowerCase().includes(q) || c.alias.toLowerCase().includes(q));
}

export function validateContact({ name, alias, addr }, list, editingId) {
  const errors = {};
  if (!name || !name.trim()) errors.name = "required";

  const aliasNorm = (alias || "").trim().toLowerCase();
  if (!aliasNorm) {
    errors.alias = "required";
  } else if (list.some((c) => c.alias === aliasNorm && c.id !== editingId)) {
    errors.alias = "duplicate";
  }

  if (!addr || !ethers.isAddress(addr.trim())) errors.addr = "invalid";

  return { valid: Object.keys(errors).length === 0, errors };
}
```

- [ ] **Step 2: Verify with a Node one-liner (run from the project root — `ethers` resolves from `node_modules`, and `package.json` has `"type": "module"` so plain ESM imports work)**

Run:

```bash
node --input-type=module -e "
import { addContact, updateContact, removeContact, findByAlias, searchContacts, validateContact } from './src/contacts.js';
let list = [];
list = addContact(list, { name: 'Katy R.', alias: 'Katy', addr: '0x1111111111111111111111111111111111111111', note: '' });
console.log('after add:', JSON.stringify(list));
console.log('validate dup alias:', JSON.stringify(validateContact({ name: 'X', alias: 'katy', addr: '0x2222222222222222222222222222222222222222' }, list, null)));
console.log('validate bad addr:', JSON.stringify(validateContact({ name: 'X', alias: 'x', addr: 'not-an-address' }, list, null)));
console.log('validate ok:', JSON.stringify(validateContact({ name: 'X', alias: 'x', addr: '0x2222222222222222222222222222222222222222' }, list, null)));
console.log('findByAlias katy:', JSON.stringify(findByAlias(list, 'katy')));
console.log('search kat:', JSON.stringify(searchContacts(list, 'kat')));
list = updateContact(list, list[0].id, { name: 'Katy Updated', alias: 'katy', addr: list[0].addr, note: 'vip' });
console.log('after update:', JSON.stringify(list));
list = removeContact(list, list[0].id);
console.log('after remove:', JSON.stringify(list));
"
```

Expected:
- `after add`: array with one contact, `alias: "katy"` (lowercased).
- `validate dup alias`: `{"valid":false,"errors":{"alias":"duplicate"}}`.
- `validate bad addr`: `{"valid":false,"errors":{"addr":"invalid"}}`.
- `validate ok`: `{"valid":true,"errors":{}}`.
- `findByAlias katy`: the Katy contact object.
- `search kat`: array with the Katy contact.
- `after update`: `name: "Katy Updated"`, `note: "vip"`.
- `after remove`: `[]`.

If any line doesn't match, fix `src/contacts.js` and re-run before moving on.

- [ ] **Step 3: Commit**

```bash
git add src/contacts.js
git commit -m "Add contacts.js: storage, CRUD, and validation for the contacts agenda"
```

---

### Task 2: i18n — add agenda + nav + voice strings

**Files:**
- Modify: `src/i18n.jsx:226-232` (English `nav` block), `src/i18n.jsx:118-160` (English `voice` block), `src/i18n.jsx:420-426` (Spanish `nav` block), `src/i18n.jsx:312-354` (Spanish `voice` block)

**Interfaces:**
- Produces: translation keys `nav.agenda`, `agenda.title`, `agenda.subtitle`, `agenda.searchPlaceholder`, `agenda.addButton`, `agenda.emptyTitle`, `agenda.emptyBody`, `agenda.copy`, `agenda.copied`, `agenda.form.nameLabel`, `agenda.form.namePlaceholder`, `agenda.form.aliasLabel`, `agenda.form.aliasPlaceholder`, `agenda.form.addressLabel`, `agenda.form.addressPlaceholder`, `agenda.form.noteLabel`, `agenda.form.notePlaceholder`, `agenda.form.save`, `agenda.form.saveNew`, `agenda.form.cancel`, `agenda.form.delete`, `agenda.errors.name`, `agenda.errors.alias`, `agenda.errors.aliasDuplicate`, `agenda.errors.addr`, `voice.noContactsYet` — in both `en` and `es`.

- [ ] **Step 1: Add `agenda` key to the English translations block, right after `stackScreen` (which ends at `src/i18n.jsx:225`, just before `nav:` at line 226)**

Insert before the existing `nav: { home: "Home", ... }` block in the `en` object:

```js
    agenda: {
      title: "Contacts",
      subtitle: "Save wallet addresses so voice payments can find them by alias.",
      searchPlaceholder: "Search by name or alias",
      addButton: "+ Add contact",
      emptyTitle: "No contacts yet",
      emptyBody: "Add a contact with a wallet address and alias to start paying by voice.",
      copy: "copy",
      copied: "copied ✓",
      form: {
        nameLabel: "Name",
        namePlaceholder: "Katy R.",
        aliasLabel: "Alias (used in voice commands)",
        aliasPlaceholder: "katy",
        addressLabel: "Wallet address",
        addressPlaceholder: "0x…",
        noteLabel: "Note (optional)",
        notePlaceholder: "Deenex — CFO",
        save: "Save contact",
        saveNew: "Add contact",
        cancel: "Cancel",
        delete: "Delete contact",
      },
      errors: {
        name: "Enter a name.",
        alias: "Enter an alias.",
        aliasDuplicate: "You already have a contact with that alias.",
        addr: "That doesn't look like a valid wallet address.",
      },
    },
```

- [ ] **Step 2: Add `agenda: "Contacts"` to the English `nav` block (`src/i18n.jsx:226-232`)**

```js
    nav: {
      home: "Home",
      movements: "Activity",
      stack: "Stack",
      agenda: "Contacts",
      more: "More",
      voiceAria: "Pay by voice",
    },
```

- [ ] **Step 3: Add `noContactsYet` to the English `voice` block, next to the existing `aliasNotFound` key (`src/i18n.jsx:142`)**

```js
      aliasNotFound: (alias) => `I couldn't find the alias "${alias}" in your contacts.`,
      noContactsYet: "You don't have any contacts saved yet. Go to Contacts and add one with a wallet address and alias.",
```

- [ ] **Step 4: Repeat steps 1-3 for the Spanish (`es`) object.** Add before Spanish `nav:` (currently `src/i18n.jsx:420`, right after `stackScreen` which ends around line 419):

```js
    agenda: {
      title: "Agenda",
      subtitle: "Guardá direcciones de wallet para que los pagos por voz las encuentren por alias.",
      searchPlaceholder: "Buscar por nombre o alias",
      addButton: "+ Agregar contacto",
      emptyTitle: "Todavía no tenés contactos",
      emptyBody: "Agregá un contacto con su dirección de wallet y un alias para empezar a pagar por voz.",
      copy: "copiar",
      copied: "copiada ✓",
      form: {
        nameLabel: "Nombre",
        namePlaceholder: "Katy R.",
        aliasLabel: "Alias (se usa en los comandos de voz)",
        aliasPlaceholder: "katy",
        addressLabel: "Dirección de wallet",
        addressPlaceholder: "0x…",
        noteLabel: "Nota (opcional)",
        notePlaceholder: "Deenex — CFO",
        save: "Guardar cambios",
        saveNew: "Agregar contacto",
        cancel: "Cancelar",
        delete: "Borrar contacto",
      },
      errors: {
        name: "Ingresá un nombre.",
        alias: "Ingresá un alias.",
        aliasDuplicate: "Ya tenés un contacto con ese alias.",
        addr: "Esa dirección de wallet no parece válida.",
      },
    },
```

Spanish `nav` block (`src/i18n.jsx:420-426`):

```js
    nav: {
      home: "Inicio",
      movements: "Movimientos",
      stack: "Stack",
      agenda: "Agenda",
      more: "Más",
      voiceAria: "Pagar por voz",
    },
```

Spanish `voice.aliasNotFound` neighbor (`src/i18n.jsx:336`):

```js
      aliasNotFound: (alias) => `No encontré el alias «${alias}» en tus contactos.`,
      noContactsYet: "Todavía no tenés contactos guardados. Andá a Agenda y cargá uno con su dirección de wallet y alias.",
```

- [ ] **Step 5: Verify the file still has balanced syntax by starting the dev server**

Run: `npm run dev`

Expected: Vite starts cleanly (no esbuild/parse error overlay). If there's a syntax error, it'll point at the exact line — fix and restart. Stop the server (Ctrl+C) once confirmed.

- [ ] **Step 6: Commit**

```bash
git add src/i18n.jsx
git commit -m "Add agenda, nav.agenda, and voice.noContactsYet translations (EN/ES)"
```

---

### Task 3: Generalize the bottom nav layout (no behavior change yet)

**Files:**
- Modify: `src/App.jsx:180-192` (add `NavButton` near `CircleAction`)
- Modify: `src/App.jsx:1540-1576` (the `shell` function's `<nav>` block)

**Interfaces:**
- Consumes: nothing new.
- Produces: `NavButton({active, icon, label, onClick})` component (module scope), and a `navTabs`/`navMid` pattern inside `shell` that Task 4 will extend with a 5th entry.

**Context:** Today the FAB gap is faked with `marginRight: i === 1 ? 28 : 0, marginLeft: i === 2 ? 28 : 0` on a hardcoded 4-item array (`src/App.jsx:1559`) — it only works for exactly 4 tabs. This task replaces it with an explicit spacer `div` splitting the tabs array in half, so adding a 5th tab (Task 4) doesn't require touching the spacing logic again. This step keeps the same 4 tabs (`home`, `movs`, `stack`, `mas`) — it's a pure refactor, verified by confirming the nav looks and behaves identically before and after.

- [ ] **Step 1: Add a `NavButton` component right after `CircleAction` in `src/App.jsx` (after line 192, before the `// ————— Marca —————` comment at line 194)**

```jsx
function NavButton({ active, icon, label, onClick }) {
  return (
    <button
      onClick={onClick}
      style={{
        flex: 1, background: "none", border: "none", cursor: "pointer", display: "flex", flexDirection: "column",
        alignItems: "center", gap: 3, fontFamily: "inherit", padding: 0,
        color: active ? C.violet : C.mut,
      }}
    >
      <span style={{ fontSize: 18 }}>{icon}</span>
      <span style={{ fontSize: 10, fontWeight: 600 }}>{label}</span>
    </button>
  );
}
```

- [ ] **Step 2: Replace the `shell` function's nav block (`src/App.jsx:1540-1576`)**

Old:

```jsx
  const shell = (children) => (
    <div className="mp-stage">
      <div className="mp-device">
        <div className="mp-scroll" style={{ padding: "22px 18px 112px" }}>{children}</div>

        <nav className="mp-nav">
          {[
            { id: "home", label: t("nav.home"), icon: "⌂" },
            { id: "movs", label: t("nav.movements"), icon: "☰" },
            { id: "stack", label: t("nav.stack"), icon: "◫" },
            { id: "mas", label: t("nav.more"), icon: "⋯" },
          ].map((tItem, i) => (
            <button
              key={tItem.id}
              onClick={() => { setReceipt(null); setTab(tItem.id); }}
              style={{
                flex: 1, background: "none", border: "none", cursor: "pointer", display: "flex", flexDirection: "column",
                alignItems: "center", gap: 3, fontFamily: "inherit", padding: 0,
                color: tab === tItem.id ? C.violet : C.mut,
                marginRight: i === 1 ? 28 : 0, marginLeft: i === 2 ? 28 : 0,
              }}
            >
              <span style={{ fontSize: 18 }}>{tItem.icon}</span>
              <span style={{ fontSize: 10, fontWeight: 600 }}>{tItem.label}</span>
            </button>
          ))}
          <button
            onClick={() => { setReceipt(null); setTab("voice"); }}
            className="mp-fab"
            aria-label={t("nav.voiceAria")}
          >
            🎙
          </button>
        </nav>
      </div>
    </div>
  );
```

New:

```jsx
  const navTabs = [
    { id: "home", label: t("nav.home"), icon: "⌂" },
    { id: "movs", label: t("nav.movements"), icon: "☰" },
    { id: "stack", label: t("nav.stack"), icon: "◫" },
    { id: "mas", label: t("nav.more"), icon: "⋯" },
  ];
  const navMid = Math.ceil(navTabs.length / 2);
  const goTab = (id) => { setReceipt(null); setTab(id); };

  const shell = (children) => (
    <div className="mp-stage">
      <div className="mp-device">
        <div className="mp-scroll" style={{ padding: "22px 18px 112px" }}>{children}</div>

        <nav className="mp-nav">
          {navTabs.slice(0, navMid).map((tItem) => (
            <NavButton key={tItem.id} active={tab === tItem.id} icon={tItem.icon} label={tItem.label} onClick={() => goTab(tItem.id)} />
          ))}
          <div style={{ width: 56, flexShrink: 0 }} aria-hidden="true" />
          {navTabs.slice(navMid).map((tItem) => (
            <NavButton key={tItem.id} active={tab === tItem.id} icon={tItem.icon} label={tItem.label} onClick={() => goTab(tItem.id)} />
          ))}
          <button onClick={() => goTab("voice")} className="mp-fab" aria-label={t("nav.voiceAria")}>
            🎙
          </button>
        </nav>
      </div>
    </div>
  );
```

Note: `navTabs`/`navMid`/`goTab` must be declared inside `AppInner`, above the `shell` definition, since they use `t`, `tab`, and `setReceipt`/`setTab` from that scope.

- [ ] **Step 3: Manually verify no visual regression**

Run: `npm run dev`, open the printed local URL, log in.

Expected: bottom nav still shows Home / Movimientos / Stack / Más evenly spaced with the orange mic FAB centered on top, overlapping between "Movimientos" and "Stack" same as before. Tapping each tab still switches screens. No console errors. Stop the server once confirmed.

- [ ] **Step 4: Commit**

```bash
git add src/App.jsx
git commit -m "Generalize bottom nav FAB spacing so tab count isn't hardcoded"
```

---

### Task 4: `ContactsScreen` + wire the 5th "Agenda" tab

**Files:**
- Modify: `src/App.jsx:1` (imports)
- Modify: `src/App.jsx` (add `ContactsScreen` component, after `Stack` — currently ends at line 1346, before the `// ————— App —————` comment at line 1348)
- Modify: `src/App.jsx` (AppInner: add `contacts` state + handlers, extend `navTabs`, wire the `agenda` tab into the render switch)

**Interfaces:**
- Consumes: `loadContacts`, `saveContacts`, `addContact`, `updateContact`, `removeContact`, `searchContacts`, `validateContact` from `./contacts.js` (Task 1); `t("agenda.*")` (Task 2); `NavButton`, `navTabs`, `navMid` (Task 3).
- Produces: `ContactsScreen({contacts, onAdd, onUpdate, onRemove})` component; `contacts` array available in `AppInner` state for Task 5 to consume.

- [ ] **Step 1: Add the import in `src/App.jsx:1`, right after the existing imports (after line 20, the `i18n.jsx` import)**

```jsx
import {
  loadContacts,
  saveContacts,
  addContact,
  updateContact,
  removeContact,
  searchContacts,
  validateContact,
} from "./contacts.js";
```

- [ ] **Step 2: Add `errorMessage` helper and `ContactsScreen` component, right after the `Stack` component (after its closing `}` — currently line 1346 — and before `// ————— App —————` at line 1348)**

```jsx
function errorMessage(t, field, reason) {
  if (field === "alias" && reason === "duplicate") return t("agenda.errors.aliasDuplicate");
  return t(`agenda.errors.${field}`);
}

// ————— Agenda —————
function ContactsScreen({ contacts, onAdd, onUpdate, onRemove }) {
  const { t } = useLanguage();
  const [query, setQuery] = useState("");
  const [form, setForm] = useState(null); // null = cerrado; { } = nuevo o edición
  const [errors, setErrors] = useState({});
  const [copiedId, setCopiedId] = useState(null);

  const visible = searchContacts(contacts, query);
  const editingId = form?.id || null;

  const openNew = () => { setForm({ name: "", alias: "", addr: "", note: "" }); setErrors({}); };
  const openEdit = (c) => { setForm({ ...c }); setErrors({}); };
  const close = () => { setForm(null); setErrors({}); };

  const save = () => {
    const check = validateContact(form, contacts, editingId);
    if (!check.valid) {
      setErrors(check.errors);
      return;
    }
    if (editingId) onUpdate(editingId, form);
    else onAdd(form);
    close();
  };

  const del = () => {
    if (!editingId) return;
    onRemove(editingId);
    close();
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
        style={{ width: "100%", background: C.bg, border: `1px solid ${C.line}`, borderRadius: 12, padding: "13px 14px", fontSize: 15, color: C.ink, outline: "none", fontFamily: "inherit", boxSizing: "border-box" }}
      />
      {errors[key] && <div style={{ fontSize: 12.5, color: C.red, marginTop: 6 }}>{errorMessage(t, key, errors[key])}</div>}
    </label>
  );

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 16 }}>
      <div>
        <h2 style={{ fontSize: 26, fontWeight: 700, color: C.ink, margin: 0, letterSpacing: -0.4 }}>{t("agenda.title")}</h2>
        <p style={{ fontSize: 14.5, color: C.mut, marginTop: 6, lineHeight: 1.5 }}>{t("agenda.subtitle")}</p>
      </div>

      {!form && (
        <>
          <input
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder={t("agenda.searchPlaceholder")}
            style={{ background: C.card, border: `1px solid ${C.line}`, borderRadius: 14, padding: "13px 16px", fontSize: 15, color: C.ink, outline: "none", fontFamily: "inherit" }}
          />

          <button onClick={openNew} style={btnOutline}>{t("agenda.addButton")}</button>

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
                  <span style={{ width: 42, height: 42, borderRadius: "50%", background: C.violetSoft, display: "grid", placeItems: "center", color: C.violet, fontWeight: 700, fontSize: 15, flexShrink: 0 }}>
                    {c.name.slice(0, 1).toUpperCase()}
                  </span>
                  <span style={{ minWidth: 0 }}>
                    <div style={{ fontSize: 15.5, fontWeight: 600, color: C.ink }}>{c.name}</div>
                    <div style={{ fontSize: 13, color: C.mut }}>@{c.alias} · {short(c.addr)}</div>
                  </span>
                </button>
                <button
                  onClick={() => copy(c)}
                  style={{ background: C.bg, border: "none", borderRadius: 20, padding: "6px 12px", fontSize: 12, fontWeight: 600, color: C.ink, cursor: "pointer", fontFamily: "inherit", flexShrink: 0 }}
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
          {field("name", t("agenda.form.nameLabel"), t("agenda.form.namePlaceholder"))}
          {field("alias", t("agenda.form.aliasLabel"), t("agenda.form.aliasPlaceholder"))}
          {field("addr", t("agenda.form.addressLabel"), t("agenda.form.addressPlaceholder"))}
          {field("note", t("agenda.form.noteLabel"), t("agenda.form.notePlaceholder"))}

          <div style={{ display: "flex", flexDirection: "column", gap: 10 }}>
            <button onClick={save} style={btnOrange}>{editingId ? t("agenda.form.save") : t("agenda.form.saveNew")}</button>
            <button onClick={close} style={{ ...btnOutline, border: "none", color: C.mut }}>{t("agenda.form.cancel")}</button>
            {editingId && (
              <button onClick={del} style={{ ...btnOutline, border: `1.5px solid ${C.red}`, color: C.red }}>{t("agenda.form.delete")}</button>
            )}
          </div>
        </Card>
      )}
    </div>
  );
}
```

- [ ] **Step 3: Add `contacts` state + handlers in `AppInner`, right after the `arsBalance` effect (`src/App.jsx:1380-1382`)**

```jsx
  const [contacts, setContacts] = useState([]);

  useEffect(() => {
    setContacts(loadContacts(address));
  }, [address]);

  const handleAddContact = useCallback(
    (data) => {
      setContacts((prev) => {
        const next = addContact(prev, data);
        saveContacts(address, next);
        return next;
      });
    },
    [address]
  );

  const handleUpdateContact = useCallback(
    (id, data) => {
      setContacts((prev) => {
        const next = updateContact(prev, id, data);
        saveContacts(address, next);
        return next;
      });
    },
    [address]
  );

  const handleRemoveContact = useCallback(
    (id) => {
      setContacts((prev) => {
        const next = removeContact(prev, id);
        saveContacts(address, next);
        return next;
      });
    },
    [address]
  );
```

- [ ] **Step 4: Add the "agenda" entry to `navTabs` (defined in Task 3, inside `AppInner` just above `shell`) — insert between `stack` and `mas`**

```jsx
  const navTabs = [
    { id: "home", label: t("nav.home"), icon: "⌂" },
    { id: "movs", label: t("nav.movements"), icon: "☰" },
    { id: "stack", label: t("nav.stack"), icon: "◫" },
    { id: "agenda", label: t("nav.agenda"), icon: "📇" },
    { id: "mas", label: t("nav.more"), icon: "⋯" },
  ];
```

- [ ] **Step 5: Wire the `agenda` tab into the render switch, right after `{tab === "stack" && <Stack />}` (`src/App.jsx:1640`)**

```jsx
      {tab === "agenda" && (
        <ContactsScreen
          contacts={contacts}
          onAdd={handleAddContact}
          onUpdate={handleUpdateContact}
          onRemove={handleRemoveContact}
        />
      )}
```

- [ ] **Step 6: Manually verify in the browser**

Run: `npm run dev`, open the printed local URL, log in.

Expected:
1. Bottom nav now shows 5 tabs: Home, Movimientos, Stack, Agenda, Más (2 left of the FAB gap, 3 right), FAB still centered.
2. Tap "Agenda" → empty state message shown (no seed contacts).
3. Tap "+ Agregar contacto", leave everything blank, save → see 3 inline errors (name, alias, address).
4. Fill name "Katy R.", alias "katy", address `0x1111111111111111111111111111111111111111` → save → contact appears in the list with initial "K", `@katy`, and short address.
5. Tap the contact → form reopens prefilled → change note → save → change is reflected in the list.
6. Tap the contact again → "Borrar contacto" → contact disappears, empty state returns.
7. Open browser devtools → Application → Local Storage → confirm a `mp_contacts_0x...` key exists and its JSON matches whatever contacts are currently saved.

Stop the server once confirmed.

- [ ] **Step 7: Commit**

```bash
git add src/App.jsx
git commit -m "Add ContactsScreen and wire the Agenda tab into the nav"
```

---

### Task 5: Wire contacts into the voice payment flow, remove the hardcoded `CONTACTS`

**Files:**
- Modify: `src/App.jsx:1` (imports — add `findByAlias`)
- Modify: `src/App.jsx:67-72` (remove `CONTACTS` array)
- Modify: `src/App.jsx:93-135` (`claudeParse` — accept `aliases` param)
- Modify: `src/App.jsx:779` (`Voice` component signature)
- Modify: `src/App.jsx:789-827` (`Voice.analyze`)
- Modify: `src/App.jsx:994-996` (confirm screen — derive initial instead of `contact.ini`)
- Modify: `src/App.jsx:1638` (pass `contacts` into `<Voice>`)

**Interfaces:**
- Consumes: `contacts` state from `AppInner` (Task 4), `findByAlias` from `./contacts.js` (Task 1), `t("voice.noContactsYet")` (Task 2).
- Produces: `claudeParse(text, lang, aliases)` (new 3rd param), `Voice({..., contacts})` (new prop).

- [ ] **Step 1: Add `findByAlias` to the `./contacts.js` import added in Task 4 (`src/App.jsx:1`)**

```jsx
import {
  loadContacts,
  saveContacts,
  addContact,
  updateContact,
  removeContact,
  findByAlias,
  searchContacts,
  validateContact,
} from "./contacts.js";
```

- [ ] **Step 2: Remove the hardcoded `CONTACTS` array (`src/App.jsx:67-72`)**

Delete:

```jsx
const CONTACTS = [
  { alias: "katy", name: "Katy R.", addr: "0x1111111111111111111111111111111111111111", ini: "KR" },
  { alias: "alan", name: "Alan T. — Deenex", addr: "0x2222222222222222222222222222222222222222", ini: "AT" },
  { alias: "juanp", name: "Juan Pablo Z.", addr: "0x3333333333333333333333333333333333333333", ini: "JP" },
  { alias: "martin", name: "Martín — COO", addr: "0x4444444444444444444444444444444444444444", ini: "MC" },
];
```

- [ ] **Step 3: Update `claudeParse` to accept an `aliases` array instead of reading `CONTACTS` (`src/App.jsx:93-135`)**

Change the signature and both prompt template literals:

```jsx
async function claudeParse(text, lang, aliases) {
  if (!API_KEY) throw new Error("no-key");
  const prompt =
    lang === "en"
      ? `You are MidatoPay's voice payment agent. Extract the intent from this English command and respond ONLY with valid JSON, no markdown or extra text.

Command: "${text}"

Valid contact aliases: ${aliases.join(", ")}

Exact format:
{"intent":"send"|"unknown","amount":<number or null>,"currency":"USDC"|"ARS","recipient":"<closest matching contact alias or null>","confidence":<0 to 1>}

Rules: "dollars", "usd" or "usdc" → USDC. "pesos" or "ars" → ARS. If the currency isn't stated or is unclear, default to USDC — never guess ARS. Match the alias even if misheard (e.g. "caty" → "katy").`
      : `Sos el agente de pagos por voz de MidatoPay. Extraé la intención de este comando en español rioplatense y respondé SOLO con JSON válido, sin markdown ni texto extra.

Comando: "${text}"

Contactos válidos (alias): ${aliases.join(", ")}

Formato exacto:
{"intent":"send"|"unknown","amount":<número o null>,"currency":"USDC"|"ARS","recipient":"<alias del contacto más parecido o null>","confidence":<0 a 1>}

Reglas: "dólares", "usd" o "usdc" → USDC. "pesos" o "ars" → ARS. Si la moneda no está clara o no se menciona, default a USDC — nunca asumas ARS. Matcheá el alias aunque esté mal transcripto (ej: "caty" → "katy").`;

  const res = await fetch("https://api.anthropic.com/v1/messages", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "x-api-key": API_KEY,
      "anthropic-version": "2023-06-01",
      "anthropic-dangerous-direct-browser-access": "true",
    },
    body: JSON.stringify({
      model: "claude-haiku-4-5",
      max_tokens: 300,
      messages: [{ role: "user", content: prompt }],
    }),
  });
  const data = await res.json();
  const raw = (data.content || []).filter((b) => b.type === "text").map((b) => b.text).join("\n");
  return JSON.parse(raw.replace(/```json|```/g, "").trim());
}
```

(Only the signature and the two `${aliases.join(", ")}` lines changed — everything else in the function is unchanged.)

- [ ] **Step 4: Update the `Voice` component signature (`src/App.jsx:779`)**

Old: `function Voice({ sendPayment, balance, onDone, fxRate, address }) {`

New: `function Voice({ sendPayment, balance, onDone, fxRate, address, contacts }) {`

- [ ] **Step 5: Update `Voice.analyze` (`src/App.jsx:789-827`)**

Old:

```jsx
  const analyze = useCallback(
    async (text) => {
      setTranscript(text);
      setPhase("parsing");
      let result;
      try {
        result = await claudeParse(text, lang);
      } catch {
        result = localParse(text, lang);
      }
      if (!result || result.intent !== "send" || !result.amount || !result.recipient) {
        setErrMsg(t("voice.noPaymentUnderstood"));
        setPhase("error");
        return;
      }
      const contact =
        CONTACTS.find((c) => c.alias === (result.recipient || "").toLowerCase()) ||
        CONTACTS.find((c) => (result.recipient || "").toLowerCase().includes(c.alias));
      if (!contact) {
        setErrMsg(t("voice.aliasNotFound", result.recipient));
        setPhase("error");
        return;
      }
      const usdc = result.currency === "ARS" ? result.amount / fxRate : result.amount;
      if (usdc < 0.01) {
        setErrMsg(t("voice.amountTooLow", result.amount, result.currency));
        setPhase("error");
        return;
      }
      if (balance !== null && usdc > balance) {
        setErrMsg(t("voice.insufficientBalance", fmt(usdc, 2, locale), fmt(balance, 2, locale)));
        setPhase("error");
        return;
      }
      setParsed({ ...result, contact, usdc, fxRate, factura: nuevaFactura() });
      setPhase("confirm");
    },
    [balance, fxRate, lang, locale, t]
  );
```

New:

```jsx
  const analyze = useCallback(
    async (text) => {
      setTranscript(text);
      setPhase("parsing");
      if (contacts.length === 0) {
        setErrMsg(t("voice.noContactsYet"));
        setPhase("error");
        return;
      }
      let result;
      try {
        result = await claudeParse(text, lang, contacts.map((c) => c.alias));
      } catch {
        result = localParse(text, lang);
      }
      if (!result || result.intent !== "send" || !result.amount || !result.recipient) {
        setErrMsg(t("voice.noPaymentUnderstood"));
        setPhase("error");
        return;
      }
      const contact = findByAlias(contacts, result.recipient);
      if (!contact) {
        setErrMsg(t("voice.aliasNotFound", result.recipient));
        setPhase("error");
        return;
      }
      const usdc = result.currency === "ARS" ? result.amount / fxRate : result.amount;
      if (usdc < 0.01) {
        setErrMsg(t("voice.amountTooLow", result.amount, result.currency));
        setPhase("error");
        return;
      }
      if (balance !== null && usdc > balance) {
        setErrMsg(t("voice.insufficientBalance", fmt(usdc, 2, locale), fmt(balance, 2, locale)));
        setPhase("error");
        return;
      }
      setParsed({ ...result, contact, usdc, fxRate, factura: nuevaFactura() });
      setPhase("confirm");
    },
    [balance, fxRate, lang, locale, t, contacts]
  );
```

- [ ] **Step 6: Derive the initial instead of reading `contact.ini` in the confirm screen (`src/App.jsx:994-996`)**

Old:

```jsx
              <div style={{ width: 46, height: 46, borderRadius: "50%", background: C.violetSoft, display: "grid", placeItems: "center", color: C.violet, fontWeight: 700, fontSize: 15 }}>
                {parsed.contact.ini}
              </div>
```

New:

```jsx
              <div style={{ width: 46, height: 46, borderRadius: "50%", background: C.violetSoft, display: "grid", placeItems: "center", color: C.violet, fontWeight: 700, fontSize: 15 }}>
                {parsed.contact.name.slice(0, 1).toUpperCase()}
              </div>
```

- [ ] **Step 7: Pass `contacts` into `<Voice>` in the render switch (`src/App.jsx:1638`)**

Old: `{tab === "voice" && <Voice sendPayment={sendPayment} balance={balance} onDone={setReceipt} fxRate={fxRate} address={address} />}`

New: `{tab === "voice" && <Voice sendPayment={sendPayment} balance={balance} onDone={setReceipt} fxRate={fxRate} address={address} contacts={contacts} />}`

- [ ] **Step 8: Manually verify the full flow in the browser**

Run: `npm run dev`, open the printed local URL, log in.

1. With the agenda empty, tap the mic FAB → type "enviar 1 dólar a katy" (or the EN equivalent) → confirm the error shown is the new "no contacts yet" message (not "alias not found").
2. Go to Agenda, add a contact: name "Katy R.", alias "katy", address `0x1111111111111111111111111111111111111111`.
3. Go back to the mic FAB → type "enviar 1 dólar a katy" → confirm it reaches the confirm screen showing "Katy R.", the short address, and a "K" initial avatar (not blank/undefined).
4. Type "enviar 1 dólar a nadie" (an alias that doesn't exist) → confirm the "alias not found" message still shows correctly (distinct from the empty-agenda case).
5. Check the browser console for errors throughout — none expected.

Stop the server once confirmed.

- [ ] **Step 9: Commit**

```bash
git add src/App.jsx
git commit -m "Wire the contacts agenda into the voice payment flow, remove hardcoded CONTACTS"
```

---

## Self-Review

**Spec coverage:**
- Data model + storage (`src/contacts.js`, per-address key, empty start) → Task 1. ✓
- UI: 5th tab, nav fix, `ContactsScreen` with search/add/edit/delete/validation → Tasks 3-4. ✓
- Voice integration incl. empty-agenda message → Task 5. ✓
- i18n additions (`agenda.*`, `nav.agenda`, `voice.noContactsYet`) → Task 2. ✓
- Out-of-scope items from the spec (quick pay/charge actions, FAB redesign, component extraction) are not implemented — confirmed absent from all 5 tasks. ✓

**Placeholder scan:** No TBD/TODO; every step has literal code or an exact manual verification procedure with expected output.

**Type/naming consistency:** `Contact.addr` (not `.address`) used consistently across `contacts.js`, `ContactsScreen`, `Voice`, and the existing `sendPayment`/gas-estimate call sites that were already using `.addr` — verified by grep during planning that `.addr` is the only property name used for the wallet address throughout `App.jsx`. `findByAlias`/`searchContacts`/`validateContact`/`addContact`/`updateContact`/`removeContact`/`loadContacts`/`saveContacts` names match between Task 1's exports and every later task's imports and call sites.
