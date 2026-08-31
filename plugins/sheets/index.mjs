// @ts-check
// Google Sheets sync — mirror the application tracker into the user's own sheet.
//
// data/applications.md stays the source of truth; the sheet is an additive
// mirror. One command drives both sync modes:
//
//   node plugins.mjs run sheets export [--dry-run]
//
// Scope comes from the plugin's own cursor (data/sheets-sync-state.json), not
// from a flag — the export hook receives no arguments by design. No state file
// means a full sync, which makes the first run self-bootstrapping.

export default {
  /**
   * export: reconcile the user's Google Sheet with the tracker snapshot.
   * @param {{ applications: Array<Record<string,string>> }} snapshot
   * @param {any} ctx
   * @returns {Promise<{pushed: number}>}
   */
  async export(snapshot, ctx) {
    if (String(ctx?.env?.GOOGLE_SYNC ?? 'true').toLowerCase() === 'false') {
      ctx?.log?.('GOOGLE_SYNC=false — sync disabled, nothing done.');
      return { pushed: 0 };
    }
    const rows = Array.isArray(snapshot?.applications) ? snapshot.applications : [];
    ctx?.log?.(`tracker snapshot: ${rows.length} row(s) — reconciler not implemented yet.`);
    return { pushed: 0 };
  },
};
