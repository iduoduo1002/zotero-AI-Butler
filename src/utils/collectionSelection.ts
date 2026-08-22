export function getSelectedCollection(
  zoteroPane: any = Zotero.getActiveZoteroPane?.(),
): Zotero.Collection | null {
  if (!zoteroPane) return null;

  if (typeof zoteroPane.getSelectedCollections === "function") {
    const collections = zoteroPane.getSelectedCollections();
    const collection = Array.isArray(collections)
      ? collections[0]
      : collections;

    if (typeof collection === "number") {
      return (
        (Zotero.Collections.get(collection) as Zotero.Collection | false) ||
        null
      );
    }

    return (collection as Zotero.Collection | null) || null;
  }

  if (typeof zoteroPane.getSelectedCollection === "function") {
    return (
      (zoteroPane.getSelectedCollection() as Zotero.Collection | false | null) ||
      null
    );
  }

  return null;
}
