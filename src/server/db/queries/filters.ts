import type { ClientOption, FiltersResponse } from '../../../shared/api.js';
import { CLIENT_META, CLIENTS, modelColor, modelLabel, projectLabel } from '../../../shared/models.js';
import type { Db } from '../connection.js';
import type { Repos } from '../repos.js';

function queryClients(db: Db): ClientOption[] {
  const present = new Set((db.prepare('SELECT DISTINCT client FROM usage').all() as { client: string }[]).map((row) => row.client));
  return CLIENTS.filter((client) => present.has(client)).map((id) => ({ id, ...CLIENT_META[id] }));
}

export function queryFilters(db: Db, repos: Pick<Repos, 'prices' | 'usage'>): FiltersResponse {
  const models = repos.prices
    .allModels()
    .map((m) => ({ id: m.model, label: modelLabel(m.model), color: modelColor(m.model), priced: m.priced }))
    .sort((a, b) => a.label.localeCompare(b.label) || a.id.localeCompare(b.id));
  const projects = (
    db
      .prepare(
        `SELECT project_id, MAX(project_path) AS project_path FROM sessions
         WHERE project_id IS NOT NULL GROUP BY project_id ORDER BY project_path`,
      )
      .all() as { project_id: string; project_path: string }[]
  ).map((row) => ({ id: row.project_id, path: row.project_path, label: projectLabel(row.project_path) }));
  return { models, projects, clients: queryClients(db), bounds: repos.usage.dayBounds() };
}
