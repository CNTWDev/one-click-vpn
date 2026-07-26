import { currentPortalUser, currentUser } from "./auth";
import { apiUser } from "./device-auth";
import type { DbUser } from "./db";

export async function requestUser(request: Request): Promise<DbUser | null> {
  const user = (await apiUser(request)) || await currentPortalUser() || await currentUser();
  return user?.status === "active" ? user : null;
}

export async function requestAdmin(request: Request): Promise<DbUser | null> {
  const user = (await apiUser(request)) || await currentUser();
  return user?.status === "active" && ["owner", "admin"].includes(user.role) ? user : null;
}
