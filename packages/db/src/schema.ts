import { sqliteTable, text, uniqueIndex } from "drizzle-orm/sqlite-core";

export const rooms = sqliteTable(
  "rooms",
  {
    id: text("id").primaryKey(),
    roomId: text("room_id").notNull(),
    userId: text("user_id").notNull(),
  },
  (rooms) => ({
    roomIdx: uniqueIndex("roomIdx").on(rooms.roomId),
  })
);
