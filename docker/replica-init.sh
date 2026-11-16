#!/bin/bash
set -eu
for attempt in $(seq 1 60); do
  if mongosh --quiet --host localhost --port 27018 -u "$MONGO_INITDB_ROOT_USERNAME" -p "$MONGO_INITDB_ROOT_PASSWORD" --authenticationDatabase admin --eval 'db.adminCommand({ping:1}).ok' >/dev/null 2>&1; then
    break
  fi
  if [ "$attempt" -eq 60 ]; then
    echo 'MongoDB did not become reachable' >&2
    exit 1
  fi
  sleep 2
done
mongosh --quiet --host localhost --port 27018 -u "$MONGO_INITDB_ROOT_USERNAME" -p "$MONGO_INITDB_ROOT_PASSWORD" --authenticationDatabase admin --eval '
  try {
    rs.status();
    print("Replica set already initialized");
  } catch (error) {
    if (error.code !== 94) throw error;
    const result = rs.initiate({_id: "lethics-rs", members: [{_id: 0, host: "localhost:27018"}]});
    if (!result.ok) throw new Error("Replica set initialization failed");
    print("Replica set initialized");
  }
'
