// The SELECT * trap: a view's column list is fixed when the view is created or refreshed, so a column added to
// the table changes the report's shape at the next refresh, not at the migration.
import sql from 'mssql';

export async function viewColumns(pool: sql.ConnectionPool, view: string): Promise<string[]> {
  const r = await pool.request().input('v', sql.NVarChar(300), view)
    .query('SELECT name FROM sys.columns WHERE object_id = OBJECT_ID(@v) ORDER BY column_id');
  return r.recordset.map((x: { name: string }) => x.name);
}

export async function refreshView(pool: sql.ConnectionPool, view: string): Promise<void> {
  await pool.request().input('viewname', sql.NVarChar(300), view).execute('sys.sp_refreshview');
}

export const shapeChange = (before: string[], after: string[]): string[] => [
  ...after.filter((c) => !before.includes(c)).map((c) => `+ ${c}`),
  ...before.filter((c) => !after.includes(c)).map((c) => `- ${c}`),
];
