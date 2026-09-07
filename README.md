# pantheon-of-the-nile

Mood board of 46 Egyptian gods and goddesses for Craig's 40th. Each card has a
claim button. Guests enter their name; **two people can share a god**, and once
the second place goes, the card flips to the struck-through Taken treatment.
Claims live in Postgres so everyone sees the same list.

## Running locally

```bash
npm install
npm start          # http://localhost:3000
```

Without `DATABASE_URL` the server keeps claims in memory, so the site still runs
locally, but claims vanish on restart.

## Railway setup

1. In the Railway project, add a **Postgres** database (New → Database → Postgres).
2. On the site service, go to **Variables** → **Add Variable Reference** and pick
   `DATABASE_URL` from the Postgres service. That's the only variable the app needs.
3. Optionally add `ADMIN_TOKEN` (any long random string) to enable releasing claims.
4. Deploy. The table is created — and migrated, if it already exists — on boot.

Railway sets `PORT` itself; the server reads it.

## Card states

| Claims | Card looks like |
| --- | --- |
| 0 | Claim button, no note |
| 1 | Claim button stays, "Claimed by Nadia · 1 place left" |
| 2 | Struck-through heading, Taken stamp, "Claimed by Nadia and Craig" |

To change how many people can share a god, edit `MAX_CLAIMS` in `server.js`. The
page reads the number back from the API, so nothing else needs touching.

## API

| Method | Path | Notes |
| --- | --- | --- |
| `GET` | `/api/claims` | All claims, plus the places-per-god number |
| `POST` | `/api/claims` | `{ god_slug, god_name, claimed_by, mushrooms }` — `mushrooms` is the Yes/No answer (`true`/`false`, required); 409 when full or when that name already holds the god |
| `DELETE` | `/api/claims/:slug` | Release claims, needs `x-admin-token` header |
| `GET` | `/api/health` | Reports whether Postgres is reachable |

Release one person, or everyone on a god:

```bash
curl -X DELETE "https://YOUR-DOMAIN/api/claims/hathor?name=Marta" -H "x-admin-token: YOUR_TOKEN"
curl -X DELETE "https://YOUR-DOMAIN/api/claims/hathor"            -H "x-admin-token: YOUR_TOKEN"
```

## Table

```sql
CREATE TABLE claims (
  id         SERIAL PRIMARY KEY,
  god_slug   TEXT NOT NULL,
  god_name   TEXT NOT NULL,
  claimed_by TEXT NOT NULL,
  slot       SMALLINT,          -- 1 or 2
  mushrooms  BOOLEAN,           -- "Do you want to partake in the magic mushrooms?"
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE UNIQUE INDEX claims_god_slug_slot_idx   ON claims (god_slug, slot);
CREATE UNIQUE INDEX claims_god_slug_person_idx ON claims (god_slug, lower(claimed_by));
```

`slot` is what caps a god at two people: a claim takes the lowest free slot, and
the unique index rejects anyone racing for the same one. The second index stops
one person taking both places by double-clicking.

If the database was created by the earlier one-claim-per-god version, boot
migrates it: existing rows become slot 1, the old `UNIQUE (god_slug)` constraint
is dropped, and the new indexes are added. Nothing is deleted.

Slugs come from the card headings (`Ma'at` → `maat`, `The Four Sons of Horus` →
`the-four-sons-of-horus`), so renaming a god in `index.html` orphans its claims.

Anubis and Bastet are marked Taken directly in the HTML and stay locked
regardless of the database — no names attached, no claim button. To put either
back in the pool, remove `taken` from that card's class and delete its
`<span class="taken-stamp">Taken</span>` line.
