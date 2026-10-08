// Microsoft Graph calls against the same OneDrive folder and file layout the web app uses:
//   <QuoteNo>.json   one quote          _index.json   Saved Quotes list
//   _settings.json   Rate Master        _autosave_working.json   app crash recovery (never touched)
export const INDEX_FILE = '_index.json';
export const SETTINGS_FILE = '_settings.json';
const MACHINE_FILES = [SETTINGS_FILE, INDEX_FILE, '_autosave_working.json'];

export class GraphError extends Error {
  constructor(message, status) { super(message); this.status = status; }
}

export class OneDrive {
  constructor({ token, folder, graphBase = 'https://graph.microsoft.com' }) {
    this.token = token;
    this.folder = folder;
    this.base = `${graphBase.replace(/\/$/, '')}/v1.0/me/drive/root:/${encodeURIComponent(folder)}`;
  }

  async #fetch(url, init = {}) {
    const res = await fetch(url, {
      ...init,
      headers: { Authorization: `Bearer ${this.token}`, ...(init.headers || {}) },
    });
    return res;
  }

  fileUrl(name) { return `${this.base}/${encodeURIComponent(name)}`; }

  /** A JSON file from the folder, or null when it doesn't exist. */
  async readJson(name) {
    const res = await this.#fetch(`${this.fileUrl(name)}:/content`);
    if (res.status === 404) return null;
    if (!res.ok) throw new GraphError(`Could not read ${name} from OneDrive (status ${res.status}).`, res.status);
    return res.json();
  }

  /** A JSON file plus its eTag (OneDrive's version stamp), or { data: null } when absent. */
  async readJsonVersioned(name) {
    const meta = await this.#fetch(`${this.fileUrl(name)}?$select=eTag,@microsoft.graph.downloadUrl`);
    if (meta.status === 404) return { data: null, etag: null };
    if (!meta.ok) throw new GraphError(`Could not read ${name} from OneDrive (status ${meta.status}).`, meta.status);
    const item = await meta.json();
    const res = await fetch(item['@microsoft.graph.downloadUrl']); // pre-authenticated, short-lived
    if (!res.ok) throw new GraphError(`Could not download ${name} from OneDrive (status ${res.status}).`, res.status);
    return { data: await res.json(), etag: item.eTag };
  }

  /**
   * Upload a JSON file. With `mustNotExist`, OneDrive itself refuses to replace an existing
   * file (409), so two quotes saved at the same moment can't take the same number. With
   * `ifMatch` (an eTag), OneDrive refuses if the file changed since it was read (412).
   */
  async writeJson(name, data, { mustNotExist = false, ifMatch } = {}) {
    const body = JSON.stringify(data, null, 2);
    if (body.length > 4 * 1024 * 1024) throw new GraphError(`${name} is over OneDrive's 4 MB single-file limit.`, 413);
    const conflict = mustNotExist ? '?@microsoft.graph.conflictBehavior=fail' : '';
    const res = await this.#fetch(`${this.fileUrl(name)}:/content${conflict}`, {
      method: 'PUT', headers: { 'Content-Type': 'application/json', ...(ifMatch ? { 'If-Match': ifMatch } : {}) }, body,
    });
    if (res.status === 409 && mustNotExist) throw new GraphError(`${name} already exists in OneDrive.`, 409);
    if (res.status === 412) throw new GraphError(`${name} was changed in OneDrive while this update was being made.`, 412);
    if (!res.ok) throw new GraphError(`Could not save ${name} to OneDrive (status ${res.status}).`, res.status);
    return res.json();
  }

  /** Every saved quote file name in the folder (machine files excluded), all pages. */
  async listQuoteFiles() {
    const names = [];
    let url = `${this.base}:/children?$select=name,lastModifiedDateTime&$top=200`;
    while (url) {
      const res = await this.#fetch(url);
      if (res.status === 404) return names; // folder not created yet
      if (!res.ok) throw new GraphError(`Could not list the OneDrive folder (status ${res.status}).`, res.status);
      const json = await res.json();
      for (const f of json.value || []) {
        if (f.name.endsWith('.json') && !MACHINE_FILES.includes(f.name)) {
          names.push({ name: f.name, lastModified: f.lastModifiedDateTime });
        }
      }
      url = json['@odata.nextLink'] || null;
    }
    return names;
  }

  async readIndex() {
    const json = await this.readJson(INDEX_FILE);
    return json && json.quotes ? json.quotes : {};
  }

  /** Read-modify-write of the Saved Quotes index, as the app does. Best effort. */
  async updateIndex(mutate) {
    const quotes = await this.readIndex();
    mutate(quotes);
    await this.writeJson(INDEX_FILE, { version: 1, updatedAt: new Date().toISOString(), quotes });
  }
}
