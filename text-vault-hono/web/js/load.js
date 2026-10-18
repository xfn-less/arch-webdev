import {decryptObject} from "./crypto.js";
import {validateObject} from "./model.js";

// Snapshot loading follows the same isolation rule as incremental sync: one
// damaged envelope must not make every healthy entry inaccessible.
export async function decryptSnapshot(key, snapshot, {decrypt = decryptObject, validate = validateObject} = {}) {
  const encryptedObjects = Object.values(snapshot.objects ?? {});
  const settled = await Promise.allSettled(encryptedObjects.map(async encrypted => {
    const metadata = {id: encrypted.id, kind: encrypted.kind, revision: encrypted.revision};
    return validate(await decrypt(key, metadata, encrypted.envelope));
  }));
  const objects = [];
  const failures = [];
  settled.forEach((item, index) => {
    if (item.status === "fulfilled") objects.push(item.value);
    else failures.push({id: encryptedObjects[index].id, error: item.reason});
  });
  return {objects, failures};
}
