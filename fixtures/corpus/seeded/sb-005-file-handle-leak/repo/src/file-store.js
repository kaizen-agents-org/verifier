export async function writeRecord(openFile, path, contents) {
  const handle = await openFile(path, "w");
  try {
    await handle.writeFile(contents);
  } finally {
    await handle.close();
  }
}
