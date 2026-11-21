import { createHmac } from "node:crypto";
import { env } from "@/config/env";

const key = createHmac("sha256", env.RUNELAY_SECRET).update("runelay:sources:url-hash").digest();

export const hashUrl = (url: string) =>
  createHmac("sha256", key).update(url.trim().replace(/\/+$/, "").toLowerCase()).digest("hex");
