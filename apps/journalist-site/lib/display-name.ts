import { auth, getMongoDatabase } from "@/auth";
import type { Account, Principal } from "@/pipeline/accounts/identity";

import { readableName } from "./readable-name";

export { readableName };

export async function principalDisplayName(principal: Principal) {
  const session = await auth().catch(() => null);
  let name = session?.user?.email === principal.email ? session?.user?.name?.trim() ?? "" : "";
  if (!name) {
    try {
      const account = await (await getMongoDatabase()).collection<Account>("journalist_admins")
        .findOne({ principalId: principal.id }, { projection: { username: 1 } });
      name = account?.username?.trim() ?? "";
    } catch { name = ""; }
  }
  return readableName(name, principal.email);
}
