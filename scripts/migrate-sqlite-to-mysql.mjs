import fs from "node:fs";
import path from "node:path";
import process from "node:process";
import mysql from "mysql2/promise";
import initSqlJs from "sql.js";

function mustEnv(name) {
  const v = (process.env[name] ?? "").trim();
  if (!v) throw new Error(`Missing env: ${name}`);
  return v;
}

function optEnv(name, fallback) {
  const v = (process.env[name] ?? "").trim();
  return v ? v : fallback;
}

function quoteIdentMySql(name) {
  return `\`${String(name).replace(/`/g, "``")}\``;
}

function quoteIdentSqlite(name) {
  return `"${String(name).replace(/"/g, '""')}"`;
}

function chunk(arr, size) {
  const out = [];
  for (let i = 0; i < arr.length; i += size) out.push(arr.slice(i, i + size));
  return out;
}

function normalizeCell(v) {
  // sql.js might yield Uint8Array for blobs
  if (v instanceof Uint8Array) return Buffer.from(v);
  return v;
}

function toMysqlDateTimeString(ms) {
  const d = new Date(ms);
  if (Number.isNaN(d.getTime())) return null;
  // MySQL DATETIME: "YYYY-MM-DD HH:mm:ss"
  return d.toISOString().slice(0, 19).replace("T", " ");
}

function toMysqlDateString(ms) {
  const d = new Date(ms);
  if (Number.isNaN(d.getTime())) return null;
  return d.toISOString().slice(0, 10);
}

function isLikelyEpochMs(n) {
  // 13-digit ms timestamps (after ~2001) are > 1e12
  return typeof n === "number" && Number.isFinite(n) && Math.abs(n) >= 1e12;
}

function isLikelyEpochSeconds(n) {
  return typeof n === "number" && Number.isFinite(n) && Math.abs(n) >= 1e9 && Math.abs(n) < 1e12;
}

function dedupeCaseInsensitive(values, makeKey, rewrite) {
  const seen = new Map();
  for (let i = 0; i < values.length; i++) {
    const k = makeKey(values[i]);
    if (k == null) continue;
    const key = String(k).toLowerCase();
    const n = (seen.get(key) ?? 0) + 1;
    seen.set(key, n);
    if (n > 1) rewrite(values[i], n);
  }
}

async function main() {
  const sqliteFile = optEnv(
    "SQLITE_FILE",
    path.join(process.cwd(), "prisma", "dev.db"),
  );
  const mysqlUrl = optEnv("MYSQL_DATABASE_URL", process.env.DATABASE_URL ?? "");
  if (!mysqlUrl) {
    throw new Error(
      "Missing env: MYSQL_DATABASE_URL (or DATABASE_URL) for MySQL connection",
    );
  }

  if (!fs.existsSync(sqliteFile)) {
    throw new Error(`SQLite file not found: ${sqliteFile}`);
  }

  console.log(`[1/4] Load SQLite db: ${sqliteFile}`);
  const SQL = await initSqlJs();
  const sqliteBytes = fs.readFileSync(sqliteFile);
  const sqliteDb = new SQL.Database(new Uint8Array(sqliteBytes));

  console.log(`[2/4] Connect MySQL`);
  const mysqlConn = await mysql.createConnection(mysqlUrl);
  await mysqlConn.query("SET FOREIGN_KEY_CHECKS=0");

  console.log(`[3/4] Enumerate SQLite tables`);
  const tblRes = sqliteDb.exec(
    `SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%'`,
  );
  const tables = (tblRes[0]?.values ?? [])
    .map((row) => String(row[0]))
    .filter((n) => n !== "_prisma_migrations");

  console.log(`Found ${tables.length} tables: ${tables.join(", ")}`);

  // Clean target tables first (best-effort). With FK checks off this is safe.
  for (const t of tables) {
    const qt = quoteIdentMySql(t);
    try {
      await mysqlConn.query(`TRUNCATE TABLE ${qt}`);
    } catch {
      try {
        await mysqlConn.query(`DELETE FROM ${qt}`);
      } catch {
        // ignore
      }
    }
  }

  for (const t of tables) {
    const qtMy = quoteIdentMySql(t);
    const qtSq = quoteIdentSqlite(t);

    const colInfo = sqliteDb.exec(`PRAGMA table_info(${qtSq})`);
    const cols = (colInfo[0]?.values ?? []).map((r) => String(r[1]));
    if (cols.length === 0) continue;

    // Query MySQL column types to normalize datetime/date values
    const [colRows] = await mysqlConn.query(
      `SELECT COLUMN_NAME as name, DATA_TYPE as dataType
       FROM information_schema.columns
       WHERE table_schema = DATABASE() AND table_name = ?`,
      [t],
    );
    const typeByCol = new Map(
      (colRows ?? []).map((r) => [
        String(r.name),
        String(r.dataType).toLowerCase(),
      ]),
    );

    // Load all rows via prepared statement to avoid huge intermediate JSON.
    const stmt = sqliteDb.prepare(`SELECT * FROM ${qtSq}`);
    const rows = [];
    while (stmt.step()) {
      const obj = stmt.getAsObject();
      const row = cols.map((c) => {
        const raw = normalizeCell(obj[c]);
        const tpe = typeByCol.get(c);
        if (raw === null || raw === undefined) return raw;
        if (!tpe) return raw;
        if (tpe === "datetime" || tpe === "timestamp" || tpe === "date") {
          // In SQLite dev.db we stored JS ms timestamps for DateTime fields
          if (typeof raw === "number") {
            const ms = isLikelyEpochSeconds(raw) ? raw * 1000 : raw;
            if (isLikelyEpochMs(ms)) {
              return tpe === "date" ? toMysqlDateString(ms) : toMysqlDateTimeString(ms);
            }
          }
          // If it already looks like a date string, leave as-is
          return raw;
        }
        return raw;
      });
      rows.push(row);
    }
    stmt.free();

    if (rows.length === 0) {
      console.log(`- ${t}: 0 rows`);
      continue;
    }

    // MySQL default collation is often case-insensitive. For unique keys (e.g. TestCase.caseNo),
    // values that differ only by case will collide. We rewrite duplicates deterministically.
    if (t === "TestCase") {
      const idxCaseNo = cols.indexOf("caseNo");
      const idxId = cols.indexOf("id");
      if (idxCaseNo >= 0) {
        dedupeCaseInsensitive(
          rows,
          (r) => r[idxCaseNo],
          (r, n) => {
            const base = String(r[idxCaseNo] ?? "").trim();
            const suffix =
              idxId >= 0 && r[idxId] ? String(r[idxId]).slice(-6) : String(n);
            r[idxCaseNo] = `${base}_${suffix}`;
          },
        );
      }
    }

    const colList = cols.map(quoteIdentMySql).join(", ");
    const insertSql = `INSERT INTO ${qtMy} (${colList}) VALUES ?`;

    const batches = chunk(rows, 500);
    for (let i = 0; i < batches.length; i++) {
      await mysqlConn.query(insertSql, [batches[i]]);
    }
    console.log(`- ${t}: ${rows.length} rows`);
  }

  await mysqlConn.query("SET FOREIGN_KEY_CHECKS=1");
  await mysqlConn.end();
  sqliteDb.close();

  console.log(`[4/4] Done`);
  console.log(
    `Tip: run Prisma against MySQL now (e.g. npm run db:push if needed).`,
  );
}

main().catch((e) => {
  console.error(e);
  process.exitCode = 1;
});

