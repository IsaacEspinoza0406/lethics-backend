// Base en memoria con el subconjunto del driver de MongoDB que usa la sincronización. Solo para pruebas.
import { normalize } from './sync.mjs';

let counter = 0;
// Copia profunda que conserva los identificadores (los structuredClone perderían sus métodos).
const clone = (v) => {
  if (v === null || typeof v !== 'object' || typeof v.toHexString === 'function') return v;
  if (v instanceof Date) return new Date(v);
  if (Array.isArray(v)) return v.map(clone);
  return Object.fromEntries(Object.entries(v).map(([k, x]) => [k, clone(x)]));
};
const newId = () => {
  const hex = (++counter).toString(16).padStart(24, '0');
  return { toHexString: () => hex };
};
const canon = (v) => JSON.stringify(normalize(v));

export function createMemoryDb() {
  const collections = new Map();
  const created = new Set(); // como en MongoDB, una colección existe solo después de escribir en ella
  const get = (name) => {
    if (!collections.has(name)) collections.set(name, []);
    return collections.get(name);
  };
  // Soporta igualdad y `{ $in: [...] }`, que es lo que usa la sincronización.
  const matchesField = (value, cond) => {
    if (cond !== null && typeof cond === 'object' && !Array.isArray(cond) && '$in' in cond) return cond.$in.some((c) => canon(value) === canon(c));
    return canon(value) === canon(cond);
  };
  const matches = (doc, filter) => Object.keys(filter).every((k) => matchesField(doc[k], filter[k]));
  return {
    writes: 0,
    bulkCalls: 0,
    databaseName: 'memoria',
    collection(name) {
      const docs = get(name);
      const db = this;
      const insert = (doc) => {
        db.writes++;
        created.add(name);
        const _id = newId();
        docs.push({ ...clone(doc), _id });
        return _id;
      };
      const update = (filter, change) => {
        db.writes++;
        const d = docs.find((x) => matches(x, filter));
        if (change.$set) Object.assign(d, clone(change.$set));
        for (const k of Object.keys(change.$unset ?? {})) delete d[k];
      };
      return {
        find: (filter) => ({ toArray: async () => docs.filter((d) => matches(d, filter)).map((d) => clone(d)) }),
        async insertOne(doc) { return { insertedId: insert(doc) }; },
        async updateOne(filter, change) { update(filter, change); return { matchedCount: 1 }; },
        async bulkWrite(ops) {
          db.bulkCalls++;
          const insertedIds = {};
          ops.forEach((op, i) => {
            if (op.insertOne) insertedIds[i] = insert(op.insertOne.document);
            else if (op.updateOne) update(op.updateOne.filter, op.updateOne.update);
          });
          return { insertedIds };
        },
        countDocuments: async () => docs.length,
        createIndex: async () => { created.add(name); return 'ok'; },
      };
    },
    listCollections: () => ({ toArray: async () => [...created].map((name) => ({ name })) }),
    dump: (name) => get(name).map((d) => clone(d)),
  };
}
