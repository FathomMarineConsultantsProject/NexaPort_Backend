import { pool } from "../config/db.js";

export const normalizeImo = (raw) => String(raw ?? "").replace(/^IMO\s*/i, "").replace(/\s/g, "").trim();
export const validImo = (imo) => /^\d{7}$/.test(imo) &&
  imo.slice(0, 6).split("").reduce((sum, digit, i) => sum + Number(digit) * (7 - i), 0) % 10 === Number(imo[6]);
const invalid = (field, message) => Object.assign(new Error(message), { status: 400, fieldErrors: { [field]: message } });
const clean = (value) => String(value ?? "").trim();

export async function listRequestVesselSuggestions(search, user, db = pool) {
  const term = clean(search).slice(0, 80);
  if (term.length < 2) return [];
  const pattern = term.replace(/^IMO\s*/i, "").replace(/[\\%_]/g, "\\$&");
  const result = await db.query(`
    SELECT source, id, public_id, name, imo, vessel_type, flag, mmsi, call_sign FROM (
      SELECT 'imported'::text AS source,d.id::text AS id,d.public_id,d.name,d.imo,d.vessel_type,d.flag,d.mmsi,d.call_sign
        FROM magicport_vessel_directory d
        WHERE d.name ILIKE $1 || '%' OR d.imo LIKE $1 || '%' OR d.mmsi LIKE $1 || '%' OR d.call_sign ILIKE $1 || '%'
      UNION ALL
      SELECT CASE WHEN cd.vessel_id IS NULL THEN 'managed' ELSE 'client_submitted' END::text,
        v.id::text,v.public_id,v.vessel_name,v.imo_number,v.vessel_type,v.flag_state,NULL::text,NULL::text
        FROM vessels v LEFT JOIN client_submitted_vessel_directory cd ON cd.vessel_id=v.id
        WHERE v.is_active=TRUE AND NOT EXISTS (SELECT 1 FROM magicport_vessel_directory d WHERE d.master_vessel_id=v.id OR (v.imo_number IS NOT NULL AND d.imo=v.imo_number))
          AND ($3=1 OR EXISTS (SELECT 1 FROM client_vessel_associations cva WHERE cva.vessel_id=v.id AND cva.client_user_id=$2))
          AND (v.vessel_name ILIKE $1 || '%' OR v.imo_number LIKE $1 || '%')
    ) matches ORDER BY name,imo NULLS LAST LIMIT 12`, [pattern, user.id, Number(user.role_id)]);
  return result.rows;
}

const existingByImo = async (db, imo) => (await db.query(
  `SELECT * FROM vessels WHERE regexp_replace(imo_number,'[^0-9]','','g')=$1 AND is_active=TRUE LIMIT 1 FOR UPDATE`, [imo]
)).rows[0] || null;

export async function resolveRequestVessel(db, body, clientUserId) {
  const enteredImo = normalizeImo(body.imoNumber);
  if (enteredImo && !validImo(enteredImo)) throw invalid("imoNumber", "Enter a valid seven-digit IMO number.");
  const enteredName = clean(body.vesselName);
  if (!enteredName && !enteredImo && !body.selectedVessel) return null;

  let imported = null;
  if (body.selectedVessel?.source === "imported") {
    const id = Number(body.selectedVessel.id);
    if (!Number.isSafeInteger(id) || id <= 0) throw invalid("vesselName", "Select a valid vessel.");
    imported = (await db.query("SELECT * FROM magicport_vessel_directory WHERE id=$1 FOR UPDATE", [id])).rows[0];
    if (!imported) throw invalid("vesselName", "The selected vessel is unavailable.");
    if (enteredImo && imported.imo !== enteredImo) throw invalid("imoNumber", "The IMO does not match the selected vessel.");
  } else if (["client_submitted", "managed"].includes(body.selectedVessel?.source)) {
    const id = Number(body.selectedVessel.id);
    if (!Number.isSafeInteger(id) || id <= 0) throw invalid("vesselName", "Select a valid vessel.");
    const selected = (await db.query(`SELECT v.* FROM vessels v
      JOIN client_vessel_associations cva ON cva.vessel_id=v.id AND cva.client_user_id=$2
      WHERE v.id=$1 AND v.is_active=TRUE FOR UPDATE OF v`, [id, clientUserId])).rows[0];
    if (!selected) throw invalid("vesselName", "The selected vessel is unavailable.");
    if (enteredImo && normalizeImo(selected.imo_number) !== enteredImo) throw invalid("imoNumber", "The IMO does not match the selected vessel.");
    return { id, name: selected.vessel_name, imo: selected.imo_number, type: selected.vessel_type, flag: selected.flag_state };
  } else if (body.selectedVessel) {
    throw invalid("vesselName", "Select a valid vessel.");
  }

  if (!imported && enteredImo) imported = (await db.query(
    "SELECT * FROM magicport_vessel_directory WHERE imo=$1 FOR UPDATE", [enteredImo]
  )).rows[0] || null;
  const imo = imported?.imo || enteredImo || null;
  let vessel = imo ? await existingByImo(db, imo) : null;
  let createdHere = false;
  if (!vessel) {
    const name = imported?.name || enteredName || `IMO ${imo}`;
    const type = imported?.vessel_type || clean(body.vesselType) || "Not provided";
    const flag = imported?.flag || clean(body.flagState) || "Not provided";
    const inserted = await db.query(`INSERT INTO vessels
      (vessel_name,imo_number,vessel_type,flag_state,created_by_user_id,public_id)
      VALUES($1,$2,$3,$4,$5,'MVS-'||upper(replace(gen_random_uuid()::text,'-',''))) ON CONFLICT DO NOTHING RETURNING *`, [name, imo, type, flag, clientUserId]);
    createdHere = Boolean(inserted.rows[0]);
    vessel = inserted.rows[0] || (imo ? await existingByImo(db, imo) : null);
    if (!vessel) throw Object.assign(new Error("A conflicting inactive vessel record requires Admin review."), { status: 409 });
  }
  // Recheck after ON CONFLICT: another client may have inserted this IMO while
  // this transaction was waiting on the unique index.
  if (!createdHere && !imported && Number(vessel.created_by_user_id) !== Number(clientUserId)) {
    const own = await db.query("SELECT 1 FROM client_vessel_associations WHERE client_user_id=$1 AND vessel_id=$2", [clientUserId, vessel.id]);
    if (!own.rowCount) throw Object.assign(new Error("This vessel identity is already registered. Contact Admin to link it to your fleet."), { status: 403 });
  }
  if (imported) {
    if (imported.master_vessel_id && Number(imported.master_vessel_id) !== Number(vessel.id))
      throw Object.assign(new Error("Directory vessel identity conflicts with an existing link."), { status: 409 });
    await db.query("UPDATE magicport_vessel_directory SET master_vessel_id=$1 WHERE id=$2 AND master_vessel_id IS NULL", [vessel.id, imported.id]);
  } else {
    await db.query(`INSERT INTO client_submitted_vessel_directory(vessel_id,submitted_by_user_id)
      VALUES($1,$2) ON CONFLICT(vessel_id) DO NOTHING`, [vessel.id, clientUserId]);
  }
  await db.query(`INSERT INTO client_vessel_associations(client_user_id,vessel_id) VALUES($1,$2)
    ON CONFLICT(client_user_id,vessel_id) DO NOTHING`, [clientUserId, vessel.id]);
  return { id: vessel.id, name: imported?.name || vessel.vessel_name,
    imo: imported?.imo || vessel.imo_number, type: imported?.vessel_type || vessel.vessel_type,
    flag: imported?.flag || vessel.flag_state };
}
