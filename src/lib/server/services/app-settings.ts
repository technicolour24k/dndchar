import { query } from '$lib/server/db';

export async function isRegistrationEnabled(): Promise<boolean> {
  const result = await query<{ value_json: boolean }>(
    "SELECT value_json FROM app_settings WHERE key = 'registration_enabled'"
  );
  return result.rows[0]?.value_json === true;
}

export async function setRegistrationEnabled(enabled: boolean, userId: string): Promise<void> {
  await query(
    `
      INSERT INTO app_settings (key, value_json, updated_at, updated_by_user_id)
      VALUES ('registration_enabled', $1::jsonb, now(), $2)
      ON CONFLICT (key) DO UPDATE
      SET value_json = EXCLUDED.value_json,
          updated_at = now(),
          updated_by_user_id = EXCLUDED.updated_by_user_id
    `,
    [JSON.stringify(enabled), userId]
  );
}
