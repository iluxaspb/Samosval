# Firestore multiplayer regression tests

These tests launch a local Firestore emulator using a demo project. They do not contact the live database.

Requires Node.js 18+ and Java 17+. From this directory:

```sh
npm install
mkdir -p .cache
curl -L --fail https://storage.googleapis.com/firebase-preview-drop/emulator/cloud-firestore-emulator-v1.19.8.jar -o .cache/firestore-emulator.jar
npm test
```

Alternatively set `FIRESTORE_EMULATOR_JAR` to an existing emulator JAR.

Coverage: concurrent loading and arrival; five competing operators plus a viewer; TTN/loading races; atomic own-action undo; delayed requests after undo; offline/unavailable errors; denied permissions; stale responses; legacy trips; registration and approval. The suite also compiles the full Rules file in Firestore.

The first load accepted by Firestore wins. Client click times are not used to choose the winner because device clocks and network delays differ.
