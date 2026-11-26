// EVE SSO and ESI code for the desktop app (main.js). Runs in Node only; tokens handled here never reach the page.
// EVE Miner signs in with the same EVE application as EVE Hub Trader: same callback (http://localhost:8765/callback)
// and the same scopes, so one client ID from developers.eveonline.com works for both apps.
const crypto = require("crypto");

const SCOPES = "esi-skills.read_skills.v1 esi-wallet.read_character_wallet.v1 esi-location.read_ship_type.v1 esi-location.read_location.v1 esi-ui.write_waypoint.v1 esi-assets.read_assets.v1 esi-location.read_online.v1";
const AUTH_URL = "https://login.eveonline.com/v2/oauth/authorize/";
const TOKEN_URL = "https://login.eveonline.com/v2/oauth/token";
const ESI = "https://esi.evetech.net/latest";
const CLIENT_ID_RE = /^[A-Za-z0-9-]{8,64}$/;
// The one EVE developer application every copy signs in through, whichever EVE account or character signs in
// (callback http://localhost:8765/callback, the SCOPES below). A client ID is public (PKCE, no secret).
const CLIENT_ID = "035198d41c984a4d85544fccfe69963c";

const b64u = b => b.toString("base64").replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");

// A fresh PKCE verifier/challenge pair and a state value for one login attempt.
function pkce() {
  const verifier = b64u(crypto.randomBytes(32));
  return { verifier, challenge: b64u(crypto.createHash("sha256").update(verifier).digest()), state: b64u(crypto.randomBytes(16)) };
}

function authorizeUrl({ clientId, redirect, challenge, state }) {
  return AUTH_URL + "?" + new URLSearchParams({
    response_type: "code", redirect_uri: redirect, client_id: clientId, scope: SCOPES,
    code_challenge: challenge, code_challenge_method: "S256", state
  });
}

async function tokenRequest(params, ua) {
  const r = await fetch(TOKEN_URL, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded", "User-Agent": ua },
    body: new URLSearchParams(params)
  });
  const j = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(j.error_description || j.error || `EVE login failed (HTTP ${r.status}).`);
  return j;
}

// The token comes straight from EVE's token endpoint over TLS, so the claims are read without checking the
// signature. They are still checked for issuer, audience and character.
function readClaims(jwt, clientId) {
  const c = JSON.parse(Buffer.from(jwt.split(".")[1], "base64url").toString("utf8"));
  if (!/^(https:\/\/)?login\.eveonline\.com\/?$/.test(String(c.iss || ""))) throw new Error("The login response came from an unexpected issuer.");
  if (![].concat(c.aud || []).includes(clientId)) throw new Error("The login response was issued for a different application.");
  const id = Number(String(c.sub || "").split(":")[2]);
  if (!id) throw new Error("The login response did not include a character.");
  return { characterId: id, characterName: c.name };
}

function sessionFrom(j, clientId) {
  return { clientId, accessToken: j.access_token, refreshToken: j.refresh_token, expiresAt: Date.now() + (j.expires_in - 30) * 1000, ...readClaims(j.access_token, clientId) };
}

const exchangeCode = async (clientId, code, verifier, ua) =>
  sessionFrom(await tokenRequest({ grant_type: "authorization_code", code, client_id: clientId, code_verifier: verifier }, ua), clientId);

// The session as is while its access token is valid, refreshed when it has expired, or null when EVE refuses.
async function freshen(sess, ua) {
  if (!sess) return null;
  if (sess.expiresAt > Date.now()) return sess;
  try { return sessionFrom(await tokenRequest({ grant_type: "refresh_token", refresh_token: sess.refreshToken, client_id: sess.clientId }, ua), sess.clientId); }
  catch (e) { return null; }
}

// Only these character endpoints can be read, and only for the signed-in character.
async function esiGet(sess, p, ua) {
  if (typeof p !== "string" || !new RegExp(`^/characters/${sess.characterId}/(wallet|ship|skills|location|online)/$`).test(p)) return { ok: false, status: 400 };
  const r = await fetch(`${ESI}${p}?datasource=tranquility`, { headers: { Authorization: `Bearer ${sess.accessToken}`, "User-Agent": ua } });
  const data = await r.json().catch(() => null);
  return { ok: r.ok, status: r.status, data };
}

// The ship the character is flying: its fitted modules (with loaded crystals), the mining drones in its drone bay and
// what is in its holds (ore hold, cargo). EVE has no call for one ship, so the whole asset list is read page by page
// and only items inside the current ship are kept; the rest of the inventory never reaches the page. EVE refreshes
// the asset list about once an hour, so a read is reused per character for at least SHIPFIT_MS.
const SHIPFIT_MS = 5 * 60e3, SHIPFIT_PAGES = 100;
const FIT_FLAG = /^(HiSlot[0-7]|MedSlot[0-7]|LoSlot[0-7]|RigSlot[0-2]|SubSystemSlot[0-3])$/;
const HOLD_FLAG = /^(Cargo|DroneBay|SpecializedOreHold|GeneralMiningHold|SpecializedMineralHold|SpecializedIceHold|SpecializedAsteroidHold|SpecializedGasHold)$/;
const cache = new Map(); // character id -> { at, next, byShip }
async function shipFit(sess, ua, now = Date.now()) {
  const H = { headers: { Authorization: `Bearer ${sess.accessToken}`, "User-Agent": ua } }, cid = sess.characterId;
  const sh = await fetch(`${ESI}/characters/${cid}/ship/?datasource=tranquility`, H);
  if (!sh.ok) return { ok: false, status: sh.status };
  const ship = await sh.json();
  let c = cache.get(cid);
  const reused = !!(c && now < c.next);
  if (!reused) {
    const byShip = new Map(), modAt = new Map(), inMod = []; let pages = 1, exp = 0, mod = 0;
    for (let p = 1; p <= pages && p <= SHIPFIT_PAGES; p++) {
      const r = await fetch(`${ESI}/characters/${cid}/assets/?datasource=tranquility&page=${p}`, H);
      if (!r.ok) return { ok: false, status: r.status };
      pages = +r.headers.get("x-pages") || 1;
      exp = Math.max(exp, Date.parse(r.headers.get("expires") || "") || 0);
      mod = Math.max(mod, Date.parse(r.headers.get("last-modified") || "") || 0);
      for (const x of await r.json()) {
        if (FIT_FLAG.test(x.location_flag) || HOLD_FLAG.test(x.location_flag)) {
          if (!byShip.has(x.location_id)) byShip.set(x.location_id, []);
          byShip.get(x.location_id).push({ type: x.type_id, flag: x.location_flag, qty: x.quantity });
          if (FIT_FLAG.test(x.location_flag)) modAt.set(x.item_id, [x.location_id, x.location_flag]);
        } else if (x.location_id >= 1e12 || x.location_type === "item") inMod.push(x);
      }
    }
    for (const x of inMod) { // crystals EVE files inside their module
      const at = modAt.get(x.location_id); if (at) byShip.get(at[0]).push({ type: x.type_id, flag: at[1], qty: x.quantity });
    }
    c = { at: now, next: Math.max(now + SHIPFIT_MS, exp), mod: mod || now, byShip };
    if (cache.size > 100) cache.clear();
    cache.set(cid, c);
  }
  const items = c.byShip.get(ship.ship_item_id) || [];
  return { ok: true, status: 200, data: {
    shipTypeId: ship.ship_type_id, shipName: ship.ship_name,
    items: items.filter(x => FIT_FLAG.test(x.flag)), holds: items.filter(x => HOLD_FLAG.test(x.flag)),
    asOf: c.mod, readAt: c.at, next: c.at + SHIPFIT_MS, reused } };
}

const isNpcStation = id => Number.isInteger(id) && id >= 60000000 && id < 64000000;
const isSystem = id => Number.isInteger(id) && id >= 30000000 && id < 31000000;

// Sets the in-game autopilot route to up to 20 NPC stations or known-space systems, in order. It never moves the ship.
async function setWaypoints(sess, list, ua) {
  if (!Array.isArray(list) || !list.length || list.length > 20 || !list.every(id => isNpcStation(id) || isSystem(id))) return { ok: false, status: 400 };
  for (const [i, id] of list.entries()) {
    const q = new URLSearchParams({ add_to_beginning: "false", clear_other_waypoints: i === 0 ? "true" : "false", destination_id: String(id), datasource: "tranquility" });
    const r = await fetch(`${ESI}/ui/autopilot/waypoint/?${q}`, { method: "POST", headers: { Authorization: `Bearer ${sess.accessToken}`, "User-Agent": ua } });
    if (!r.ok) return { ok: false, status: r.status };
  }
  return { ok: true, status: 204 };
}

module.exports = { SCOPES, TOKEN_URL, CLIENT_ID, CLIENT_ID_RE, b64u, pkce, authorizeUrl, tokenRequest, readClaims, sessionFrom, exchangeCode, freshen, esiGet, shipFit, SHIPFIT_MS, setWaypoints, isNpcStation, isSystem };
