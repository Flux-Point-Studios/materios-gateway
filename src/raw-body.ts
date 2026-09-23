/**
 * The exact body bytes of a request, kept for signatures that cover them.
 */

import type { IncomingMessage, ServerResponse } from "http";

const EMPTY = Buffer.alloc(0);
const rawBodies = new WeakMap<IncomingMessage, Buffer>();

/** body-parser `verify` hook: sees the received bytes before they are parsed. */
export function captureRawBody(req: IncomingMessage, _res: ServerResponse, buf: Buffer): void {
  rawBodies.set(req, buf);
}

/**
 * A body no parser read — none was sent, or its content type matched no
 * parser — is empty here, as it is to the route handler.
 */
export function rawBodyOf(req: IncomingMessage): Buffer {
  return rawBodies.get(req) ?? EMPTY;
}
