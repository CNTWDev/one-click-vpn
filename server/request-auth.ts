import { currentUser } from "./auth";
import { apiUser } from "./device-auth";
import type { DbUser } from "./db";

export async function requestUser(request: Request): Promise<DbUser | null> {
  return (await apiUser(request)) || await currentUser();
}
