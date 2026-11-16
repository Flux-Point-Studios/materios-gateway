/**
 * Who may write to the blob store.
 *
 * Every store write takes a WriteGrant, and grantWrite is the only place one
 * is made. On the preprod profile it grants every caller the route's own
 * authentication let through. On the tenant-only (mainnet) profile it grants
 * tenants alone: an API key with an api_keys row, or an account on
 * TENANT_ADDRESSES. A route that reaches a store write without having passed
 * through here has no grant to hand it.
 */

import type { Response } from "express";
import type { AuthResult } from "./auth.js";
import type { KeyInfo } from "./quota.js";
import { config } from "./config.js";
import { normalizeSs58 } from "./ss58.js";

export interface Tenant {
  /**
   * The tenant's one name, which keys its quota and owns what it stores:
   * `key:<key hash>` for an API key, the canonical address for an account.
   */
  id: string;
  keyInfo?: KeyInfo;
}

/** Who a request was authenticated as: an API key's row, or an account. */
export interface Principal {
  keyInfo?: KeyInfo;
  account?: string;
}

declare const granted: unique symbol;

export interface WriteGrant {
  /** Null on the preprod profile, where a write is not tied to a tenant. */
  readonly tenant: Tenant | null;
  readonly [granted]: true;
}

const issued = new WeakSet<WriteGrant>();

function issue(tenant: Tenant | null): WriteGrant {
  const grant = Object.freeze({ tenant }) as WriteGrant;
  issued.add(grant);
  return grant;
}

/** The tenant an account is, under any spelling of its address, or null. */
export function accountTenant(address: string): Tenant | null {
  let account: string;
  try {
    account = normalizeSs58(address);
  } catch {
    return null;
  }
  return config.tenantAddresses.includes(account) ? { id: account } : null;
}

/**
 * The principal behind a resolved request. A Bearer token names an account,
 * so it is a tenant through the account allowlist like a signature is.
 */
export function principalOf(auth: AuthResult): Principal {
  return auth.tier === "api-key" ? { keyInfo: auth.keyInfo } : { account: auth.identity };
}

/** A grant for one request's writes, or null when the profile refuses the caller. */
export function grantWrite(principal: Principal): WriteGrant | null {
  if (!config.tenantOnly) return issue(null);
  const tenant = principal.keyInfo
    ? { id: `key:${principal.keyInfo.keyHash}`, keyInfo: principal.keyInfo }
    : principal.account
      ? accountTenant(principal.account)
      : null;
  return tenant ? issue(tenant) : null;
}

/** Called by every store write: throws unless `grant` came from grantWrite under the current profile. */
export function assertWriteGrant(grant: WriteGrant): void {
  if (!issued.has(grant) || (config.tenantOnly && grant.tenant === null)) {
    throw new Error("Store write refused: no write grant for this request");
  }
}

export function refuseNonTenant(res: Response): void {
  res.status(403).json({
    error: `Materios ${config.network} is open to its tenants only`,
    code: "tenant_required",
  });
}
