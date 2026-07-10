export function paginate(items, pageIndex, pageSize) {
  const start = pageIndex * pageSize;
  const end = start + pageSize;
  return items.slice(start, end);
}

export function totalPages(itemCount, pageSize) {
  return Math.ceil(itemCount / pageSize);
}
