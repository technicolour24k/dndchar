import { query } from '$lib/server/db';

const hexColorPattern = /^#[0-9a-f]{6}$/i;

function normalizeColor(value: FormDataEntryValue | null, fallback: string): string {
  const color = String(value || '').trim();
  return hexColorPattern.test(color) ? color : fallback;
}

export async function updateProfile(userId: string, form: FormData): Promise<void> {
  const displayName = String(form.get('displayName') || '').trim();
  const backgroundColor = normalizeColor(form.get('backgroundColor'), '#14161b');
  const panelColor = normalizeColor(form.get('panelColor'), '#292929');
  const textColor = normalizeColor(form.get('textColor'), '#f4f4f4');

  await query(
    `
      UPDATE users
      SET display_name = $1,
          theme_background_color = $2,
          theme_panel_color = $3,
          theme_text_color = $4,
          updated_at = now()
      WHERE id = $5
    `,
    [displayName || 'Player', backgroundColor, panelColor, textColor, userId]
  );
}
