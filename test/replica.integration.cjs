// Manual integration check against an isolated development replica set.
const mongoose = require('mongoose');
const assert = require('node:assert/strict');

async function main() {
  const name = process.env.LETHICS_TEST_DB;
  if (!/^lethics_test_[a-f0-9]{32}$/.test(name || '')) throw new Error('Invalid isolated test database name');
  if (!process.env.MONGODB_URI) throw new Error('MONGODB_URI is required');
  const conn = await mongoose.createConnection(process.env.MONGODB_URI, { dbName: name, serverSelectionTimeoutMS: 5000 }).asPromise();
  try {
    const db = conn.db;
    const a = db.collection('transaction_a');
    const b = db.collection('transaction_b');
    if (process.argv[2] === 'setup') {
      const databases = await db.admin().listDatabases();
      assert(!databases.databases.some((item) => item.name === name), 'Test database already exists');
      const session = await conn.startSession();
      try {
        await session.withTransaction(async () => {
          await a.insertOne({ _id: 'commit', value: 1 }, { session });
          await b.insertOne({ _id: 'commit', value: 2 }, { session });
        });
        session.startTransaction();
        await a.insertOne({ _id: 'rollback' }, { session });
        await b.insertOne({ _id: 'rollback' }, { session });
        await session.abortTransaction();
      } finally { await session.endSession(); }
      assert.equal(await a.countDocuments({ _id: 'commit' }), 1);
      assert.equal(await b.countDocuments({ _id: 'commit' }), 1);
      assert.equal(await a.countDocuments({ _id: 'rollback' }), 0);
      assert.equal(await b.countDocuments({ _id: 'rollback' }), 0);
      console.log('Commit and rollback verified in two collections');
    } else if (process.argv[2] === 'verify-and-clean') {
      assert.equal(await a.countDocuments({ _id: 'commit', value: 1 }), 1);
      assert.equal(await b.countDocuments({ _id: 'commit', value: 2 }), 1);
      assert.equal(await a.countDocuments({ _id: 'rollback' }), 0);
      assert.equal(await b.countDocuments({ _id: 'rollback' }), 0);
      assert.equal(await a.countDocuments(), 1);
      assert.equal(await b.countDocuments(), 1);
      const collections = await db.listCollections({}, { nameOnly: true }).toArray();
      assert.deepEqual(collections.map((item) => item.name).sort(), ['transaction_a', 'transaction_b']);
      console.log('Committed data persisted after container restart');
      await db.dropDatabase();
      console.log('Isolated test database removed');
    } else throw new Error('Choose setup or verify-and-clean');
  } finally { await conn.close(); }
}
main().catch((error) => { console.error(error.message); process.exitCode = 1; });
