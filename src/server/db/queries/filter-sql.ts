export interface UsageFilter {
  readonly from: string;
  readonly to: string;
  readonly models: readonly string[];
  readonly projects: readonly string[];
}

export interface SqlFragment {
  readonly sql: string;
  readonly params: Readonly<Record<string, string | number>>;
}

export function buildIn(column: string, prefix: string, values: readonly string[]): SqlFragment | null {
  if (values.length === 0) return null;
  const entries = values.map((value, index) => [`${prefix}${index}`, value] as const);
  return {
    sql: `${column} IN (${entries.map(([name]) => `@${name}`).join(', ')})`,
    params: Object.fromEntries(entries),
  };
}

export function buildWhere(filter: UsageFilter, alias?: string): SqlFragment {
  const col = (name: string): string => (alias ? `${alias}.${name}` : name);
  const parts = [
    { sql: `${col('local_day')} BETWEEN @from AND @to`, params: { from: filter.from, to: filter.to } },
    buildIn(col('model'), 'model', filter.models),
    buildIn(col('project_id'), 'project', filter.projects),
  ].filter((part): part is SqlFragment => part !== null);
  return {
    sql: parts.map((part) => part.sql).join(' AND '),
    params: Object.assign({}, ...parts.map((part) => part.params)) as Record<string, string | number>,
  };
}
