/**
 * Nudgy — app registry collector.
 *
 * Receives "Send my app categories" from Settings and writes each sender's registry to a
 * tab named after them. Sending again replaces that tab, so it always holds their latest
 * registry rather than every copy they ever sent.
 *
 * Setup (once):
 *   1. Create a Google Sheet. Extensions → Apps Script. Paste this file in, save.
 *   2. Deploy → New deployment → type "Web app".
 *        Execute as: Me.   Who has access: Anyone.
 *   3. Copy the web app URL (ends in /exec) into ENDPOINT in
 *      src-tauri/src/integrations/share.rs and rebuild.
 *   After editing this script, Deploy → Manage deployments → edit → New version, or the
 *   URL keeps running the old code.
 */

const MAX_APPS = 5000;
const HEADER = ["Received", "Version", "Match type", "Pattern", "Display name", "Category"];

function doPost(e) {
  try {
    const data = JSON.parse(e.postData.contents);
    const sender = tabName(String(data.sender || ""));
    const apps = Array.isArray(data.apps) ? data.apps.slice(0, MAX_APPS) : [];
    if (!sender) return reply({ ok: false, error: "no sender" });

    const lock = LockService.getScriptLock();
    lock.waitLock(20000);
    try {
      const book = SpreadsheetApp.getActiveSpreadsheet();
      const sheet = book.getSheetByName(sender) || book.insertSheet(sender);
      sheet.clearContents();

      const now = new Date();
      const version = String(data.version || "").slice(0, 20);
      const rows = apps.map((app) => [
        now,
        version,
        cell(app.matchType),
        cell(app.pattern),
        cell(app.displayName),
        cell(app.category),
      ]);
      sheet.getRange(1, 1, 1, HEADER.length).setValues([HEADER]).setFontWeight("bold");
      if (rows.length > 0) sheet.getRange(2, 1, rows.length, HEADER.length).setValues(rows);
      sheet.setFrozenRows(1);
    } finally {
      lock.releaseLock();
    }
    return reply({ ok: true, count: apps.length });
  } catch (error) {
    return reply({ ok: false, error: String(error) });
  }
}

/** A sheet tab cannot hold : \ / ? * [ ] and tops out at 100 characters. */
function tabName(raw) {
  return raw.replace(/[:\\\/?*\[\]]/g, " ").replace(/\s+/g, " ").trim().slice(0, 40);
}

/**
 * Plain text, never a formula: a pattern starting with = or + would otherwise run as one
 * in the maintainer's sheet.
 */
function cell(value) {
  const text = String(value == null ? "" : value).slice(0, 300);
  return /^[=+\-@]/.test(text) ? "'" + text : text;
}

function reply(body) {
  return ContentService.createTextOutput(JSON.stringify(body)).setMimeType(
    ContentService.MimeType.JSON,
  );
}
