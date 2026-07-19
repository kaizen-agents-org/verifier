export function cacheKey(namespace, identifier) {
  return `${namespace}:${Buffer.from(identifier, "utf8").toString("hex")}`;
}
