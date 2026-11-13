import type { Adapter, AdapterPayload } from "oidc-provider";
import type { Db } from "./db.ts";

type Row = { payload: AdapterPayload; consumed: number | null };

// consumed is returned as epoch seconds (float8 so both pg and PGlite hand back a JS number).
const SELECT_PAYLOAD = `SELECT payload,
  floor(extract(epoch FROM consumed_at))::float8 AS consumed
  FROM oidc_models`;
const NOT_EXPIRED = "(expires_at IS NULL OR expires_at > now())";

export function createAdapterFactory(db: Db): (modelName: string) => Adapter {
  return (model) => {
    async function findOne(column: "id" | "uid" | "user_code", value: string) {
      const { rows } = await db.query<Row>(
        `${SELECT_PAYLOAD} WHERE model = $1 AND ${column} = $2 AND ${NOT_EXPIRED}`,
        [model, value],
      );
      const row = rows[0];
      if (!row) return undefined;
      return row.consumed === null ? row.payload : { ...row.payload, consumed: row.consumed };
    }

    return {
      async upsert(id, payload, expiresIn) {
        await db.query(
          `INSERT INTO oidc_models
             (model, id, payload, grant_id, user_code, uid, expires_at)
           VALUES ($1, $2, $3::jsonb, $4, $5, $6, now() + ($7::float8 * interval '1 second'))
           ON CONFLICT (model, id) DO UPDATE SET
             payload = EXCLUDED.payload, grant_id = EXCLUDED.grant_id,
             user_code = EXCLUDED.user_code, uid = EXCLUDED.uid,
             expires_at = EXCLUDED.expires_at`,
          [
            model,
            id,
            JSON.stringify(payload),
            payload.grantId ?? null,
            payload.userCode ?? null,
            payload.uid ?? null,
            expiresIn ?? null,
          ],
        );
      },
      find: (id) => findOne("id", id),
      findByUid: (uid) => findOne("uid", uid),
      findByUserCode: (userCode) => findOne("user_code", userCode),
      async consume(id) {
        await db.query("UPDATE oidc_models SET consumed_at = now() WHERE model = $1 AND id = $2", [
          model,
          id,
        ]);
      },
      async destroy(id) {
        await db.query("DELETE FROM oidc_models WHERE model = $1 AND id = $2", [model, id]);
      },
      async revokeByGrantId(grantId) {
        await db.query("DELETE FROM oidc_models WHERE grant_id = $1", [grantId]);
      },
    };
  };
}
