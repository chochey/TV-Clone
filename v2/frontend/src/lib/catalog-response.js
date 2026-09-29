export function unpackCatalog(data) {
  if (Array.isArray(data)) return data;
  if (data?.format !== 'catalog-v1') return data?.items || [];
  return data.rows.map(([meta, ...values]) => {
    const item = { ...data.shared[meta] };
    data.fields.forEach((key, i) => { if (values[i] !== null) item[key] = values[i]; });
    return item;
  });
}
