import { randomBytes, scrypt, timingSafeEqual } from "node:crypto";
import { promisify } from "node:util";

/**
 * Password hashing with scrypt (built into Node — no native module to compile
 * on the server). Stored format:  scrypt$N$r$p$saltB64$hashB64
 * The parameters live in the hash so they can be raised later; `needsRehash`
 * tells the login flow to upgrade old hashes transparently.
 */
const scryptAsync = promisify(scrypt);

const PARAMS = { N: 2 ** 15, r: 8, p: 1 };
const KEY_LEN = 64;
const SALT_LEN = 16;
const maxmemFor = (N, r) => 256 * N * r; // comfortably above the 128*N*r scrypt needs

export async function hashPassword(password, params = PARAMS) {
  const salt = randomBytes(SALT_LEN);
  const dk = await scryptAsync(password, salt, KEY_LEN, { N: params.N, r: params.r, p: params.p, maxmem: maxmemFor(params.N, params.r) });
  return ["scrypt", params.N, params.r, params.p, salt.toString("base64"), dk.toString("base64")].join("$");
}

function parse(stored) {
  if (typeof stored !== "string") return null;
  const parts = stored.split("$");
  if (parts.length !== 6 || parts[0] !== "scrypt") return null;
  const [, N, r, p, salt, hash] = parts;
  const parsed = { N: Number(N), r: Number(r), p: Number(p), salt: Buffer.from(salt, "base64"), hash: Buffer.from(hash, "base64") };
  if (![parsed.N, parsed.r, parsed.p].every(Number.isInteger) || parsed.hash.length === 0) return null;
  return parsed;
}

export async function verifyPassword(password, stored) {
  const parsed = parse(stored);
  if (!parsed || typeof password !== "string") return false;
  const dk = await scryptAsync(password, parsed.salt, parsed.hash.length, { N: parsed.N, r: parsed.r, p: parsed.p, maxmem: maxmemFor(parsed.N, parsed.r) });
  return dk.length === parsed.hash.length && timingSafeEqual(dk, parsed.hash);
}

export function needsRehash(stored) {
  const parsed = parse(stored);
  return !parsed || parsed.N < PARAMS.N || parsed.r < PARAMS.r || parsed.p < PARAMS.p;
}

let dummy;
/** A real hash to compare against when the account doesn't exist, so "unknown user" and "wrong password" cost the same. */
export async function dummyHash() {
  dummy ??= await hashPassword("vyra-dummy-password-for-timing");
  return dummy;
}

export const createPasswordHasher = () => ({ hash: hashPassword, verify: verifyPassword, needsRehash, dummyHash });
