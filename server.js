'use strict';

const path = require('path');
const express = require('express');
const { Pool } = require('pg');

const app = express();
const PORT = process.env.PORT || 3000;
const ADMIN_TOKEN = process.env.ADMIN_TOKEN || '';
const MAX_CLAIMS = 2; // a god shows as Taken once this many people have claimed it

app.use(express.json({ limit: '32kb' }));
app.set('trust proxy', 1);

/* ---------- storage ---------- */

const connectionString = process.env.DATABASE_URL || '';
const pool = connectionString
  ? new Pool({
      connectionString,
      // Railway's private network (*.railway.internal) does not use TLS.
      // The public proxy (*.rlwy.net) does, with a self-signed chain.
      ssl: connectionString.includes('railway.internal')
        ? false
        : { rejectUnauthorized: false },
      max: 5,
    })
  : null;

// Fallback so the site still works locally without a database. slug -> [records]
const memory = new Map();

async function initDb() {
  if (!pool) {
    console.warn('[claims] No DATABASE_URL set — claims are in memory and will be lost on restart.');
    return;
  }

  await pool.query(`
    CREATE TABLE IF NOT EXISTS claims (
      id         SERIAL PRIMARY KEY,
      god_slug   TEXT NOT NULL,
      god_name   TEXT NOT NULL,
      claimed_by TEXT NOT NULL,
      slot       SMALLINT,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );
  `);

  // Migrate a database created by the earlier one-claim-per-god schema.
  await pool.query('ALTER TABLE claims ADD COLUMN IF NOT EXISTS slot SMALLINT;');
  await pool.query('UPDATE claims SET slot = 1 WHERE slot IS NULL;');
  await pool.query('ALTER TABLE claims DROP CONSTRAINT IF EXISTS claims_god_slug_key;');
  await pool.query(
    'CREATE UNIQUE INDEX IF NOT EXISTS claims_god_slug_slot_idx ON claims (god_slug, slot);'
  );
  await pool.query(
    'CREATE UNIQUE INDEX IF NOT EXISTS claims_god_slug_person_idx ON claims (god_slug, lower(claimed_by));'
  );

  console.log('[claims] Database ready. Places per god: ' + MAX_CLAIMS);
}

/* ---------- helpers ---------- */

const SLUG_RE = /^[a-z0-9-]{1,64}$/;

function cleanName(value) {
  if (typeof value !== 'string') return '';
  return value.replace(/\s+/g, ' ').trim().slice(0, 60);
}

function listNames(records) {
  return records.map((record) => record.claimed_by);
}

function joinNames(names) {
  if (!names.length) return 'someone else';
  if (names.length === 1) return names[0];
  return names.slice(0, -1).join(', ') + ' and ' + names[names.length - 1];
}

/* ---------- api ---------- */

app.get('/api/health', async (_req, res) => {
  try {
    if (pool) await pool.query('SELECT 1');
    res.json({ ok: true, storage: pool ? 'postgres' : 'memory', places: MAX_CLAIMS });
  } catch (err) {
    res.status(500).json({ ok: false, error: 'Database unreachable' });
  }
});

app.get('/api/claims', async (_req, res) => {
  try {
    if (!pool) {
      const flat = [];
      memory.forEach((records) => records.forEach((record) => flat.push(record)));
      return res.json({ claims: flat, places: MAX_CLAIMS });
    }
    const { rows } = await pool.query(
      `SELECT god_slug, god_name, claimed_by, slot, created_at
       FROM claims
       ORDER BY god_slug ASC, slot ASC`
    );
    res.json({ claims: rows, places: MAX_CLAIMS });
  } catch (err) {
    console.error('[claims] list failed', err);
    res.status(500).json({ error: 'Could not load claims right now.' });
  }
});

app.post('/api/claims', async (req, res) => {
  const godSlug = typeof req.body.god_slug === 'string' ? req.body.god_slug.trim() : '';
  const godName = cleanName(req.body.god_name);
  const claimedBy = cleanName(req.body.claimed_by);

  if (!SLUG_RE.test(godSlug) || !godName) {
    return res.status(400).json({ error: 'Unknown god.' });
  }
  if (claimedBy.length < 2) {
    return res.status(400).json({ error: 'Enter your name to claim.' });
  }

  try {
    if (!pool) {
      const existing = memory.get(godSlug) || [];
      if (existing.some((r) => r.claimed_by.toLowerCase() === claimedBy.toLowerCase())) {
        return res.status(409).json({
          error: 'You have already claimed ' + godName + '.',
          claimed_by_all: listNames(existing),
        });
      }
      if (existing.length >= MAX_CLAIMS) {
        return res.status(409).json({
          error: 'Taken by ' + joinNames(listNames(existing)) + '.',
          claimed_by_all: listNames(existing),
        });
      }
      const record = {
        god_slug: godSlug,
        god_name: godName,
        claimed_by: claimedBy,
        slot: existing.length + 1,
        created_at: new Date().toISOString(),
      };
      memory.set(godSlug, existing.concat([record]));
      return res
        .status(201)
        .json({ claim: record, claimed_by_all: listNames(memory.get(godSlug)) });
    }

    // Take the lowest free place. If two people race for the same one, the unique
    // index rejects one of them and the loop retries against the next free place.
    let inserted = null;
    for (let attempt = 0; attempt <= MAX_CLAIMS && !inserted; attempt++) {
      const { rows } = await pool.query(
        `INSERT INTO claims (god_slug, god_name, claimed_by, slot)
         SELECT $1, $2, $3, s.slot
         FROM generate_series(1, $4) AS s(slot)
         WHERE NOT EXISTS (
           SELECT 1 FROM claims c WHERE c.god_slug = $1 AND c.slot = s.slot
         )
         ORDER BY s.slot
         LIMIT 1
         ON CONFLICT DO NOTHING
         RETURNING god_slug, god_name, claimed_by, slot, created_at`,
        [godSlug, godName, claimedBy, MAX_CLAIMS]
      );
      if (rows.length) inserted = rows[0];
    }

    const current = await pool.query(
      'SELECT claimed_by FROM claims WHERE god_slug = $1 ORDER BY slot ASC',
      [godSlug]
    );
    const names = listNames(current.rows);

    if (!inserted) {
      const mine = names.some((n) => n.toLowerCase() === claimedBy.toLowerCase());
      return res.status(409).json({
        error: mine
          ? 'You have already claimed ' + godName + '.'
          : 'Taken by ' + joinNames(names) + '.',
        claimed_by_all: names,
      });
    }

    res.status(201).json({ claim: inserted, claimed_by_all: names });
  } catch (err) {
    // Unique violation on (god_slug, lower(claimed_by)) — same person, same god.
    if (err && err.code === '23505') {
      return res.status(409).json({ error: 'You have already claimed ' + godName + '.' });
    }
    console.error('[claims] insert failed', err);
    res.status(500).json({ error: 'Could not save that claim. Try again.' });
  }
});

// Release claims on a god — for fixing mistakes. Requires ADMIN_TOKEN to be set.
// Add ?name=Someone to release only that person's place.
app.delete('/api/claims/:slug', async (req, res) => {
  if (!ADMIN_TOKEN || req.get('x-admin-token') !== ADMIN_TOKEN) {
    return res.status(403).json({ error: 'Not allowed.' });
  }
  const slug = req.params.slug;
  const who = cleanName(req.query.name || '');
  if (!SLUG_RE.test(slug)) return res.status(400).json({ error: 'Unknown god.' });

  try {
    if (!pool) {
      if (who) {
        memory.set(
          slug,
          (memory.get(slug) || []).filter((r) => r.claimed_by.toLowerCase() !== who.toLowerCase())
        );
      } else {
        memory.delete(slug);
      }
      return res.json({ released: slug, name: who || null });
    }
    if (who) {
      await pool.query(
        'DELETE FROM claims WHERE god_slug = $1 AND lower(claimed_by) = lower($2)',
        [slug, who]
      );
    } else {
      await pool.query('DELETE FROM claims WHERE god_slug = $1', [slug]);
    }
    res.json({ released: slug, name: who || null });
  } catch (err) {
    console.error('[claims] delete failed', err);
    res.status(500).json({ error: 'Could not release that claim.' });
  }
});

/* ---------- static site ---------- */

app.use(express.static(__dirname, { extensions: ['html'] }));
app.get('*', (_req, res) => res.sendFile(path.join(__dirname, 'index.html')));

initDb()
  .catch((err) => console.error('[claims] Database setup failed', err))
  .finally(() => {
    app.listen(PORT, '0.0.0.0', () => console.log(`Pantheon listening on ${PORT}`));
  });
