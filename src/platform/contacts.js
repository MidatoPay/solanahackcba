import { isAddress } from "@solana/kit";
import { bankContactsAvailable } from "./countries.js";
import { PlatformError } from "./money.js";

const text = (value, max = 100) =>
  typeof value === "string" &&
  value.trim() &&
  value.length <= max &&
  !/[\u0000-\u001f\u007f]/.test(value);
export const maskAccount = (value) => `•••• ${String(value).slice(-4)}`;
export const walletContacts = (contacts) =>
  (contacts || []).filter((contact) => contact.address);
export function normalizeContact(input, config, previous = null) {
  if (!input || !text(input.name) || !text(input.alias))
    throw new PlatformError("invalid_contact", 400);
  const address = typeof input.address === "string" ? input.address.trim() : "";
  if (address && !isAddress(address))
    throw new PlatformError("invalid_contact_wallet", 400);
  let accounts = previous?.bank_accounts || [];
  if (input.bankAccounts !== undefined) {
    if (!Array.isArray(input.bankAccounts))
      throw new PlatformError("invalid_bank_contact", 400);
    if (input.bankAccounts.length && !bankContactsAvailable(config))
      throw new PlatformError("bank_contacts_unavailable", 403);
    const schema = config.country.bankAccountSchema;
    if (input.bankAccounts.length > (schema?.maxAccounts || 0))
      throw new PlatformError("invalid_bank_contact", 400);
    accounts = input.bankAccounts.map((account) => {
      if (
        !account ||
        account.country !== config.country.code ||
        account.currency !== config.country.currency ||
        !text(account.bankName) ||
        !text(account.holderName) ||
        !Object.hasOwn(schema.accountTypes, account.accountType) ||
        typeof account.accountNumber !== "string" ||
        !new RegExp(schema.numberPattern).test(account.accountNumber.trim())
      )
        throw new PlatformError("invalid_bank_contact", 400);
      return {
        country: config.country.code,
        currency: config.country.currency,
        bankName: account.bankName.trim(),
        holderName: account.holderName.trim(),
        accountType: account.accountType,
        accountNumber: account.accountNumber.trim(),
      };
    });
    const identities = accounts.map(
      (a) => `${a.bankName.toLowerCase()}:${a.accountType}:${a.accountNumber}`,
    );
    if (new Set(identities).size !== identities.length)
      throw new PlatformError("duplicate_bank_contact", 400);
  }
  if (!address && !accounts.length)
    throw new PlatformError("contact_destination_required", 400);
  return {
    name: input.name.trim(),
    alias: input.alias.trim().toLowerCase(),
    address: address || null,
    bankAccounts: accounts,
  };
}
