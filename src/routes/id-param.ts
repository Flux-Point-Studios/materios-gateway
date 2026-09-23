import type { Request, Response, NextFunction } from "express";
import { isHexId } from "../storage.js";

/**
 * Router param guard for ids that name files on disk: anything but a 32-byte
 * hex id is a 400 before a handler runs.
 */
export function requireHexId(name: string) {
  return (_req: Request, res: Response, next: NextFunction, value: string): void => {
    if (isHexId(value)) {
      next();
      return;
    }
    res.status(400).json({ error: `${name} must be a 32-byte hex id` });
  };
}
