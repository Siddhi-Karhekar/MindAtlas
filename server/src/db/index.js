import { createMemoryDb } from "./memoryStore.js";
import { createMongoDb } from "./mongoStore.js";

let dbInstance = null;

export async function connectDB() {
  const uri = process.env.MONGODB_URI?.trim();

  if (uri) {
    console.log("[db] connecting to configured MONGODB_URI");
    dbInstance = await createMongoDb(uri);
    console.log("[db] connected to MongoDB");
  } else {
    console.log(
      "[db] no MONGODB_URI set - using an in-memory dev database " +
        "(data resets every time the server restarts; set MONGODB_URI " +
        "in server/.env to switch to a real MongoDB Atlas cluster)"
    );
    dbInstance = createMemoryDb();
  }
}

export function getCollection(name) {
  if (!dbInstance) throw new Error("Database not connected yet - call connectDB() first");
  return dbInstance.collection(name);
}

export async function disconnectDB() {
  if (dbInstance) await dbInstance.close();
  dbInstance = null;
}
