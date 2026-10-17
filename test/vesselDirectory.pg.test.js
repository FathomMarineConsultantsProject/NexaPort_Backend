import test from "node:test";
import assert from "node:assert/strict";
import pg from "pg";
import { listVesselDirectory } from "../src/services/vesselDirectoryService.js";

test("real PostgreSQL directory pagination over 99,000 imported rows", { skip: !process.env.TEST_DATABASE_URL }, async () => {
  const client = new pg.Client({ connectionString: process.env.TEST_DATABASE_URL, connectionTimeoutMillis: 5000, statement_timeout: 30000 });
  await client.connect();
  try {
    await client.query("BEGIN");
    await client.query(`CREATE TEMP TABLE magicport_vessel_directory (
      id bigint PRIMARY KEY, public_id text, name text, imo text, mmsi text, call_sign text,
      vessel_type text, subtype text, flag text, class_label text, dwt numeric, gt numeric,
      year_built integer, keel_year integer, loa numeric, navigation_status text,
      destination_text text, destination_port_id integer, speed_knots numeric,
      course_degrees numeric, heading_degrees numeric, observed_at timestamptz,
      source_url text, source_key text, master_vessel_id integer)`);
    await client.query(`CREATE TEMP TABLE magicport_vessel_management (
      directory_id bigint, ordinal integer, role text, name text, source_url text, entity_id uuid)`);
    await client.query(`CREATE TEMP TABLE vessels (
      id integer, public_id text, vessel_name text, imo_number text, vessel_type text,
      flag_state text, dwt numeric, gt numeric, year_built integer, is_active boolean)`);
    await client.query("CREATE TEMP TABLE client_submitted_vessel_directory (vessel_id integer)");
    await client.query(`INSERT INTO magicport_vessel_directory (id,public_id,name,imo,flag,vessel_type,dwt,gt)
      SELECT n,'VSL-'||LPAD(n::text,32,'0'),'Vessel '||LPAD(n::text,6,'0'),
        LPAD(n::text,7,'0'),'Panama','Tanker',n,n*2 FROM generate_series(1,99000) n`);
    await client.query("INSERT INTO magicport_vessel_management VALUES (1,1,'Manager','Example',NULL,NULL)");
    await client.query("INSERT INTO vessels VALUES (100001,'MVS-TEST','A Client Vessel','9999999','Cargo','India',1,2,2020,true)");
    await client.query("INSERT INTO client_submitted_vessel_directory VALUES (100001)");
    const timings = [];
    const first = await listVesselDirectory({ page: 1, limit: 30 }, client, (stage, ms) => timings.push([stage, ms]));
    assert.equal(first.vessels.length, 30);
    assert.equal(first.pagination.total, 99001);
    assert.equal(first.vessels[0].id, "client-100001");
    const searched = await listVesselDirectory({ search: "0000001", limit: 30 }, client);
    assert.equal(searched.pagination.total, 1);
    assert.equal(searched.vessels[0].imo, "0000001");
    const filtered = await listVesselDirectory({ flag: "India", type: "Cargo", dwtMin: 1, gtMax: 2 }, client);
    assert.equal(filtered.pagination.total, 1);
    assert.equal(filtered.vessels[0].id, "client-100001");
    assert.ok(timings.some(([stage]) => stage === "page_query"));
    assert.ok(timings.some(([stage]) => stage === "count_query"));
    console.info(JSON.stringify({ test: "vessel_directory_pg", timings }));
  } finally {
    await client.query("ROLLBACK").catch(() => {});
    await client.end();
  }
});
