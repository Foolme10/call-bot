'use strict';

// ───────────────────────────────────────────────────────────────────────────
// SMS usage report (CLI, backend tool).
//
//   npm run sms-usage -- [options]
//
// Totals up SMS credits consumed (from the stored delivery reports) so you can
// see usage without opening the app. By default it reports ALL sent SMS,
// all-time. Options narrow it down:
//
//   --from YYYY-MM-DD     only messages sent on/after this date
//   --to   YYYY-MM-DD     only messages sent on/before this date (inclusive)
//   --campaign <id>       only this campaign
//   --user <username>     only campaigns owned by this user
//   --by-campaign         also print a per-campaign breakdown
//   --refresh             first pull credits from the gateway for any sent
//                         messages that don't have a delivery report yet
//
// Examples:
//   npm run sms-usage
//   npm run sms-usage -- --from 2026-08-01 --to 2026-08-31
//   npm run sms-usage -- --user acme --by-campaign
//   npm run sms-usage -- --refresh
// ───────────────────────────────────────────────────────────────────────────

const config = require('../src/config');
const db = require('../src/db');
const smsProvider = require('../src/services/smsProvider');

// Tiny arg parser: "--key value" for known value-flags, "--flag" for booleans.
function parseArgs(argv) {
  const valueKeys = new Set(['from', 'to', 'campaign', 'user']);
  const out = {};
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i];
    if (!a.startsWith('--')) continue;
    const key = a.slice(2);
    if (valueKeys.has(key)) {
      out[key] = argv[i + 1];
      i += 1;
    } else {
      out[key] = true;
    }
  }
  return out;
}

const int = (n) => Number(n).toLocaleString();

// Build the shared WHERE clause + params from the filters.
function buildFilter(args) {
  const where = ["cl.status = 'sent'", 'cl.provider_msgid IS NOT NULL'];
  const params = {};
  if (args.from) {
    where.push('cl.end_time >= :from');
    params.from = `${args.from} 00:00:00`;
  }
  if (args.to) {
    where.push('cl.end_time < DATE_ADD(:to, INTERVAL 1 DAY)');
    params.to = `${args.to} 00:00:00`;
  }
  if (args.campaign) {
    where.push('cl.campaign_id = :cid');
    params.cid = Number(args.campaign);
  }
  if (args.user) {
    where.push('c.user_id = (SELECT id FROM users WHERE username = :user)');
    params.user = args.user;
  }
  return { whereSql: where.join(' AND '), params };
}

// --refresh: fetch credits from the gateway for sent messages that still have
// no delivery report (dlr_credits NULL), and store them, so the totals below
// include everything the gateway can tell us right now.
async function refreshMissing(whereSql, params) {
  const rows = await db.query(
    `SELECT cl.provider_msgid AS msgid
       FROM call_logs cl JOIN campaigns c ON c.id = cl.campaign_id
      WHERE ${whereSql} AND cl.dlr_credits IS NULL`,
    params
  );
  if (rows.length === 0) {
    console.log('Refresh: nothing to fetch (all sent messages already have a report).');
    return;
  }
  const batch = config.sms.dlrBatch;
  let updated = 0;
  for (let i = 0; i < rows.length; i += batch) {
    const ids = rows.slice(i, i + batch).map((r) => r.msgid);
    const res = await smsProvider.fetchDlr(ids);
    if (!res.ok) {
      console.warn(`  batch ${i / batch + 1}: gateway error — ${res.detail}`);
      continue;
    }
    for (const m of res.messages) {
      await db.execute(
        `UPDATE call_logs
            SET dlr_status = :bucket, dlr_state = :state, dlr_detail = :detail,
                dlr_credits = :credits, dlr_updated_at = COALESCE(dlr_updated_at, UTC_TIMESTAMP())
          WHERE provider_msgid = :msgid`,
        { bucket: m.bucket, state: m.state, detail: m.detail, credits: m.credits, msgid: m.msgid }
      );
      updated += 1;
    }
  }
  console.log(`Refresh: pulled ${updated} of ${rows.length} unreported message(s) from the gateway.\n`);
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const { whereSql, params } = buildFilter(args);

  if (args.refresh) {
    if (!config.sms.authKey) {
      console.warn('--refresh ignored: SMS gateway not configured (SMS_AUTH_KEY missing).\n');
    } else {
      await refreshMissing(whereSql, params);
    }
  }

  const [t] = await db.query(
    `SELECT
        COUNT(*)                                            AS sent,
        COALESCE(SUM(cl.dlr_credits IS NOT NULL), 0)        AS reported,
        COALESCE(SUM(cl.dlr_credits), 0)                    AS credits,
        COALESCE(SUM(cl.dlr_status = 'delivered'), 0)       AS delivered,
        COALESCE(SUM(cl.dlr_status = 'failed'), 0)          AS failed,
        COALESCE(SUM(cl.dlr_status = 'pending' OR cl.dlr_status IS NULL), 0) AS pending
       FROM call_logs cl JOIN campaigns c ON c.id = cl.campaign_id
      WHERE ${whereSql}`,
    params
  );

  const sent = Number(t.sent);
  const reported = Number(t.reported);
  const credits = Number(t.credits);
  const pending = Number(t.pending);
  // Estimate the still-unreported credits from the average of what we do know.
  const avgPerMsg = reported > 0 ? credits / reported : 0;
  const estCredits = credits + Math.round(pending * avgPerMsg);

  const scope = [];
  if (args.campaign) scope.push(`campaign ${args.campaign}`);
  if (args.user) scope.push(`user ${args.user}`);
  if (args.from) scope.push(`from ${args.from}`);
  if (args.to) scope.push(`to ${args.to}`);

  console.log('════════════════════════════════════════════════');
  console.log('  SMS USAGE' + (scope.length ? `  (${scope.join(', ')})` : '  (all time, all campaigns)'));
  console.log('════════════════════════════════════════════════');
  console.log(`  Messages sent (accepted) : ${int(sent)}`);
  console.log(`    · delivered            : ${int(t.delivered)}`);
  console.log(`    · failed               : ${int(t.failed)}`);
  console.log(`    · pending report       : ${int(pending)}`);
  console.log('  ----------------------------------------------');
  console.log(`  Credits used (reported)  : ${int(credits)}`);
  if (pending > 0 && avgPerMsg > 0) {
    console.log(`  Est. incl. ${int(pending)} unreported : ~${int(estCredits)} credits`);
    console.log(`    (assuming ${avgPerMsg.toFixed(2)} credits/msg, the reported average)`);
  }
  console.log('════════════════════════════════════════════════');

  if (args['by-campaign']) {
    const rows = await db.query(
      `SELECT cl.campaign_id AS id, c.name, u.username AS owner,
              COUNT(*) AS sent,
              COALESCE(SUM(cl.dlr_credits), 0) AS credits
         FROM call_logs cl
         JOIN campaigns c ON c.id = cl.campaign_id
         LEFT JOIN users u ON u.id = c.user_id
        WHERE ${whereSql}
        GROUP BY cl.campaign_id, c.name, u.username
        ORDER BY credits DESC`,
      params
    );
    console.log('\n  Per campaign:');
    console.log('  ' + 'ID'.padEnd(7) + 'Sent'.padStart(8) + 'Credits'.padStart(10) + '  Name');
    for (const r of rows) {
      console.log(
        '  ' +
          String(r.id).padEnd(7) +
          int(r.sent).padStart(8) +
          int(r.credits).padStart(10) +
          `  ${r.name}${r.owner ? ` (${r.owner})` : ''}`
      );
    }
  }

  await db.pool.end();
}

main().catch((err) => {
  console.error('sms-usage failed:', err.message);
  process.exit(1);
});
